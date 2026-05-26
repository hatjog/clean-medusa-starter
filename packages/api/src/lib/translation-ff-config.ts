type EnvLike = Partial<Record<string, string | undefined>>

export const STORE_SUPPORTED_LOCALES = [
  { code: "pl-PL", name: "Polish (Poland)" },
  { code: "en-US", name: "English (United States)" },
  { code: "uk-UA", name: "Ukrainian (Ukraine)" },
  { code: "de-DE", name: "German (Germany)" },
] as const

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
] as const

export function isTranslationFeatureFlagEnabled(
  env: EnvLike = process.env
): boolean {
  return env.MEDUSA_FF_TRANSLATION?.trim().toLowerCase() === "true"
}

function isTranslationRollbackCommand(argv: readonly string[] = process.argv): boolean {
  return (
    argv.some((arg) => arg.includes("db:rollback")) &&
    argv.some((arg) => arg === "translation" || arg.includes("=translation"))
  )
}

export function buildTranslationModuleConfig(
  env: EnvLike = process.env,
  argv: readonly string[] = process.argv
) {
  if (!isTranslationFeatureFlagEnabled(env) && !isTranslationRollbackCommand(argv)) {
    return []
  }

  return [
    {
      key: "translation",
      resolve: "@medusajs/medusa/translation",
    },
  ]
}
