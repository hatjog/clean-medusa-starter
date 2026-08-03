import path from "node:path";
import { loadEnv } from "@medusajs/framework/utils";
// Story v160-1-7-1: real `withMercur(defineConfig(...))` wrapper. Replaces
// the manual withMercur-equivalent introduced w story v160-1-7 (Opcja B
// sharpened). Story v160-1-10 SMOKE GATE attempt confirmed manual approach
// nie odtwarza pełnej Mercur 2 plugin lifecycle (Signals 3+4 — Product.seller
// MikroORM relation missing; module links nie loaded). Real wrapper handles
// plugin registration + module links + entity extensions per Mercur 2
// upstream convention.
//
// Required: modules ARRAY form (wrapper iterates `.some()` on config.modules).
// Conversion z record → array w tej commit.
import { withMercur } from "@mercurjs/core/with-mercur";
import { buildTranslationModuleConfig } from "./packages/api/src/lib/translation-ff-config";

loadEnv(process.env.NODE_ENV || "development", process.cwd());

// Medusa 2.13.x module loader prepends `src/` to relative resolve paths.
// Post-restructure (story v160-1-4) modules live at packages/api/src/, so we
// resolve absolute via `path.resolve(__dirname, ...)` to bypass implicit
// `src/` base (story v160-1-8 Patch #2).
const moduleRoot = (subpath: string) =>
  path.resolve(__dirname, "packages/api/src/modules", subpath);
const translationModules = buildTranslationModuleConfig(process.env, process.argv);

module.exports = withMercur({
  // admin.disable defaults to true via withMercur wrapper (still set explicit
  // for clarity); admin Vite/static panel is Sprint 2 territory.
  admin: {
    disable: true,
  },
  projectConfig: {
    databaseUrl: process.env.DATABASE_URL,
    redisUrl: process.env.REDIS_URL,
    http: {
      storeCors: process.env.STORE_CORS!,
      adminCors: process.env.ADMIN_CORS!,
      vendorCors: process.env.VENDOR_CORS!,
      authCors: process.env.AUTH_CORS!,
      jwtSecret: process.env.JWT_SECRET || "supersecret",
      cookieSecret: process.env.COOKIE_SECRET || "supersecret",
    },
  },
  // withMercur auto-adds `@mercurjs/core` plugin if not present — explicit
  // entry retained for visibility.
  plugins: [
    {
      resolve: "@mercurjs/core",
      options: {},
    },
  ],
  // Modules ARRAY form (Mercur 2 convention). withMercur auto-appends
  // `@medusajs/medusa/rbac` if not in the array (we omit explicit rbac entry
  // and let wrapper handle it).
  modules: [
    {
      key: "payment",
      resolve: "@medusajs/payment",
      options: {
        providers: [
          {
            // v1.9.1 wg7 F-CC1-001 fix: switch from bare @medusajs/payment-stripe
            // to the GP wrapper that routes apiKey/webhookSecret resolution
            // through SecretsAdapter + createMarketStripeResolver. The wrapper
            // re-exports StripeProviderService/BlikService/Przelewy24Service
            // with a lazy-init constructor that exercises the per-market gate
            // (STRIPE_ENABLED_MARKETS) and the env-var contract before any
            // Stripe SDK init. v1.9.x BonBeauty-only; v1.10.0+ extends to
            // per-request market resolution via cart.metadata.market_id
            // (ra-CC1-001 carry-out from ADR-100 amendment 2026-05-24).
            // See: GP/backend/packages/api/src/modules/payment-stripe-multi-market/
            //      specs/adr/2026-05-14-adr-100-stripe-provider-per-market-resolver.md
            resolve: moduleRoot("payment-stripe-multi-market"),
            // v1.9.0 wf5 F-CC1-008 / H-5 fix: pin explicit `id: "stripe"` so
            // the runtime provider key is `pp_stripe` (Medusa convention:
            // `pp_<id>`) and matches `GP/config/gp-dev/markets/bonbeauty/
            // market.yaml#psp_provider_id`. Without this, Medusa generates a
            // plugin-name-derived id (`pp_stripe_stripe`) which diverges from
            // the storefront `isStripe()` check and the retry-route default.
            // Pinning here makes the single canonical id literal `pp_stripe`.
            id: "stripe",
            options: {
              // marketId omitted → defaults to "bonbeauty" (v1.9.x BonBeauty-
              // only scope). v1.10.0+ multi-market activation will either pin
              // per-provider here OR override per-request inside the wrapper.
              // apiKey + webhookSecret are intentionally NOT read here — the
              // wrapper resolves them via SecretsAdapter at first method call.
              capture: true,
            },
          },
        ],
      },
    },
    {
      // Story v160-cleanup-25: PG-backed voucher module (replaces in-memory
      // voucher-fixture-store.ts). Registered under key "voucher" per AC1.
      key: "voucher",
      resolve: moduleRoot("voucher"),
    },
    {
      key: "gp_core",
      resolve: moduleRoot("gp-core"),
      options: {
        databaseUrl: process.env.GP_CORE_DATABASE_URL,
        mercurDatabaseUrl: process.env.GP_MERCUR_DATABASE_URL || process.env.DATABASE_URL,
      },
    },
    ...translationModules,
    // Mercur 2 admin_ui + vendor_ui dashboard modules disabled dla Phase A1
    // (frontend panels = Sprint 2 territory; bez disable Mercur 2
    // dashboardMiddleware crashes na "TypeError: app is not a function").
    {
      key: "admin_ui",
      resolve: "@mercurjs/core/modules/admin-ui",
      options: { disable: true },
    },
    {
      key: "vendor_ui",
      resolve: "@mercurjs/core/modules/vendor-ui",
      options: { disable: true },
    },
    {
      // v1.14.0 Story 2.2 (FR-12, NFR8; AD-5/AD-6): JEDNA produkcyjna ścieżka
      // wysyłki e-mail. Do tej story moduł Notification NIE był zarejestrowany,
      // więc część call-site'ów była cichym no-opem (inwentaryzacja Story 2.1).
      //
      // Provider to CIENKI WRAPPER interfejsu notification-providera Medusy
      // (packages/api/src/modules/notification-brevo) delegujący do
      // DefaultMessagingGateway → BrevoAdapter z @gp/messaging. Mapa `templates`
      // pochodzi WYŁĄCZNIE z rejestru specs/contracts/notifications/templates.yaml
      // (AD-6 allowlist) — klucz spoza rejestru kończy się fail-loud
      // BREVO_TEMPLATE_NOT_CONFIGURED, nigdy cichym no-opem.
      //
      // `id: "brevo"` pinowany jawnie → runtime key `np_brevo`
      // (NotificationProviderRegistrationPrefix + id). Bez tego powstałby
      // identyfikator pochodny od nazwy pluginu — ta sama klasa regresji, której
      // pilnuje `id: "stripe"` w module payment (`pp_stripe` vs `pp_stripe_stripe`).
      //
      // BREVO_API_KEY / BREVO_SENDERS są celowo NIEobecne w tym configu: sekret i
      // dane operacyjne rozwiązuje wrapper leniwie z env przy pierwszej wysyłce,
      // więc brak konfiguracji NIE wywraca bootu backendu.
      key: "notification",
      resolve: "@medusajs/notification",
      options: {
        providers: [
          {
            resolve: moduleRoot("notification-brevo"),
            id: "brevo",
            options: {
              channels: ["email"],
            },
          },
          {
            // Zachowany default Medusy (`defineConfig` rejestruje moduł
            // notification z providerem `notification-local` na kanale `feed`).
            // Jawny wpis modułu ZASTĘPUJE cały default, więc bez tej linii
            // kanał `feed` cicho by zniknął. `validateProviders` wymaga, by dwa
            // providery nie dzieliły kanału — `feed` vs `email` się nie kolidują.
            resolve: "@medusajs/medusa/notification-local",
            id: "local",
            options: {
              name: "Local Notification Provider",
              channels: ["feed"],
            },
          },
        ],
      },
    },
    {
      key: "event_bus",
      resolve: "@medusajs/event-bus-redis",
      options: {
        redisUrl: process.env.REDIS_URL,
      },
    },
    {
      key: "locking",
      resolve: "@medusajs/medusa/locking",
      options: {
        providers: [
          {
            resolve: "@medusajs/locking-redis",
            id: "redis",
            is_default: true,
            options: {
              redisUrl: process.env.REDIS_URL,
            },
          },
        ],
      },
    },
  ],
});
