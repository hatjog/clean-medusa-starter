type EnvLike = Partial<Record<string, string | undefined>>

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

export function isTranslationFeatureFlagEnabled(
  env: EnvLike = process.env
): boolean {
  return env.MEDUSA_FF_TRANSLATION?.trim().toLowerCase() === "true"
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
    !isTranslationFeatureFlagEnabled(env) &&
    !isTranslationRollbackOverrideEnabled(env) &&
    !isTranslationRollbackCommand(argv)
  ) {
    return []
  }

  return [
    {
      key: "translation",
      resolve: "@medusajs/medusa/translation",
    },
  ]
}
