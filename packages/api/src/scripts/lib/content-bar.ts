/**
 * AD-4 — kanoniczny moduł progów baru treści i pomiaru wordcount.
 *
 * KANONICZNA ŚCIEŻKA TEGO MODUŁU: `GP/backend/packages/api/src/scripts/lib/content-bar.ts`
 * (potwierdzona w Story 1.4 — notatki 4.2/4.3 zapisały ją błędnie jako
 * `GP/backend/scripts/lib/content-bar.ts`; taki plik nie istnieje i NIE wolno
 * go tworzyć). Backendowym korzeniem źródeł jest `packages/api/src`.
 *
 * To jest JEDYNE miejsce w repo, w którym żyją liczby 80 / 40 oraz JEDYNA
 * implementacja liczenia słów. Wszyscy konsumenci (sync `content_bar`,
 * pipeline gp-cli z FR-22, raport FR-23) MUSZĄ czytać stąd — bezpośrednim
 * importem (backend) albo przez wyjście JSON skryptu
 * `gp-config-content-bar` (gp-cli, patrz AD-13 „verby mogą wrapować").
 *
 * Powód istnienia: AD-4 zapobiega dryfowi „listing liczy inaczej niż sync".
 * Zduplikowanie literału progu albo drugiej implementacji `countContentWords`
 * jest naruszeniem AD-4 niezależnie od tego, jak niewinnie wygląda.
 *
 * Schemat materializacji (AD-4):
 *   metadata.gp.content_bar = { [localeSlug]: { words: int, bar: bool } }
 * gdzie `localeSlug` to slug routingu storefrontu (`pl`, `en`, `ua`, `de`),
 * NIE kod BCP 47. `checkQualityGate` w storefroncie czyta wyłącznie pole
 * `bar` i nigdy nie przelicza słów pobranego opisu.
 */

/**
 * Typy treści objęte barem. Zgodne z `EntityType` w
 * `gp-config-sync-i18n-content.ts` — celowo powielone jako osobny union, żeby
 * ten moduł nie ciągnął zależności od skryptu syncu (raport FR-23 i pipeline
 * importują sam bar, nie cały sync).
 */
export type ContentBarEntityType = "product" | "product_category" | "seller"

export const CONTENT_BAR_ENTITY_TYPES: readonly ContentBarEntityType[] = [
  "product",
  "product_category",
  "seller",
] as const

/**
 * Progi baru per typ treści (liczba słów).
 *
 * - `product`: 80 słów — ratyfikowane (PRD §F-E, glosariusz `bar-80`).
 * - `product_category` / `seller`: 40 słów — **[ASSUMPTION]**, ratyfikacja PO
 *   przez Story 4.1 (FR-21/FR-24). Do czasu decyzji Roberta wartość jest
 *   roboczą hipotezą, NIE ustaleniem. Zmiana = edycja tej jednej stałej.
 */
export const CONTENT_BAR_THRESHOLDS: Readonly<Record<ContentBarEntityType, number>> =
  Object.freeze({
    product: 80,
    // [ASSUMPTION — ratyfikacja PO w Story 4.1 (FR-21)]
    product_category: 40,
    // [ASSUMPTION — ratyfikacja PO w Story 4.1 (FR-21)]
    seller: 40,
  })

/**
 * Znacznik maszynowy dla konsumentów (raport FR-23, pipeline FR-22): które
 * progi są jeszcze hipotezą, a nie decyzją PO. Raport ma to pokazywać
 * operatorowi, żeby nikt nie brał 40 za ustalenie.
 */
export const CONTENT_BAR_THRESHOLD_ASSUMPTIONS: Readonly<
  Record<ContentBarEntityType, boolean>
> = Object.freeze({
  product: false,
  product_category: true,
  seller: true,
})

export class UnknownContentTypeError extends Error {
  readonly contentType: string

  constructor(contentType: string) {
    super(
      `Unknown content type '${contentType}'. Bar threshold is undefined for it. ` +
        `Known types: ${CONTENT_BAR_ENTITY_TYPES.join(", ")}. ` +
        `AD-4 forbids falling back to a default threshold — add the type to ` +
        `CONTENT_BAR_THRESHOLDS in packages/api/src/scripts/lib/content-bar.ts instead.`
    )
    this.name = "UnknownContentTypeError"
    this.contentType = contentType
  }
}

/**
 * Zwraca próg baru dla typu treści. Nieznany typ = fail-loud (AC5) — NIGDY
 * milczący default 80, bo to dokładnie ten dryf, przed którym broni AD-4.
 */
export function thresholdForContentType(contentType: string): number {
  const threshold = (CONTENT_BAR_THRESHOLDS as Record<string, number | undefined>)[
    contentType
  ]
  if (typeof threshold !== "number") {
    throw new UnknownContentTypeError(contentType)
  }
  return threshold
}

/**
 * Kanoniczna metoda liczenia słów.
 *
 * Reguła: słowo = maksymalny ciąg znaków nie-białych. Świadome decyzje:
 *   - `null`/`undefined`/nie-string → 0 (brak treści to nie błąd pomiaru),
 *   - białe znaki dowolnego rodzaju (spacje, taby, nowe linie, NBSP) są
 *     separatorem — YAML block scalar (`>-`) łamie opisy na linie,
 *   - myślnik i interpunkcja NIE dzielą słowa („anti-aging" = 1 słowo),
 *   - nic nie jest strippowane z markupu — opisy w gp-ops są plain textem.
 *
 * Ta funkcja jest jedynym źródłem prawdy dla wordcount. Pipeline (4.2)
 * i raport (4.3) NIE mogą mieć własnej — rozjazd pipeline vs `content_bar`
 * jest niedopuszczalny (AC5).
 */
export function countContentWords(value: unknown): number {
  if (typeof value !== "string") {
    return 0
  }
  const trimmed = value.trim()
  if (trimmed.length === 0) {
    return 0
  }
  // \s w JS obejmuje NBSP ( ) i inne unicode spaces — świadomie
  // korzystamy z tej semantyki zamiast własnej klasy znaków.
  return trimmed.split(/\s+/u).length
}

export interface ContentBarMeasurement {
  readonly words: number
  readonly bar: boolean
}

/**
 * Kształt materializowany do `metadata.gp.content_bar` (AD-4).
 * Klucz = slug routingu locale (`pl`, `en`, `ua`, `de`).
 */
export type ContentBarMap = Record<string, ContentBarMeasurement>

/**
 * Mapuje kod locale (BCP 47 albo już-slug) na slug routingu storefrontu.
 *
 * Storefront routuje po `/pl`, `/en`, `/ua`, `/de`; pliki gp-ops trzymają
 * `pl-PL`, `en-US`, `uk-UA`, `de-DE`. `uk-UA → ua` to jedyny nieoczywisty
 * przypadek (kod języka `uk` vs slug `ua`) i jest zgodny z aliasami
 * `localeAliases()` w `gp-config-sync-i18n-content.ts`.
 */
export function localeRoutingSlug(locale: string): string {
  const normalized = String(locale ?? "").trim().replace("_", "-")
  if (normalized.length === 0) {
    throw new Error("localeRoutingSlug: empty locale code")
  }
  const base = normalized.split("-")[0].toLowerCase()
  if (base === "uk" || base === "ua") {
    return "ua"
  }
  return base
}

/**
 * Mierzy bar dla pojedynczej treści.
 *
 * `bar` jest liczony w SYNC-TIME (AD-4) — storefront tylko czyta pole `bar`.
 */
export function measureContentBar(
  contentType: string,
  body: unknown
): ContentBarMeasurement {
  const threshold = thresholdForContentType(contentType)
  const words = countContentWords(body)
  return { words, bar: words >= threshold }
}

/**
 * Buduje mapę `content_bar` dla jednej encji z jej opisów per locale.
 *
 * @param contentType typ treści (decyduje o progu — fail-loud dla nieznanego)
 * @param bodiesByLocale opisy keyed po kodzie locale (BCP 47 albo slug)
 *
 * Locale bez opisu (brak klucza / pusty string) NADAL trafia do mapy z
 * `words: 0, bar: false` — brak wpisu i „wpis z zerem" znaczą dla gate'u to
 * samo, ale jawne zero jest czytelniejsze w raporcie FR-23 i nie każe
 * konsumentowi zgadywać, czy locale było w ogóle rozważane.
 */
export function buildContentBarMap(
  contentType: string,
  bodiesByLocale: Record<string, unknown>
): ContentBarMap {
  // Fail-loud zanim cokolwiek policzymy — nieznany typ nie może dać
  // częściowo wypełnionej mapy.
  thresholdForContentType(contentType)

  const out: ContentBarMap = {}
  for (const [locale, body] of Object.entries(bodiesByLocale ?? {})) {
    const slug = localeRoutingSlug(locale)
    const measurement = measureContentBar(contentType, body)
    const existing = out[slug]
    // Dwa kody locale mogą zmapować się na ten sam slug (np. `uk-UA` i `ua`).
    // Wygrywa dłuższy opis — deterministycznie i bez cichego nadpisania zerem.
    if (!existing || measurement.words > existing.words) {
      out[slug] = measurement
    }
  }
  return out
}
