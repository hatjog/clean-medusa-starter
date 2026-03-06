/**
 * RLS Pool Hook — Story 10-3
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

let installedClients = new WeakSet<object>();

export function installRlsPoolHook(pgConnection: any): void {
  const client = pgConnection?.client;
  if (!client || installedClients.has(client)) {
    return;
  }

  installedClients.add(client);
  const origAcquire = client.acquireConnection.bind(client);
  const origRelease = client.releaseConnection.bind(client);

  client.acquireConnection = async function (): Promise<any> {
    const connection = await origAcquire();
    const ctx = marketContextStorage.getStore();
    if (ctx?.market_id && SAFE_ID_RE.test(ctx.market_id)) {
      await connection.query("SET ROLE medusa_store");
      await connection.query(
        `SELECT set_config('app.gp_market_id', '${ctx.market_id}', false)`
      );
      (connection as any)[RLS_MARKER] = true;
    }
    return connection;
  };

  client.releaseConnection = async function (connection: any): Promise<void> {
    if (connection[RLS_MARKER]) {
      try {
        await connection.query("RESET app.gp_market_id");
        await connection.query("RESET ROLE");
      } catch {
        // Connection is dirty — destroy instead of returning to pool
        try {
          await client.destroyRawConnection?.(connection);
          connection.end?.();
        } catch {
          // ignore cleanup errors
        }
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
