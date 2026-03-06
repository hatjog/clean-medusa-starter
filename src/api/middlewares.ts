import {
  defineMiddlewares,
  type MedusaNextFunction,
  type MedusaRequest,
  type MedusaResponse,
} from "@medusajs/framework/http";
import { ContainerRegistrationKeys } from "@medusajs/framework/utils";
import { marketContextStorage } from "../lib/market-context";
import { installRlsPoolHook } from "../lib/rls-pool-hook";
import { marketContextCache } from "../loaders/market-context-cache";

/**
 * Market Context Middleware — resolves market_id from publishable key → sales channel → cache.
 * Sets AsyncLocalStorage context for downstream middleware and handlers.
 * Also installs the RLS pool hook if startup loader didn't run yet (idempotent).
 * Runs on /store/* routes BEFORE the guard.
 */
export async function marketContextMiddleware(
  req: MedusaRequest,
  res: MedusaResponse,
  next: MedusaNextFunction
) {
  const scId = (req as any).publishable_key_context?.sales_channel_ids?.[0];
  if (!scId) {
    return next();
  }

  // Lazy-init: install RLS pool hook + load cache on first store request
  const pgConnection = req.scope.resolve(
    ContainerRegistrationKeys.PG_CONNECTION
  );
  installRlsPoolHook(pgConnection);
  await marketContextCache.ensureLoaded(req.scope);

  const marketId = marketContextCache.get(scId);
  if (!marketId) {
    return next();
  }

  marketContextStorage.run(
    { market_id: marketId, sales_channel_id: scId },
    () => next()
  );
}

/**
 * Market Guard Middleware — fail-closed.
 * Store requests without market context → 403.
 * Runs AFTER marketContextMiddleware.
 */
export async function marketGuardMiddleware(
  req: MedusaRequest,
  res: MedusaResponse,
  next: MedusaNextFunction
) {
  const ctx = marketContextStorage.getStore();
  if (!ctx?.market_id) {
    res.status(403).json({ message: "Market context required" });
    return;
  }
  next();
}

export default defineMiddlewares({
  routes: [
    {
      matcher: "/store/*",
      middlewares: [
        marketContextMiddleware,
        marketGuardMiddleware,
      ],
    },
  ],
});
