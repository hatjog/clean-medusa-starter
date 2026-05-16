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

loadEnv(process.env.NODE_ENV || "development", process.cwd());

// Medusa 2.13.x module loader prepends `src/` to relative resolve paths.
// Post-restructure (story v160-1-4) modules live at packages/api/src/, so we
// resolve absolute via `path.resolve(__dirname, ...)` to bypass implicit
// `src/` base (story v160-1-8 Patch #2).
const moduleRoot = (subpath: string) =>
  path.resolve(__dirname, "packages/api/src/modules", subpath);

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
            resolve: "@medusajs/payment-stripe",
            options: {
              apiKey: process.env.STRIPE_SECRET_KEY_BONBEAUTY,
              webhookSecret: process.env.STRIPE_WEBHOOK_KEY_BONBEAUTY,
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
