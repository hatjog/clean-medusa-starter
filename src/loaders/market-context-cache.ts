import type { MedusaContainer } from "@medusajs/types";
import { ContainerRegistrationKeys } from "@medusajs/framework/utils";
import { installRlsPoolHook } from "../lib/rls-pool-hook";

const TTL_MS = 60_000;

function resolveLogger(container: MedusaContainer | null) {
  if (!container) {
    return undefined;
  }

  try {
    return container.resolve(ContainerRegistrationKeys.LOGGER) as
      | { error?: (...args: unknown[]) => void }
      | undefined;
  } catch {
    return undefined;
  }
}

class MarketContextCache {
  private scToMarket = new Map<string, string>();
  private loaded = false;
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private container: MedusaContainer | null = null;
  private initPromise: Promise<void> | null = null;

  /**
   * Lazy initialization — called from middleware with req.scope as container.
   * Only the first call actually loads; subsequent calls return cached promise.
   */
  async ensureLoaded(container: MedusaContainer): Promise<void> {
    this.container = container;
    if (this.loaded) return;
    if (!this.initPromise) {
      this.initPromise = this.init(container).catch((error) => {
        this.initPromise = null;
        throw error;
      });
    }
    return this.initPromise;
  }

  async init(container: MedusaContainer): Promise<void> {
    this.container = container;
    await this.loadFromDb();
    this.loaded = true;
    this.stopRefreshLoop();
    this.refreshTimer = setInterval(() => {
      this.loadFromDb().catch((err) => {
        const logger = resolveLogger(this.container);
        logger?.error?.("MarketContextCache refresh failed", err);
      });
    }, TTL_MS);
  }

  async loadFromDb(): Promise<void> {
    if (!this.container) return;

    const pgConnection = this.container.resolve(
      ContainerRegistrationKeys.PG_CONNECTION
    );

    const result = await pgConnection.raw(
      `SELECT id, metadata->>'gp_market_id' AS market_id
       FROM sales_channel
       WHERE metadata->>'gp_market_id' IS NOT NULL`
    );

    const newMap = new Map<string, string>();
    for (const row of result.rows) {
      if (row.market_id) {
        newMap.set(row.id, row.market_id);
      }
    }

    this.scToMarket = newMap;
    this.loaded = true;
  }

  get(scId: string): string | null {
    return this.scToMarket.get(scId) ?? null;
  }

  invalidate(): void {
    this.scToMarket.clear();
    this.loaded = false;
    this.initPromise = null;
    this.stopRefreshLoop();
    if (this.container) {
      this.ensureLoaded(this.container).catch((err) => {
        const logger = resolveLogger(this.container);
        logger?.error?.("MarketContextCache reload failed", err);
      });
    }
  }

  isLoaded(): boolean {
    return this.loaded;
  }

  private stopRefreshLoop(): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

  destroy(): void {
    this.stopRefreshLoop();
    this.scToMarket.clear();
    this.loaded = false;
    this.initPromise = null;
  }
}

export const marketContextCache = new MarketContextCache();

export default async function marketContextCacheLoader({
  container,
}: {
  container: MedusaContainer;
}): Promise<void> {
  const pgConnection = container.resolve(ContainerRegistrationKeys.PG_CONNECTION);
  installRlsPoolHook(pgConnection);
  await marketContextCache.ensureLoaded(container);
}
