/**
 * Zod-validated environment configuration (IP-9)
 *
 * Centralized env var access — fail-fast at import if required vars are missing.
 * Business logic MUST import `config` from this module instead of using process.env.
 */

import { z } from "zod";

const envSchema = z.object({
  DATABASE_URL: z.string().min(1),
  GP_CORE_DATABASE_URL: z.string().min(1),
  MEDUSA_BACKEND_URL: z.string().url().default("http://localhost:9002"),
  STORE_CORS: z.string().min(1),
  REDIS_URL: z.string().min(1),
  MEDUSA_ADMIN_APIKEY: z.string().min(1),
});

export type EnvConfig = z.infer<typeof envSchema>;

function loadConfig(): EnvConfig {
  const result = envSchema.safeParse(process.env);

  if (!result.success) {
    const formatted = result.error.issues
      .map((i) => `  ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(
      `[GP config] Missing or invalid environment variables:\n${formatted}`,
    );
  }

  return result.data;
}

/** Validated environment configuration — fails fast at import time. */
export const config: EnvConfig = loadConfig();
