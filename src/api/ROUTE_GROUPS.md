# Route Groups — GP Backend API

Formal SSOT for API route group definitions. Each group has distinct auth requirements, middleware stack, and rate-limiting policy.

Related files:
- middleware implementation: [middlewares.ts](middlewares.ts)
- middleware stack docs: [MIDDLEWARE_STACK.md](MIDDLEWARE_STACK.md)
- architecture reference: `_bmad-output/planning-artifacts/architecture-v1.2.0.md` (DD-25, PP-7)

## Route Groups

| Group | Routes | Auth | Middleware | Rate Limit | Status |
|-------|--------|------|-----------|------------|--------|
| **public** | `/v1/health`, `/status`, `/api/v1/entitlements/claim` | None | (future: rate-limit) | Yes (future) | Existing endpoints, no auth required |
| **storefront** | `/store/*` | Publishable API key | `marketContextMiddleware` → `marketGuardMiddleware` → `customerMarketGuardMiddleware` + route-specific overlays | Yes (future) | Fully implemented — see [MIDDLEWARE_STACK.md](MIDDLEWARE_STACK.md) |
| **vendor** | `/vendor/*` | Mercur seller auth (`withVendorAuth`) | Native Mercur middleware | No | Native Mercur — no explicit GP middleware needed |
| **admin** | `/admin/*`, `/api/v1/admin/*` | Medusa admin auth (`withOperatorAuth`) | Native Medusa middleware | No | Native Medusa — no explicit GP middleware needed |

## Auth Details

### Public Group
- No authentication required
- Rate limiting planned (Story 9-1, Epic 3+)
- Health endpoint: `GET /v1/health` → 200

### Storefront Group
- Publishable API key in `x-publishable-api-key` header
- Market context resolved from key → sales_channel → market_id
- RLS pool hook installed for data isolation
- Fail-closed: missing market context → 403
- Full middleware chain documented in [MIDDLEWARE_STACK.md](MIDDLEWARE_STACK.md)

### Vendor Group
- Mercur native seller authentication (`withVendorAuth`)
- GP routes under `/vendor/*`: entitlement verify/redeem
- Spike-dependent: if Mercur seller auth works for gp_core → use native; otherwise custom auth (DD-25)
- No explicit middleware in GP `middlewares.ts` — handled by Mercur framework

### Admin/Operator Group
- Medusa native admin authentication (`withOperatorAuth`)
- Admin panel routes: `/admin/*`
- GP custom admin routes: `/api/v1/admin/*`
- No explicit middleware in GP `middlewares.ts` — handled by Medusa framework

## Notes

- Route groups are de facto implemented by framework (Medusa/Mercur). This document formalizes the architecture.
- Vendor auth middleware implementation depends on architecture spikes (Epic 3+).
- Rate limiting is out of scope for Sprint 0 — planned in Story 9-1.
- When adding new routes, determine group membership and apply appropriate auth/middleware.
