type EnvLike = Partial<Record<string, string | undefined>>

export type TranslationFeatureFlagEnvironment =
  | "production"
  | "staging"
  | "test"
  | "dev"

export type TranslationFeatureFlagPolicyResolution = {
  environment: TranslationFeatureFlagEnvironment
  enabled: boolean
  source: "env-override" | "policy-default"
  reason: string
}

const TRANSLATION_MODULE_CONFIG = [
  {
    key: "translation",
    resolve: "@medusajs/medusa/translation",
  },
]

const TRANSLATION_FF_POLICY: Record<
  TranslationFeatureFlagEnvironment,
  { enabled: boolean; reason: string }
> = {
  production: {
    enabled: true,
    reason: "ADR-126 release policy: Translation Module enabled in production.",
  },
  staging: {
    enabled: true,
    reason: "ADR-126 parity: staging/canary follow production translation runtime.",
  },
  test: {
    enabled: true,
    reason: "ADR-151/E5 prerequisite: visual regression sweep requires FF=on.",
  },
  dev: {
    enabled: false,
    reason: "Local dev is configurable; default OFF avoids implicit schema activation.",
  },
}

export const TRANSLATION_ENTITY_SETTINGS = [
  {
    story_label: "product",
    entity_type: "product",
    fields: ["title", "subtitle", "description", "material"],
  },
  {
    story_label: "product_category",
    entity_type: "product_category",
    fields: ["name", "description"],
  },
  {
    story_label: "product_type",
    entity_type: "product_type",
    fields: ["value"],
  },
  {
    story_label: "product_variant",
    entity_type: "product_variant",
    fields: ["title", "material"],
  },
  {
    story_label: "collection",
    entity_type: "product_collection",
    fields: ["title"],
  },
  {
    story_label: "seller",
    entity_type: "seller",
    fields: ["name", "description"],
  },
] as const

function readEnv(env: EnvLike, key: string): string | undefined {
  const value = env[key]?.trim()
  return value ? value : undefined
}

function normalizePolicyEnvironment(
  value: string | undefined
): TranslationFeatureFlagEnvironment | null {
  switch (value?.trim().toLowerCase()) {
    case "production":
    case "prod":
      return "production"
    case "staging":
    case "stage":
    case "canary":
      return "staging"
    case "test":
      return "test"
    case "development":
    case "develop":
    case "local":
    case "dev":
      return "dev"
    default:
      return null
  }
}

function resolvePolicyEnvironment(env: EnvLike): TranslationFeatureFlagEnvironment {
  const rawEnvironment =
    readEnv(env, "GP_ENV") ?? readEnv(env, "MEDUSA_STAGE") ?? readEnv(env, "NODE_ENV")
  const environment = normalizePolicyEnvironment(rawEnvironment)

  if (!environment) {
    throw new Error(
      "Unsupported MEDUSA_FF_TRANSLATION environment. Set GP_ENV, MEDUSA_STAGE, or NODE_ENV to one of: production, staging, test, dev."
    )
  }

  return environment
}

function parseBooleanOverride(value: string | undefined): boolean | null {
  if (value === undefined) {
    return null
  }

  switch (value.trim().toLowerCase()) {
    case "true":
    case "1":
    case "on":
    case "yes":
      return true
    case "false":
    case "0":
    case "off":
    case "no":
      return false
    default:
      throw new Error(
        `Invalid MEDUSA_FF_TRANSLATION value "${value}". Use true/false.`
      )
  }
}

export function resolveTranslationFeatureFlagPolicy(
  env: EnvLike = process.env
): TranslationFeatureFlagPolicyResolution {
  const environment = resolvePolicyEnvironment(env)
  const override = parseBooleanOverride(readEnv(env, "MEDUSA_FF_TRANSLATION"))

  if (override !== null) {
    if (override === false && environment !== "dev") {
      throw new Error(
        `MEDUSA_FF_TRANSLATION cannot be disabled by MEDUSA_FF_TRANSLATION=false in ${environment}. Use the explicit rollback path instead.`
      )
    }

    return {
      environment,
      enabled: override,
      source: "env-override",
      reason: "Explicit MEDUSA_FF_TRANSLATION env override.",
    }
  }

  const policy = TRANSLATION_FF_POLICY[environment]
  return {
    environment,
    enabled: policy.enabled,
    source: "policy-default",
    reason: policy.reason,
  }
}

export function isTranslationFeatureFlagEnabled(
  env: EnvLike = process.env
): boolean {
  return resolveTranslationFeatureFlagPolicy(env).enabled
}

function isTranslationRollbackOverrideEnabled(
  env: EnvLike = process.env
): boolean {
  return env.MEDUSA_TRANSLATION_ROLLBACK?.trim().toLowerCase() === "true"
}

function readModuleFlag(argv: readonly string[]): string | null {
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === "--module") {
      return argv[index + 1] ?? null
    }
    if (arg.startsWith("--module=")) {
      return arg.slice("--module=".length)
    }
  }

  return null
}

function isTranslationRollbackCommand(argv: readonly string[] = process.argv): boolean {
  const isRollback = argv.some((arg) => arg === "db:rollback")
  if (!isRollback) {
    return false
  }

  const moduleName = readModuleFlag(argv)
  if (moduleName === "translation" || moduleName === "@medusajs/translation") {
    return true
  }

  throw new Error(
    "Unsupported translation rollback command. Use MEDUSA_TRANSLATION_ROLLBACK=true or medusa db:rollback --module translation."
  )
}

export function buildTranslationModuleConfig(
  env: EnvLike = process.env,
  argv: readonly string[] = process.argv
) {
  if (
    !isTranslationRollbackOverrideEnabled(env) &&
    !isTranslationRollbackCommand(argv) &&
    !isTranslationFeatureFlagEnabled(env)
  ) {
    return []
  }

  return TRANSLATION_MODULE_CONFIG
}
