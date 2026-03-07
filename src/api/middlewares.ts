import {
  defineMiddlewares,
  type MedusaNextFunction,
  type MedusaRequest,
  type MedusaResponse,
} from "@medusajs/framework/http";
import type { Knex } from "knex";
import {
  ContainerRegistrationKeys,
  Modules,
} from "@medusajs/framework/utils";
import {
  CUSTOMER_MARKET_FORBIDDEN_MESSAGE,
  isScopedToMarket,
  mergeCustomerMarketMetadata,
  resolveCustomerMarketId,
  sanitizeCustomerEmailInObject,
  scopeCustomerEmail,
} from "../lib/customer-scoped-email";
import { marketContextStorage } from "../lib/market-context";
import { installRlsPoolHook, type HookLogger } from "../lib/rls-pool-hook";
import { marketContextCache } from "../loaders/market-context-cache";

type LoggerLike = HookLogger;

type PublishableKeyContext = {
  key: string;
  sales_channel_ids: string[];
};

type PublishableApiKeyRecord = {
  token: string;
  revoked_at?: string | Date | null;
  sales_channels_link?: Array<{ sales_channel_id: string }>;
};

type AuthContext = {
  auth_identity_id?: string;
  actor_id?: string;
};

type RequestExtensions = {
  publishable_key_context?: PublishableKeyContext;
  validatedBody?: Record<string, unknown>;
  auth_context?: AuthContext;
  params?: Record<string, unknown>;
  path?: string;
  originalUrl?: string;
  url?: string;
  get?: (headerName: string) => unknown;
};

const RLS_DEBUG_ENV = "GP_RLS_DEBUG";

function getRequestExtensions(req: MedusaRequest): RequestExtensions {
  return req as MedusaRequest & RequestExtensions;
}

function getValidatedBody(req: MedusaRequest): Record<string, unknown> | undefined {
  return getRequestExtensions(req).validatedBody;
}

function getRequestBody(req: MedusaRequest): Record<string, unknown> | undefined {
  return req.body && typeof req.body === "object" && !Array.isArray(req.body)
    ? (req.body as Record<string, unknown>)
    : undefined;
}

function getStringField(req: MedusaRequest, key: string): string | null {
  const bodyValue = getRequestBody(req)?.[key];
  if (typeof bodyValue === "string") {
    return bodyValue;
  }

  const validatedValue = getValidatedBody(req)?.[key];
  return typeof validatedValue === "string" ? validatedValue : null;
}

function getMetadataField(
  req: MedusaRequest
): Record<string, unknown> | null | undefined {
  const validatedValue = getValidatedBody(req)?.metadata;
  if (
    validatedValue &&
    typeof validatedValue === "object" &&
    !Array.isArray(validatedValue)
  ) {
    return validatedValue as Record<string, unknown>;
  }

  const bodyValue = getRequestBody(req)?.metadata;
  if (bodyValue && typeof bodyValue === "object" && !Array.isArray(bodyValue)) {
    return bodyValue as Record<string, unknown>;
  }

  return bodyValue === null || validatedValue === null ? null : undefined;
}

function getAuthContext(req: MedusaRequest): AuthContext | undefined {
  return getRequestExtensions(req).auth_context;
}

function getRequestPath(req: MedusaRequest): string {
  const request = getRequestExtensions(req);

  return request.path ?? request.originalUrl ?? request.url ?? "";
}

function shouldLogRlsDebug(): boolean {
  return process.env[RLS_DEBUG_ENV] === "1";
}

function logRlsDebug(
  req: MedusaRequest,
  event: string,
  details: Record<string, unknown> = {}
): void {
  if (!shouldLogRlsDebug()) {
    return;
  }

  resolveLogger(req.scope)?.info?.(`[rls-debug] ${event}`, {
    path: getRequestPath(req),
    ...details,
  });
}

async function ensurePublishableKeyContext(
  req: MedusaRequest
): Promise<PublishableKeyContext | null> {
  const request = getRequestExtensions(req);
  const existingContext = request.publishable_key_context;
  if (existingContext?.sales_channel_ids?.length) {
    return existingContext;
  }

  const headerValue =
    typeof request.get === "function"
      ? request.get("x-publishable-api-key")
      : undefined;
  const rawPublishableKey =
    headerValue ?? req.headers?.["x-publishable-api-key"] ?? null;
  const publishableKey = Array.isArray(rawPublishableKey)
    ? rawPublishableKey[0]
    : rawPublishableKey;

  if (!publishableKey) {
    return null;
  }

  const query = req.scope.resolve(ContainerRegistrationKeys.QUERY) as {
    graph: (
      queryConfig: Record<string, unknown>,
      options?: Record<string, unknown>
    ) => Promise<{ data: PublishableApiKeyRecord[] }>;
  };
  const { data } = await query.graph(
    {
      entity: "api_key",
      fields: [
        "id",
        "token",
        "revoked_at",
        "sales_channels_link.sales_channel_id",
      ],
      filters: {
        token: publishableKey,
      },
    },
    {
      cache: {
        enable: true,
      },
    }
  );

  if (!data.length) {
    return null;
  }

  const apiKey = data[0];
  const isRevoked =
    apiKey.revoked_at != null && new Date(apiKey.revoked_at) <= new Date();

  if (isRevoked) {
    return null;
  }

  const publishableKeyContext: PublishableKeyContext = {
    key: apiKey.token,
    sales_channel_ids: (apiKey.sales_channels_link ?? []).map(
      (link) => link.sales_channel_id
    ),
  };

  request.publishable_key_context = publishableKeyContext;

  return publishableKeyContext;
}

function resolveLogger(
  scope: MedusaRequest["scope"] | undefined
): LoggerLike | undefined {
  if (!scope) {
    return undefined;
  }

  try {
    return scope.resolve(ContainerRegistrationKeys.LOGGER) as LoggerLike;
  } catch {
    return undefined;
  }
}

async function resolveRequestMarketContext(req: MedusaRequest): Promise<{
  marketId: string;
  salesChannelId: string;
} | null> {
  const existingContext = marketContextStorage.getStore();
  if (existingContext?.market_id && existingContext.sales_channel_id) {
    return {
      marketId: existingContext.market_id,
      salesChannelId: existingContext.sales_channel_id,
    };
  }

  const publishableKeyContext = await ensurePublishableKeyContext(req);
  const salesChannelId = publishableKeyContext?.sales_channel_ids?.[0];

  if (!salesChannelId) {
    return null;
  }

  const pgConnection = req.scope.resolve(
    ContainerRegistrationKeys.PG_CONNECTION
  );
  installRlsPoolHook(pgConnection, resolveLogger(req.scope));
  await marketContextCache.ensureLoaded(req.scope);

  const marketId = marketContextCache.get(salesChannelId);
  if (!marketId) {
    return null;
  }

  return {
    marketId,
    salesChannelId,
  };
}

function setRequestValue(
  req: MedusaRequest,
  key: string,
  value: unknown
): void {
  if (req.body && typeof req.body === "object") {
    (req.body as Record<string, unknown>)[key] = value;
  }

  const validatedBody = getValidatedBody(req);
  if (validatedBody && typeof validatedBody === "object") {
    validatedBody[key] = value;
  }
}

function failWithMarketContext(res: MedusaResponse): void {
  res.status(403).json({ message: "Market context required" });
}

function failWithCustomerMarket(res: MedusaResponse): void {
  res.status(403).json({ message: CUSTOMER_MARKET_FORBIDDEN_MESSAGE });
}

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
  const context = await resolveRequestMarketContext(req);
  if (!context) {
    logRlsDebug(req, "market-context-missing");
    return next();
  }

  logRlsDebug(req, "market-context-resolved", {
    market_id: context.marketId,
    sales_channel_id: context.salesChannelId,
  });

  marketContextStorage.run(
    { market_id: context.marketId, sales_channel_id: context.salesChannelId },
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
    logRlsDebug(req, "market-guard-blocked");
    failWithMarketContext(res);
    return;
  }
  next();
}

export async function customerScopedAuthMiddleware(
  req: MedusaRequest,
  res: MedusaResponse,
  next: MedusaNextFunction
) {
  const context = await resolveRequestMarketContext(req);
  if (!context) {
    failWithMarketContext(res);
    return;
  }

  const email = getStringField(req, "email");
  if (email) {
    setRequestValue(req, "email", scopeCustomerEmail(email, context.marketId));
  }

  const identifier = getStringField(req, "identifier");
  if (identifier) {
    setRequestValue(
      req,
      "identifier",
      scopeCustomerEmail(identifier, context.marketId)
    );
  }

  next();
}

export async function customerRegistrationMarketGuardMiddleware(
  req: MedusaRequest,
  res: MedusaResponse,
  next: MedusaNextFunction
) {
  const authContext = getAuthContext(req);
  if (!authContext?.auth_identity_id || authContext.actor_id) {
    next();
    return;
  }

  const context = await resolveRequestMarketContext(req);
  if (!context) {
    failWithMarketContext(res);
    return;
  }

  const authService = req.scope.resolve(Modules.AUTH) as {
    retrieveAuthIdentity: (id: string, config?: Record<string, unknown>) => Promise<{
      provider_identities?: Array<{ provider?: string; entity_id?: string }>;
    }>;
  };

  try {
    const authIdentity = await authService.retrieveAuthIdentity(
      authContext.auth_identity_id,
      { relations: ["provider_identities"] }
    );
    const providerIdentity = authIdentity.provider_identities?.find(
      (identity) => identity.provider === "emailpass"
    );
    const entityId = providerIdentity?.entity_id;

    if (entityId && !isScopedToMarket(entityId, context.marketId)) {
      failWithCustomerMarket(res);
      return;
    }
  } catch (error) {
    resolveLogger(req.scope)?.warn?.(
      "customerRegistrationMarketGuardMiddleware failed to resolve auth identity",
      {
        auth_identity_id: authContext.auth_identity_id,
        error:
          error instanceof Error ? error.message : String(error),
      }
    );
    failWithCustomerMarket(res);
    return;
  }

  next();
}

export async function customerScopedCustomerCreateMiddleware(
  req: MedusaRequest,
  res: MedusaResponse,
  next: MedusaNextFunction
) {
  const context = await resolveRequestMarketContext(req);
  if (!context) {
    failWithMarketContext(res);
    return;
  }

  const email = getStringField(req, "email");
  if (email) {
    setRequestValue(req, "email", scopeCustomerEmail(email, context.marketId));
  }

  const metadata = mergeCustomerMarketMetadata(
    getMetadataField(req),
    context.marketId
  );
  setRequestValue(req, "metadata", metadata);

  next();
}

export async function customerMarketGuardMiddleware(
  req: MedusaRequest,
  res: MedusaResponse,
  next: MedusaNextFunction
) {
  const actorId = getAuthContext(req)?.actor_id;
  if (!actorId) {
    next();
    return;
  }

  const context = await resolveRequestMarketContext(req);
  if (!context) {
    failWithMarketContext(res);
    return;
  }

  const customerService = req.scope.resolve(Modules.CUSTOMER) as {
    retrieveCustomer: (id: string) => Promise<{
      email?: string | null;
      metadata?: { gp?: { market_id?: string | null } | null } | null;
    }>;
  };
  const logger = resolveLogger(req.scope);

  try {
    const customer = await customerService.retrieveCustomer(actorId);
    const customerMarketId = resolveCustomerMarketId(customer);

    if (!customerMarketId) {
      logger?.warn?.(
        `Customer ${actorId} missing gp.market_id metadata; allowing legacy access.`
      );
      next();
      return;
    }

    if (customerMarketId !== context.marketId) {
      failWithCustomerMarket(res);
      return;
    }
  } catch (error) {
    logger?.warn?.("customerMarketGuardMiddleware failed to resolve customer", {
      actor_id: actorId,
      error: error instanceof Error ? error.message : String(error),
    });
    failWithCustomerMarket(res);
    return;
  }

  next();
}

export async function customerResponseSanitizerMiddleware(
  _req: MedusaRequest,
  res: MedusaResponse,
  next: MedusaNextFunction
) {
  const originalJson = res.json.bind(res);

  res.json = ((payload: unknown) =>
    originalJson(sanitizeCustomerEmailInObject(payload))) as typeof res.json;

  next();
}

function extractCartId(req: MedusaRequest): string | null {
  const request = getRequestExtensions(req);

  const paramsCartId = typeof request.params?.id === "string"
    ? request.params.id
    : null;

  if (paramsCartId) {
    return paramsCartId;
  }

  const rawPath = getRequestPath(req);

  const cleanPath = rawPath.split("?")[0];
  const segments = cleanPath.split("/").filter(Boolean);
  const cartsIndex = segments.indexOf("carts");

  if (cartsIndex === -1 || segments.length <= cartsIndex + 1) {
    return null;
  }

  return segments[cartsIndex + 1] ?? null;
}

export async function cartMarketGuardMiddleware(
  req: MedusaRequest,
  res: MedusaResponse,
  next: MedusaNextFunction
) {
  const cartId = extractCartId(req);
  if (!cartId) {
    next();
    return;
  }

  const context = marketContextStorage.getStore();
  if (!context?.market_id || !context.sales_channel_id) {
    failWithMarketContext(res);
    return;
  }

  const db = req.scope.resolve(ContainerRegistrationKeys.PG_CONNECTION) as Knex;
  const cart = await db("cart")
    .select("id", "sales_channel_id")
    .where({ id: cartId })
    .whereNull("deleted_at")
    .first<{ id: string; sales_channel_id: string | null }>();

  if (!cart?.id || !cart.sales_channel_id || cart.sales_channel_id !== context.sales_channel_id) {
    res.status(404).json({ message: "Cart not found" });
    return;
  }

  next();
}

export default defineMiddlewares({
  routes: [
    {
      method: ["POST"],
      matcher: "/auth/customer/emailpass/register",
      middlewares: [customerScopedAuthMiddleware],
    },
    {
      method: ["POST"],
      matcher: "/auth/customer/emailpass",
      middlewares: [customerScopedAuthMiddleware],
    },
    {
      method: ["POST"],
      matcher: "/auth/customer/emailpass/reset-password",
      middlewares: [customerScopedAuthMiddleware],
    },
    {
      matcher: "/store/*",
      middlewares: [
        marketContextMiddleware,
        marketGuardMiddleware,
        customerMarketGuardMiddleware,
      ],
    },
    {
      method: ["POST"],
      matcher: "/store/customers",
      middlewares: [
        customerRegistrationMarketGuardMiddleware,
        customerScopedCustomerCreateMiddleware,
        customerResponseSanitizerMiddleware,
      ],
    },
    {
      method: "ALL",
      matcher: "/store/customers/me*",
      middlewares: [customerResponseSanitizerMiddleware],
    },
    {
      method: "ALL",
      matcher: "/store/orders*",
      middlewares: [customerResponseSanitizerMiddleware],
    },
    {
      method: "ALL",
      matcher: "/store/carts*",
      middlewares: [cartMarketGuardMiddleware, customerResponseSanitizerMiddleware],
    },
  ],
});
