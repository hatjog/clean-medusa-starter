import { loadEnv, defineConfig } from "@medusajs/framework/utils";

loadEnv(process.env.NODE_ENV || "development", process.cwd());

// Story v160-1-7 — Mercur 2 native mechanisms wire-up. We skip the
// `@mercurjs/core/with-mercur` wrapper because it forces an array-shaped
// `modules` config; our existing record-shaped form is still valid in Medusa
// 2.13.6 and avoids a config-shape migration mid-rebase. Wrapper-equivalent
// effects are preserved manually: the `@mercurjs/core` plugin is added to
// `plugins[]`, the `@medusajs/medusa/rbac` module is registered, and
// `featureFlags.rbac` is set to `true`. If a future Medusa minor drops record
// modules support, swap to `withMercur({...})` and convert modules to array form.

module.exports = defineConfig({
  admin: {
    disable: true,
  },
  featureFlags: {
    rbac: true,
  },
  projectConfig: {
    databaseUrl: process.env.DATABASE_URL,
    redisUrl: process.env.REDIS_URL,
    http: {
      storeCors: process.env.STORE_CORS!,
      adminCors: process.env.ADMIN_CORS!,
      // @ts-expect-error: vendorCors is not part of the typed config yet, but is supported by MercurJS.
      vendorCors: process.env.VENDOR_CORS!,
      authCors: process.env.AUTH_CORS!,
      jwtSecret: process.env.JWT_SECRET || "supersecret",
      cookieSecret: process.env.COOKIE_SECRET || "supersecret",
    },
  },
  plugins: [
    {
      resolve: "@mercurjs/core",
      options: {},
    },
  ],
  modules: {
    gp_core: {
      resolve: "./packages/api/src/modules/gp-core",
      options: {
        databaseUrl: process.env.GP_CORE_DATABASE_URL,
        mercurDatabaseUrl: process.env.GP_MERCUR_DATABASE_URL || process.env.DATABASE_URL,
      },
    },
    rbac: {
      resolve: "@medusajs/medusa/rbac",
    },
    event_bus: {
      resolve: "@medusajs/event-bus-redis",
      options: {
        redisUrl: process.env.REDIS_URL,
      },
    },
    locking: {
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
  },
});
