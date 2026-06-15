import type { MedusaRequest } from "@medusajs/framework/http";

type TranslationRecord = {
  reference_id?: string;
  translations?: Record<string, unknown> | null;
};

type TranslationModuleLike = {
  listTranslations: (
    filters: Record<string, unknown>
  ) => Promise<TranslationRecord[]>;
};

/**
 * Explicit translation overlay for custom Mercur module entities.
 *
 * The framework's `query.graph(..., { locale })` overlay decorates core
 * entities (product, product_category) but does NOT decorate custom module
 * entities such as `seller`, even though their model fields are declared
 * `.translatable()` and translation records exist. As a result seller
 * name/description shipped untranslated despite materialized UA/DE/EN content
 * (v1.12.0 UA-localization live-verify finding).
 *
 * This helper fetches the translation records for a given reference + locale
 * via the translation module's public service and returns a lookup map keyed
 * by `reference_id`, so callers can overlay the translatable fields onto their
 * own response shape.
 *
 * Fail-open: when the translation module is not registered (e.g.
 * `MEDUSA_FF_TRANSLATION` off) or no records exist (e.g. the default/source
 * locale `pl-PL`, which has no translation rows), an empty map is returned and
 * callers keep their base values.
 */
export async function fetchTranslationOverlay(
  scope: MedusaRequest["scope"],
  reference: string,
  referenceIds: string[],
  locale: string | undefined
): Promise<Map<string, Record<string, unknown>>> {
  const overlay = new Map<string, Record<string, unknown>>();

  if (!locale || referenceIds.length === 0) {
    return overlay;
  }

  let translationModule: TranslationModuleLike | undefined;
  try {
    translationModule = scope.resolve("translation") as TranslationModuleLike;
  } catch {
    // Translation module not registered (feature flag off) — no overlay.
    return overlay;
  }

  if (typeof translationModule?.listTranslations !== "function") {
    // Resolved to something without the expected API — fail open to base values.
    return overlay;
  }

  const records = await translationModule.listTranslations({
    reference,
    reference_id: referenceIds,
    locale_code: locale,
  });

  for (const record of records ?? []) {
    if (record?.reference_id && record.translations) {
      overlay.set(record.reference_id, record.translations);
    }
  }

  return overlay;
}

/**
 * Overlay a string-valued translatable field onto a target value.
 * Returns the translated value only when present and non-empty, otherwise the
 * existing base value (so an empty/absent translation never blanks content).
 */
export function overlayField(
  base: string | null,
  translations: Record<string, unknown> | undefined,
  field: string
): string | null {
  const value = translations?.[field];
  if (typeof value === "string" && value.trim().length > 0) {
    return value;
  }
  return base;
}
