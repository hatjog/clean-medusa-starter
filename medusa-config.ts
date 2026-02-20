import { loadEnv, defineConfig } from "@medusajs/framework/utils";

loadEnv(process.env.NODE_ENV || "development", process.cwd());

module.exports = defineConfig({
  admin: {
    disable: true,
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
      resolve: "@mercurjs/b2c-core",
      options: {},
    },
    {
      resolve: "@mercurjs/commission",
      options: {},
    },
    {
      resolve: "@mercurjs/reviews",
      options: {},
    },
    {
      resolve: "@mercurjs/requests",
      options: {},
    },
    {
      resolve: "@mercurjs/resend",
      options: {},
    },
  ],
  modules: {
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
