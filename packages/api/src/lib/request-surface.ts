import type { MedusaRequest } from "@medusajs/framework/http";
import { ContainerRegistrationKeys } from "@medusajs/framework/utils";

/**
 * Shared typed request-surface helpers (Story 6.4, AUD-12-17).
 *
 * Single source of truth for the authenticated actor context and the Query
 * graph accessor so store routes stop re-declaring `(req as any).auth_context`
 * / `query as any` copies. Keeping the `auth_context.actor_id` contract in one
 * place avoids the shape drifting between handlers.
 */

/** Request augmented with Medusa's authenticated actor context. */
export type AuthenticatedStoreRequest = MedusaRequest & {
  auth_context?: {
    actor_id?: string;
  };
};

export type QueryGraphResult = {
  data: Array<Record<string, unknown>>;
};

export type QueryGraph = {
  graph: (input: Record<string, unknown>) => Promise<QueryGraphResult>;
};

/** Resolve the authenticated customer id (empty/non-string actor ⇒ undefined). */
export function getCustomerId(
  req: AuthenticatedStoreRequest
): string | undefined {
  const actorId = req.auth_context?.actor_id;
  return typeof actorId === "string" && actorId.length > 0 ? actorId : undefined;
}

/** Resolve the typed Query graph from the request scope. */
export function resolveQueryGraph(req: MedusaRequest): QueryGraph {
  return req.scope.resolve(ContainerRegistrationKeys.QUERY) as QueryGraph;
}
