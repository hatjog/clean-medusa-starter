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
      | "seller_lookup_query_not_allowed"
  ) {
    super(`RLS connection acquisition denied: ${reason}`);
    this.name = "RlsMarketContextRequiredError";
  }
}

type QueryableConnection = {
  query: (sql: string, params?: unknown[]) => Promise<unknown>;
  end?: () => Promise<unknown> | unknown;
  [RLS_MARKER]?: boolean;
  [LOOKUP_GUARD_MARKER]?: LookupGuardState;
};

const LOOKUP_GUARD_MARKER = Symbol("__gp_seller_lookup_guard");

type LookupGuardState = {
  originalQuery: QueryableConnection["query"];
  /** `query` was an own property (not the driver prototype's method). */
  ownQuery: boolean;
  denied: boolean;
  used: boolean;
};

/**
 * Restrict a named-exception connection to ONE query with exactly the fixed
 * text. Accepts both call shapes the drivers use: `query(text, params)` and
 * knex's `query({ text, values }, callback)`.
 */
function installFixedQueryGuard(
  connection: QueryableConnection,
  allowedSql: string | null
): void {
  const state: LookupGuardState = {
    originalQuery: connection.query,
    ownQuery: Object.prototype.hasOwnProperty.call(connection, "query"),
    denied: false,
    used: false,
  };
  connection[LOOKUP_GUARD_MARKER] = state;
  connection.query = function guardedQuery(
    this: unknown,
    ...args: unknown[]
  ): Promise<unknown> {
    const first = args[0] as { text?: unknown } | string | undefined;
    const text = typeof first === "string" ? first : first?.text;
    const callback = args.find((a) => typeof a === "function") as
      | ((err: unknown) => void)
      | undefined;
    if (state.used || allowedSql === null || text !== allowedSql) {
      state.denied = true;
      const error = new RlsMarketContextRequiredError(
        "seller_lookup_query_not_allowed"
      );
      if (callback) {
        callback(error);
        return undefined as unknown as Promise<unknown>;
      }
      return Promise.reject(error);
    }
    state.used = true;
    return (state.originalQuery as (...a: unknown[]) => Promise<unknown>).apply(
      connection,
      args
    );
  } as QueryableConnection["query"];
}

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

/**
 * Znacznik Knexa (`connectionIsDisposed`): pula odrzuca taki zasob przy walidacji
 * i niszczy go wlasnym API (`destroy`), zwalniajac slot.
 */
const KNEX_DISPOSED_MARKER = "__knex__disposed";

/**
 * Story 8.7 (DW-15-370): zniszczenie polaczenia MUSI oddac slot puli. Samo
 * `destroyRawConnection` + `end` zamykalo gniazdo, ale zasob zostawal w puli
 * tarn jako "w uzyciu" - n odmow hooka wyczerpywalo pule `max = n` (zmierzone:
 * `KnexTimeoutError` przy odmowie n+1). Teraz polaczenie jest oznaczane jako
 * zuzyte, zamykane i ZWRACANE do puli, ktora przy walidacji niszczy je
 * wlasnym API i zwalnia slot.
 */
async function destroyConnection(
  client: PgClientLike,
  connection: QueryableConnection,
  logger: HookLogger | undefined,
  reason: string,
  releaseToPool: (connection: QueryableConnection) => Promise<void>
): Promise<void> {
  (connection as unknown as Record<string, unknown>)[KNEX_DISPOSED_MARKER] = reason;
  try {
    await client.destroyRawConnection?.(connection);
    await connection.end?.();
  } catch (error) {
    logger?.error?.(reason, { error: describeError(error) });
  }
  try {
    await releaseToPool(connection);
  } catch (error) {
    logger?.error?.(`${reason} (release to pool failed)`, { error: describeError(error) });
    throw error;
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

    const grant = ctx?.market_id ? null : consumeSellerMarketLookupGrant();
    if (grant) {
      // Named, one-shot exception (SELLER_MARKET_LOOKUP_EXCEPTION, ADR-241):
      // exactly one connection, under `SET ROLE medusa_store` like every other
      // hooked connection, that admits exactly ONE query whose text equals the
      // fixed `seller`-by-id read compiled in
      // `lookupSellerMarketIdWithoutMarketContext`. Any other query on it is
      // denied (`seller_lookup_query_not_allowed`) and the connection is
      // destroyed on release. No market variable is set.
      try {
        await connection.query("SET ROLE medusa_store");
      } catch (error) {
        logger?.error?.("RLS pool hook named exception SET ROLE failed", {
          exception: SELLER_MARKET_LOOKUP_EXCEPTION,
          error: describeError(error),
        });
        await destroyConnection(
          client,
          connection,
          logger,
          "RLS pool hook named exception destroy failed",
          origRelease
        );
        throw error;
      }
      installFixedQueryGuard(connection, grant.allowedSql);
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
        "RLS pool hook missing-context destroy failed",
        origRelease
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
        "RLS pool hook invalid-context destroy failed",
        origRelease
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
        "RLS pool hook missing-instance destroy failed",
        origRelease
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
        "RLS pool hook invalid-instance destroy failed",
        origRelease
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
        "RLS pool hook acquire destroy failed",
        origRelease
      );
      throw error;
    }

    return connection;
  };

  client.releaseConnection = async function (
    connection: QueryableConnection
  ): Promise<void> {
    const guard = connection[LOOKUP_GUARD_MARKER];
    if (guard) {
      // Named-exception connection: restore the driver's query, drop the role.
      // A refused query marks it dirty — destroy it instead of pooling it.
      if (guard.ownQuery) connection.query = guard.originalQuery;
      else delete (connection as { query?: unknown }).query;
      delete connection[LOOKUP_GUARD_MARKER];
      let clean = !guard.denied;
      if (clean) {
        try {
          await connection.query("RESET ROLE");
        } catch (error) {
          logger?.error?.("RLS pool hook named exception cleanup failed", {
            error: describeError(error),
          });
          clean = false;
        }
      }
      if (!clean) {
        await destroyConnection(
          client,
          connection,
          logger,
          "RLS pool hook named exception destroy failed",
          origRelease
        );
        return;
      }
      return origRelease(connection);
    }
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
          "RLS pool hook release destroy failed",
          origRelease
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
 *   - the granted connection admits ONE query whose text equals the compiled
 *     fixed read (`allowedSql`); any other text — or a second query — is denied
 *     (`seller_lookup_query_not_allowed`) and the connection is destroyed
 *     (Story 5.4 fix round 2, R-13);
 *   - the connection runs under `SET ROLE medusa_store` like every hooked
 *     connection, so the read has the runtime role's grants, not the login's;
 *   - inside an existing market context it is never consulted.
 */
export const SELLER_MARKET_LOOKUP_EXCEPTION = "seller_market_lookup";

type SellerMarketLookupGrant = { remaining: number; allowedSql: string | null };
const sellerMarketLookupStorage = new AsyncLocalStorage<SellerMarketLookupGrant>();

function consumeSellerMarketLookupGrant(): SellerMarketLookupGrant | null {
  const grant = sellerMarketLookupStorage.getStore();
  if (!grant || grant.remaining <= 0) return null;
  grant.remaining -= 1;
  return grant;
}

/**
 * The single fixed read the exception admits. Exported so the guard's
 * allowed text can be asserted in tests; it is NOT an extension point.
 */
export const SELLER_MARKET_LOOKUP_SELECT = "metadata->'gp'->>'market_id' as market_id";

type SellerLookupQuery = Promise<{ market_id?: string | null } | undefined> & {
  toSQL?: () => { toNative: () => { sql: string } };
};

type SellerLookupKnex = {
  (table: string): {
    select: (...args: unknown[]) => {
      where: (column: string, value: string) => {
        first: () => SellerLookupQuery;
      };
    };
  };
  raw: (sql: string) => unknown;
};

export async function lookupSellerMarketIdWithoutMarketContext(
  db: SellerLookupKnex,
  sellerId: string
): Promise<string | null> {
  const query = db("seller")
    .select(db.raw(SELLER_MARKET_LOOKUP_SELECT))
    .where("id", sellerId)
    .first();
  // The guard compares the driver-level text with THIS compiled text; a builder
  // that cannot compile (no `toSQL`) gets `null`, i.e. every query is denied.
  const allowedSql =
    typeof query.toSQL === "function" ? query.toSQL().toNative().sql : null;
  const grant: SellerMarketLookupGrant = { remaining: 1, allowedSql };
  // `async` + `await` INSIDE run(): a Knex builder executes on `.then`, so it
  // must be awaited within the grant scope, not after it.
  const row = await sellerMarketLookupStorage.run(grant, async () => await query);
  grant.remaining = 0;
  return row?.market_id ?? null;
}
