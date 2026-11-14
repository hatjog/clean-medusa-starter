/**
 * RLS Pool Hook — Story 10-3, hardened in 10-9
 *
 * Monkey-patches Knex's acquireConnection/releaseConnection to inject
 * SET ROLE medusa_store + SET app.gp_market_id on every connection
 * acquired from the pool within a store-request AsyncLocalStorage context.
 *
 * Why: MikroORM forks its EntityManager per query and acquires connections
 * from the Knex pool independently. A Knex transaction with SET LOCAL
 * doesn't propagate to MikroORM queries. This hook ensures every pool
 * connection used during a store request has the correct RLS context.
 *
 * Lifecycle:
 *   acquire → SET ROLE + SET var (if ALS has market context) → query → release → RESET
 *   If RESET fails on release, the connection is destroyed (not returned dirty).
 */

import { AsyncLocalStorage } from "node:async_hooks";

import { marketContextStorage } from "./market-context";

const SAFE_ID_RE = /^[a-zA-Z0-9_-]+$/;
const RLS_MARKER = Symbol("__gp_rls_active");
export const GP_MARKET_SESSION_VAR = "app.gp_market_id";
export const GP_INSTANCE_SESSION_VAR = "app.gp_instance_id";

export type HookLogger = {
  warn?: (...args: unknown[]) => void;
  info?: (...args: unknown[]) => void;
  error?: (...args: unknown[]) => void;
};

export class RlsMarketContextRequiredError extends Error {
  readonly error_code = "GP_RLS_MARKET_CONTEXT_REQUIRED";

  constructor(
    reason:
      | "missing_market_context"
      | "invalid_market_id"
      | "missing_instance_id"
      | "invalid_instance_id"
  ) {
    super(`RLS connection acquisition denied: ${reason}`);
    this.name = "RlsMarketContextRequiredError";
  }
}

type QueryableConnection = {
  query: (sql: string, params?: unknown[]) => Promise<unknown>;
  end?: () => Promise<unknown> | unknown;
  [RLS_MARKER]?: boolean;
};

type PgClientLike = {
  acquireConnection: () => Promise<QueryableConnection>;
  releaseConnection: (connection: QueryableConnection) => Promise<void>;
  destroyRawConnection?: (connection: QueryableConnection) => Promise<unknown> | unknown;
};

type PgConnectionLike = {
  client?: PgClientLike | null;
};

let installedClients = new WeakSet<object>();

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function destroyConnection(
  client: PgClientLike,
  connection: QueryableConnection,
  logger: HookLogger | undefined,
  reason: string
): Promise<void> {
  try {
    await client.destroyRawConnection?.(connection);
    await connection.end?.();
  } catch (error) {
    logger?.error?.(reason, { error: describeError(error) });
  }
}

export function installRlsPoolHook(
  pgConnection: PgConnectionLike,
  logger?: HookLogger
): void {
  const client = pgConnection?.client;
  if (!client || installedClients.has(client)) {
    return;
  }

  installedClients.add(client);
  const origAcquire = client.acquireConnection.bind(client);
  const origRelease = client.releaseConnection.bind(client);

  client.acquireConnection = async function (): Promise<QueryableConnection> {
    const connection = await origAcquire();
    const ctx = marketContextStorage.getStore();

    if (!ctx?.market_id && consumeSellerMarketLookupGrant()) {
      // Named, one-shot exception (SELLER_MARKET_LOOKUP_EXCEPTION): exactly one
      // connection for the fixed `seller` read by id in
      // `lookupSellerMarketIdWithoutMarketContext`. No SET ROLE / market var —
      // the connection carries no market and is released untouched.
      logger?.info?.("RLS pool hook named exception", {
        exception: SELLER_MARKET_LOOKUP_EXCEPTION,
      });
      return connection;
    }

    if (!ctx?.market_id) {
      logger?.error?.("RLS pool hook acquire denied", {
        error_code: "GP_RLS_MARKET_CONTEXT_REQUIRED",
        reason: "missing_market_context",
      });
      await destroyConnection(
        client,
        connection,
        logger,
        "RLS pool hook missing-context destroy failed"
      );
      throw new RlsMarketContextRequiredError("missing_market_context");
    }

    if (!SAFE_ID_RE.test(ctx.market_id)) {
      logger?.error?.("RLS pool hook acquire denied", {
        error_code: "GP_RLS_MARKET_CONTEXT_REQUIRED",
        reason: "invalid_market_id",
        market_id: ctx.market_id,
      });
      await destroyConnection(
        client,
        connection,
        logger,
        "RLS pool hook invalid-context destroy failed"
      );
      throw new RlsMarketContextRequiredError("invalid_market_id");
    }

    if (!ctx.instance_id) {
      logger?.error?.("RLS pool hook acquire denied", {
        error_code: "GP_RLS_MARKET_CONTEXT_REQUIRED",
        reason: "missing_instance_id",
        market_id: ctx.market_id,
      });
      await destroyConnection(
        client,
        connection,
        logger,
        "RLS pool hook missing-instance destroy failed"
      );
      throw new RlsMarketContextRequiredError("missing_instance_id");
    }

    if (!SAFE_ID_RE.test(ctx.instance_id)) {
      logger?.error?.("RLS pool hook acquire denied", {
        error_code: "GP_RLS_MARKET_CONTEXT_REQUIRED",
        reason: "invalid_instance_id",
        instance_id: ctx.instance_id,
      });
      await destroyConnection(
        client,
        connection,
        logger,
        "RLS pool hook invalid-instance destroy failed"
      );
      throw new RlsMarketContextRequiredError("invalid_instance_id");
    }

    try {
      await connection.query("SET ROLE medusa_store");
      await connection.query(
        `SELECT set_config('${GP_MARKET_SESSION_VAR}', $1, false)`,
        [ctx.market_id]
      );
      await connection.query(
        `SELECT set_config('${GP_INSTANCE_SESSION_VAR}', $1, false)`,
        [ctx.instance_id]
      );
      connection[RLS_MARKER] = true;
    } catch (error) {
      logger?.error?.("RLS pool hook acquire failed", {
        market_id: ctx.market_id,
        error: describeError(error),
      });

      try {
        await connection.query(`RESET ${GP_MARKET_SESSION_VAR}`);
      } catch {
        // ignore best-effort cleanup and destroy the connection below
      }

      try {
        await connection.query(`RESET ${GP_INSTANCE_SESSION_VAR}`);
      } catch {
        // ignore best-effort cleanup and destroy the connection below
      }

      try {
        await connection.query("RESET ROLE");
      } catch {
        // ignore best-effort cleanup and destroy the connection below
      }

      await destroyConnection(
        client,
        connection,
        logger,
        "RLS pool hook acquire destroy failed"
      );
      throw error;
    }

    return connection;
  };

  client.releaseConnection = async function (
    connection: QueryableConnection
  ): Promise<void> {
    if (connection[RLS_MARKER]) {
      try {
        await connection.query(`RESET ${GP_MARKET_SESSION_VAR}`);
        await connection.query(`RESET ${GP_INSTANCE_SESSION_VAR}`);
        await connection.query("RESET ROLE");
      } catch (error) {
        logger?.error?.("RLS pool hook release cleanup failed", {
          error: describeError(error),
        });
        // Connection is dirty — destroy instead of returning to pool
        await destroyConnection(
          client,
          connection,
          logger,
          "RLS pool hook release destroy failed"
        );
        delete connection[RLS_MARKER];
        return;
      }
      delete connection[RLS_MARKER];
    }
    return origRelease(connection);
  };
}

/** Reset installed flag — for testing only */
export function _resetRlsPoolHook(): void {
  installedClients = new WeakSet<object>();
}

/**
 * Named exception to the 11.1 boundary ("no connection without market context"),
 * Story 5.4 fix (DW-15-300). The market of an authenticated `/vendor/*` seller is
 * stored on the seller row itself, so it cannot be read INSIDE a market context
 * that does not exist yet. The exception is deliberately narrow:
 *   - it is NOT a general "run without context" scope — the only entry point is
 *     `lookupSellerMarketIdWithoutMarketContext`, which runs ONE fixed query
 *     (`seller.metadata->'gp'->>'market_id'` WHERE `id = $sellerId`);
 *   - the grant is one-shot: it admits a single connection acquisition and is
 *     consumed by it; any further acquisition in the same async scope is denied
 *     as before (`missing_market_context`);
 *   - inside an existing market context it is never consulted.
 */
export const SELLER_MARKET_LOOKUP_EXCEPTION = "seller_market_lookup";

type SellerMarketLookupGrant = { remaining: number };
const sellerMarketLookupStorage = new AsyncLocalStorage<SellerMarketLookupGrant>();

function consumeSellerMarketLookupGrant(): boolean {
  const grant = sellerMarketLookupStorage.getStore();
  if (!grant || grant.remaining <= 0) return false;
  grant.remaining -= 1;
  return true;
}

type SellerLookupKnex = {
  (table: string): {
    select: (...args: unknown[]) => {
      where: (column: string, value: string) => {
        first: () => Promise<{ market_id?: string | null } | undefined>;
      };
    };
  };
  raw: (sql: string) => unknown;
};

export async function lookupSellerMarketIdWithoutMarketContext(
  db: SellerLookupKnex,
  sellerId: string
): Promise<string | null> {
  const grant: SellerMarketLookupGrant = { remaining: 1 };
  // `async` + `await` INSIDE run(): a Knex builder executes on `.then`, so it
  // must be awaited within the grant scope, not after it.
  const row = await sellerMarketLookupStorage.run(grant, async () =>
    await db("seller")
      .select(db.raw("metadata->'gp'->>'market_id' as market_id"))
      .where("id", sellerId)
      .first()
  );
  grant.remaining = 0;
  return row?.market_id ?? null;
}
