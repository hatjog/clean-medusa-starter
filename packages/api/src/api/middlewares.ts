import {
  authenticate,
  defineMiddlewares,
  type MedusaNextFunction,
  type MedusaRequest,
  type MedusaResponse,
} from "@medusajs/framework/http";
import { operatorAuthMiddleware } from "../middlewares/with-operator-auth";
import type { Knex } from "knex";
import {
  ContainerRegistrationKeys,
  Modules,
} from "@medusajs/framework/utils";
import { vendorMetaMiddleware } from "./store/products/vendor-meta-middleware";
import {
  BREVO_PROVIDER_ROUTE_MATCHER,
  brevoHmacValidatorMiddleware,
  brevoWebhookCircuitBreakerMiddleware,
  brevoWebhookRateLimitMiddleware,
} from "./middlewares/brevo-hmac-validator";
import { paymentStatusRateLimitMiddleware } from "./middlewares/payment-status-rate-limit";
import { upstreamOrderAccessGuardMiddleware } from "./middlewares/upstream-order-access-guard";
import {
  CUSTOMER_MARKET_FORBIDDEN_MESSAGE,
  isScopedToMarket,
  mergeCustomerMarketMetadata,
  resolveCustomerMarketId,
  sanitizeCustomerEmailInObject,
  scopeCustomerEmail,
} from "../lib/customer-scoped-email";
import { marketContextStorage } from "../lib/market-context";
import { recordRequest } from "../lib/request-log-aggregator";
import { installRlsPoolHook, type HookLogger } from "../lib/rls-pool-hook";
import { marketContextCache } from "../loaders/market-context-cache";
import { listProductIdsForSalesChannel } from "../lib/product-market-scope";

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
  actor_type?: string;
};

type RequestExtensions = {
  publishable_key_context?: PublishableKeyContext;
  validatedBody?: Record<string, unknown>;
  auth_context?: AuthContext;
  params?: Record<string, unknown>;
  query?: Record<string, unknown>;
  filterableFields?: Record<string, unknown>;
  path?: string;
  originalUrl?: string;
  url?: string;
  get?: (headerName: string) => unknown;
};

type ProductListResponseBody = {
  products?: Array<Record<string, unknown>>;
  product?: Record<string, unknown>;
  count?: number;
  offset?: number;
  limit?: number;
  [key: string]: unknown;
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
): HookLogger | undefined {
  if (!scope) {
    return undefined;
  }

  try {
    return scope.resolve(ContainerRegistrationKeys.LOGGER) as HookLogger;
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

/**
 * Story 4.4 F7 — HTTP semantics split:
 *
 * The publishable-key based market-context resolution can fail in two distinct
 * scenarios on `/store/*` routes:
 *
 *   - Missing `x-publishable-api-key` header → unauthenticated → 401
 *   - Header present but key unknown / revoked → unauthenticated → 401
 *
 * Both map to the same wire response because the runtime cannot
 * distinguish between "no key" and "wrong key" without leaking key-existence
 * to anonymous callers. They share status code 401 (Unauthorized).
 *
 * Cross-market access with a VALID publishable key (e.g. a customer in
 * market A authenticating against market B) is enforced by
 * `failWithCustomerMarket` (403 Forbidden) and `cartMarketGuardMiddleware`
 * (404 to avoid leaking cart existence). Those callers are intentionally
 * NOT routed through `failWithMarketContext`.
 *
 * Per HTTP semantics (RFC 7235):
 *   - 401 = authentication required / failed
 *   - 403 = authenticated but not authorized
 *
 * Story 4.4 AC3 mandates 401 for missing/invalid publishable key.
 */
function failWithMarketContext(res: MedusaResponse): void {
  res.status(401).json({ message: "Market context required" });
}

export function requestLogMetricsMiddleware(
  req: MedusaRequest,
  res: MedusaResponse,
  next: MedusaNextFunction
) {
  const startedAt = Date.now();
  const requestPath = getRequestPath(req).split("?")[0] || "unknown";
  let recorded = false;

  const flushSample = () => {
    if (recorded) {
      return;
    }

    recorded = true;
    recordRequest({
      ts: Date.now(),
      duration_ms: Math.max(Date.now() - startedAt, 0),
      status_code: Number(res.statusCode ?? 0),
      cohort: requestPath,
    });
  };

  res.once("finish", flushSample);
  res.once("close", flushSample);
  next();
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
 * Store requests without market context → 401 (missing/invalid publishable key).
 * Cross-market access with a VALID key is handled separately by the customer
 * guards (403) and cartMarketGuardMiddleware (404). See Story 4.4 AC3 / F7.
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

function productMarketId(product: Record<string, unknown>): string | null {
  const metadata = product.metadata;
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return null;
  }

  const gp = (metadata as Record<string, unknown>).gp;
  if (gp && typeof gp === "object" && !Array.isArray(gp)) {
    const value = (gp as Record<string, unknown>).market_id;
    return typeof value === "string" && value.trim() ? value : null;
  }

  const value = (metadata as Record<string, unknown>).market_id;
  return typeof value === "string" && value.trim() ? value : null;
}

/**
 * v1.15.0 Story 2.4 (FR-14b, NFR-5) — kontrakt statusu dla dostepu cross-market.
 *
 * ADR-109 (`specs/adr/2026-05-14-adr-109-market-guard-middleware-3-state.md:44`):
 * "Jesli zasob ... jest requestowany przez user z innego marketu -> 403
 * (nie 404, bo zasob istnieje — cross-market access deny)".
 *
 * SWIADOMA KOREKTA ROZJAZDU: galaz detalu zwracala tu wczesniej 404. Byla to
 * galaz MARTWA (middleware nie byl zarejestrowany na `/store/products/:id`),
 * wiec rozjazd z ADR-109 nie mial jak sie ujawnic. Ozywienie trasy go ujawnia
 * i ta story go zamyka.
 *
 * NIE mylic ze scenariuszem "brak kontekstu rynku" — ten rozstrzyga
 * `failWithMarketContext()` (401, mandat Story 4.4 AC3/F7) i story 2.3.
 * Brak kontekstu != kontekst obcego rynku.
 */
export const CROSS_MARKET_PRODUCT_STATUS = 403;
export const CROSS_MARKET_PRODUCT_MESSAGE = "Product not available in this market";

/**
 * Czy zadanie celuje w JEDEN konkretny produkt?
 *
 * "Trasa szczegolu produktu" to dzis DWIE sciezki sieciowe: `/store/products/:id`
 * oraz `/store/products?handle=...` (storefrontowy PDP idzie przez liste).
 * Parytet statusu z AC2 dotyczy wlasnie zadan celowanych — dla przegladania
 * katalogu odfiltrowanie obcorynkowych pozycji pozostaje poprawne (200).
 */
function targetsSingleProduct(request: RequestExtensions): boolean {
  const handle = request.filterableFields?.handle ?? request.query?.handle;
  if (typeof handle === "string" && handle.trim()) {
    return true;
  }
  if (Array.isArray(handle) && handle.length === 1) {
    return true;
  }

  const id = request.filterableFields?.id ?? request.query?.id;
  if (typeof id === "string" && id.trim()) {
    return true;
  }
  return Array.isArray(id) && id.length === 1;
}

export async function productListMarketScopeMiddleware(
  req: MedusaRequest,
  res: MedusaResponse,
  next: MedusaNextFunction
): Promise<void> {
  const request = getRequestExtensions(req);
  const context = marketContextStorage.getStore();

  // Story 2.4: na trasie detalu (`/store/products/:id`) rdzen Medusy czyta
  // `req.params.id`, a nie `filterableFields.id`. Wstrzykniecie tam pelnej listy
  // ID kanalu nic nie zaweza, za to rozjezdza sie z kontraktem handlera detalu.
  // Zawezanie wejsciowe zostaje wiec przy powierzchni listingowej; ochrona
  // detalu dziala na odpowiedzi (ponizej), na juz policzonym produkcie.
  const isDetailRoute = typeof request.params?.id === "string";

  if (context?.sales_channel_id && !isDetailRoute) {
    const db = req.scope.resolve(ContainerRegistrationKeys.PG_CONNECTION) as Knex;
    let scopedProductIds = await listProductIdsForSalesChannel(
      db,
      context.sales_channel_id
    );
    const existingIdFilter = request.filterableFields?.id ?? request.query?.id;
    const requestedIds = Array.isArray(existingIdFilter)
      ? existingIdFilter.filter((id): id is string => typeof id === "string")
      : typeof existingIdFilter === "string"
        ? [existingIdFilter]
        : [];

    if (requestedIds.length) {
      const requestedIdSet = new Set(requestedIds);
      scopedProductIds = scopedProductIds.filter((id) => requestedIdSet.has(id));
    }

    const enforcedIds = scopedProductIds.length
      ? scopedProductIds
      : ["__gp_no_products_in_market__"];
    request.query = { ...request.query, id: enforcedIds };
    request.filterableFields = { ...request.filterableFields, id: enforcedIds };
  }

  const originalJson = res.json.bind(res);

  (res as unknown as { json: (body: unknown) => Promise<void> }).json =
    async (body: unknown): Promise<void> => {
      const context = marketContextStorage.getStore();
      if (
        !context?.market_id ||
        !context.sales_channel_id ||
        !body ||
        typeof body !== "object" ||
        Array.isArray(body)
      ) {
        return originalJson(body);
      }

      const typedBody = body as ProductListResponseBody;
      if (!Array.isArray(typedBody.products)) {
        if (
          typedBody.product &&
          typeof typedBody.product === "object" &&
          !Array.isArray(typedBody.product) &&
          productMarketId(typedBody.product) !== context.market_id
        ) {
          // ADR-109 :44 — zasob istnieje, ale nalezy do innego rynku => 403.
          res.status(CROSS_MARKET_PRODUCT_STATUS);
          return originalJson({ message: CROSS_MARKET_PRODUCT_MESSAGE });
        }
        return originalJson(body);
      }

      const hasCrossMarketProducts = typedBody.products.some(
        (product) => productMarketId(product) !== context.market_id
      );
      if (!hasCrossMarketProducts) {
        return originalJson(body);
      }

      // Market-scope guard: the resolved market context (publishable key → sales
      // channel) must never expose another market's products. The core Medusa
      // handler has already sales-channel-scoped, query-matched (handle / category
      // / …) AND priced (`calculated_price`) every product in `typedBody.products`;
      // we only drop the ones whose `gp.market_id` doesn't match the resolved market.
      //
      // Previously this path re-derived the list via
      // `filterProductIdsByFilters(..., {}, ...)` + `query.graph(...)`, which
      //   (a) discarded the request's own filters — a `handle=…` PDP lookup returned
      //       the newest in-channel product instead of the requested one, and
      //   (b) dropped the pricing context, so every re-fetched product came back
      //       with `calculated_price: null` and a permanently disabled add-to-cart.
      // Filtering the already-correct response in place fixes both while keeping the
      // isolation guarantee. Products whose market can't be determined (metadata not
      // requested) are kept — the publishable-key sales-channel scope still applies.
      const inMarketProducts = typedBody.products.filter((product) => {
        const productMarket = productMarketId(product);
        return productMarket === null || productMarket === context.market_id;
      });

      const removedCount = typedBody.products.length - inMarketProducts.length;

      // Story 2.4 / AC2 — PARYTET POWIERZCHNI. `/store/products?handle=...` to
      // druga siec­owa sciezka PDP. Gdy zadanie celowalo w jeden konkretny
      // produkt i jedyne dopasowanie odpadlo jako obcorynkowe, odpowiedzia jest
      // ten sam status co na `/store/products/:id` (ADR-109 :44), a nie puste 200.
      // Przegladanie katalogu (brak filtra celowanego) nadal filtruje po cichu.
      if (removedCount > 0 && !inMarketProducts.length && targetsSingleProduct(request)) {
        res.status(CROSS_MARKET_PRODUCT_STATUS);
        return originalJson({ message: CROSS_MARKET_PRODUCT_MESSAGE });
      }

      const scopedCount =
        typeof typedBody.count === "number"
          ? Math.max(typedBody.count - removedCount, inMarketProducts.length)
          : inMarketProducts.length;

      return originalJson({
        ...typedBody,
        products: inMarketProducts,
        count: scopedCount,
      });
    };

  next();
}

export default defineMiddlewares({
  routes: [
    // Story 1.3: retired GP custom Stripe webhook. Real Stripe webhook
    // processing lives on Medusa native /hooks/payment/stripe.
    // Keep this route outside /store/* so callers receive the explicit 410
    // instead of market guard auth noise.
    {
      method: ["POST"],
      matcher: "/webhooks/stripe",
    },
    // Story 5.1 (FR-10) FINDING-1 fix: bez preserveRawBody route.ts (readRawBody)
    // fail-closed 400 raw_body_unavailable na KAŻDYM realnym webhooku Stripe —
    // sygnatura musi być weryfikowana bajt-w-bajt (wzorzec Brevo poniżej).
    {
      method: ["POST"],
      matcher: "/webhooks/stripe/payment-intent",
      bodyParser: { preserveRawBody: true },
    },
    {
      method: ["POST"],
      matcher: BREVO_PROVIDER_ROUTE_MATCHER,
      bodyParser: { preserveRawBody: true },
      middlewares: [
        brevoWebhookRateLimitMiddleware,
        brevoWebhookCircuitBreakerMiddleware,
        brevoHmacValidatorMiddleware,
      ],
    },
    {
      method: ["GET"],
      matcher: "/store/orders/:id/payment-status",
      // allowUnauthenticated: `auth_context` nadal jest wypełniany dla zalogowanych,
      // ale gość nie jest odbijany na poziomie middleware'u — trasa sama rozstrzyga
      // dostęp przez `lib/orders/guest-order-access.ts` (sesja ALBO dowód koszyka).
      // Twarde `authenticate` tutaj oznaczało 401 dla każdego checkoutu bez konta.
      // Rate-limit stoi PRZED `authenticate`: dławimy próby DOWODU, więc licznik
      // musi widzieć również żądania, które uwierzytelnienie odrzuci. Za nim koszt
      // zgadywania byłby liczony dopiero po przejściu przez auth.
      middlewares: [
        paymentStatusRateLimitMiddleware,
        authenticate("customer", ["session", "bearer"], { allowUnauthenticated: true }),
      ],
    },
    {
      method: ["POST"],
      matcher: "/store/payment-collections/:id/payment-sessions/stripe/refresh",
      middlewares: [authenticate("customer", ["session", "bearer"])],
    },
    {
      method: ["POST"],
      matcher: "/store/account/magic-links/revoke-all",
      middlewares: [authenticate("customer", ["session", "bearer"])],
    },
    {
      method: ["GET"],
      matcher: "/vendor/auth/sessions",
      middlewares: [authenticate("seller", ["bearer"])],
    },
    {
      method: ["POST"],
      matcher: "/vendor/magic-links/:jti/revoke",
      middlewares: [authenticate("seller", ["bearer"])],
    },
    {
      method: ["POST"],
      matcher: "/auth/user/emailpass",
      middlewares: [requestLogMetricsMiddleware],
    },
    // cc-4 F-01: /admin/operator/* GP operator surface MUST mount
    // authenticate("user") + operatorAuthMiddleware so audit `actor_id` is
    // always a real Medusa admin user, never the literal "admin" fallback,
    // and customer/vendor JWTs cannot reach the handlers via cookie collisions.
    {
      matcher: "/admin/operator/*",
      middlewares: [
        authenticate("user", ["session", "bearer"]),
        operatorAuthMiddleware,
        requestLogMetricsMiddleware,
      ],
    },
    {
      matcher: "/v1/admin/*",
      middlewares: [
        authenticate("user", ["session", "bearer"]),
        operatorAuthMiddleware,
      ],
    },
    // cleanup-15a: apply admin AuthN to all /admin/vendors/** POST routes.
    // Matcher "/admin/vendors/*" covers the actual Medusa 2 route paths
    // (NOT "/v1/admin/*" which covers the legacy v1 API prefix).
    {
      method: ["POST", "PATCH", "PUT", "DELETE"],
      matcher: "/admin/vendors/*",
      middlewares: [
        authenticate("user", ["session", "bearer"]),
        operatorAuthMiddleware,
      ],
    },
    // Story 2.5: admin-only lost-code recovery. POST /admin/entitlements/:id/reissue
    // requires an authenticated admin/market_operator session (AC1). Mirrors
    // /admin/vendors/* — authenticate("user") + operatorAuthMiddleware populates
    // auth_context.actor_id consumed by extractActorIdOrThrow in route.ts.
    {
      method: ["POST"],
      matcher: "/admin/entitlements/*",
      middlewares: [
        authenticate("user", ["session", "bearer"]),
        operatorAuthMiddleware,
      ],
    },
    {
      method: ["POST"],
      matcher: "/admin/magic-links/*",
      middlewares: [
        authenticate("user", ["session", "bearer"]),
        operatorAuthMiddleware,
      ],
    },
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
        requestLogMetricsMiddleware,
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
      // WYROWNANIE W GORE (decyzja PO 2026-08-01). Upstreamowy
      // `GET /store/orders/:id` jest BEZ `authenticate` — `order_id` dziala tam
      // jak capability, wiec kazdy, kto go zna, odczytuje pozycje i e-mail
      // kupujacej. Handler core niesie to jako otwarte pytanie ("TODO: Do we
      // want to apply some sort of authentication here?").
      //
      // `allowUnauthenticated`, bo checkout goscia nie zaklada konta: prog
      // egzekwuje guard (sesja ALBO dowod koszyka), a nie twarde `authenticate`,
      // ktore odcieloby kazdy zakup bez konta. Rozejscie z upstreamem jest
      // swiadome — patrz specs/constitution/upstream-policy.md (zero kontrybucji).
      method: ["GET"],
      matcher: "/store/orders/:id",
      middlewares: [
        authenticate("customer", ["session", "bearer"], { allowUnauthenticated: true }),
        upstreamOrderAccessGuardMiddleware,
      ],
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
    // Multi-vendor metadata augmentation (story v160-cleanup-12a).
    // Runs on /store/products (list) and /store/products/:id (detail).
    // Short-circuits immediately when feature-flag-tri-state oracle is not "on".
    {
      method: ["GET"],
      matcher: "/store/products",
      middlewares: [productListMarketScopeMiddleware, vendorMetaMiddleware],
    },
    {
      method: ["GET"],
      matcher: "/store/products/:id",
      // Story 2.4 (FR-14b, NFR-5): ochrona rynkowa MUSI poprzedzac
      // `vendorMetaMiddleware` — kolejnosc jest identyczna jak na liscie, bo oba
      // podmieniaja `res.json` i ostatni podmieniajacy owija poprzedniego.
      // Ochrona NIE moze wisiec na interceptorze `vendorMetaMiddleware`: przy
      // fladze `multi_vendor_pdp` != "on" robi on `return next()` PRZED jego
      // podpieciem i ochrona zniknelaby razem z flaga.
      middlewares: [productListMarketScopeMiddleware, vendorMetaMiddleware],
    },
  ],
});
