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

import { marketContextStorage } from "./market-context";

const SAFE_ID_RE = /^[a-zA-Z0-9_-]+$/;
const RLS_MARKER = Symbol("__gp_rls_active");

export type HookLogger = {
  warn?: (...args: unknown[]) => void;
  info?: (...args: unknown[]) => void;
  error?: (...args: unknown[]) => void;
};

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

    if (!ctx?.market_id) {
      return connection;
    }

    if (!SAFE_ID_RE.test(ctx.market_id)) {
      logger?.warn?.("RLS pool hook skipped invalid market id", {
        market_id: ctx.market_id,
      });
      return connection;
    }

    try {
      await connection.query("SET ROLE medusa_store");
      await connection.query(
        "SELECT set_config('app.gp_market_id', $1, false)",
        [ctx.market_id]
      );
      connection[RLS_MARKER] = true;
    } catch (error) {
      logger?.error?.("RLS pool hook acquire failed", {
        market_id: ctx.market_id,
        error: describeError(error),
      });

      try {
        await connection.query("RESET app.gp_market_id");
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
        await connection.query("RESET app.gp_market_id");
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
