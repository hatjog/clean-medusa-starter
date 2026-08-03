/**
 * notification-formatting.ts — deterministyczne formatowanie wartości maili
 * voucherowych (Story 5.7, AC3/AC4).
 *
 * ── Dlaczego nie `Intl` ─────────────────────────────────────────────────────
 * `Intl.DateTimeFormat`/`NumberFormat` zależą od wersji ICU wbudowanej w
 * konkretny runtime Node'a: ta sama wartość potrafi wyjść jako `11.05.2027`
 * albo `11/05/2027` na dwóch hostach, a separator tysięcy bywa NBSP-em, który
 * w mailu HTML wygląda jak śmieć. Kontrakt 5.7 mówi „format jawnie testowany
 * dla locale", więc formatowanie jest ręczne, czyste i w pełni deterministyczne.
 *
 * ── Strefa czasu ────────────────────────────────────────────────────────────
 * Daty prezentowane w mailu to daty kalendarzowe (data zakupu, „Ważny do"), a
 * nie znaczniki czasu, więc liczymy je w UTC. Bez ustalonej strefy ten sam
 * voucher pokazywałby dwie różne daty w zależności od hosta wysyłki.
 */

/** Locale, w których data ma kształt `DD.MM.RRRR`; reszta dostaje ISO `RRRR-MM-DD`. */
const DOTTED_DATE_LOCALES = new Set(["pl", "de", "ua"])
/** Locale z przecinkiem dziesiętnym; reszta dostaje kropkę. */
const COMMA_DECIMAL_LOCALES = new Set(["pl", "de", "ua"])

function localeRoot(locale: string): string {
  return locale.trim().toLowerCase().split(/[-_]/)[0] ?? ""
}

/**
 * `2027-05-11T00:00:00.000Z` → `11.05.2027` (pl/de/ua) albo `2027-05-11` (en).
 * Zwraca `null` dla wartości nieparsowalnej — wołający ma wtedy zgłosić brak
 * pokrycia kontraktu, nie wstawić do maila pusty string albo `Invalid Date`.
 */
export function formatDateForLocale(
  value: string | Date | null | undefined,
  locale: string,
): string | null {
  if (value === null || value === undefined) return null

  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) return null

  const year = String(date.getUTCFullYear()).padStart(4, "0")
  const month = String(date.getUTCMonth() + 1).padStart(2, "0")
  const day = String(date.getUTCDate()).padStart(2, "0")

  return DOTTED_DATE_LOCALES.has(localeRoot(locale))
    ? `${day}.${month}.${year}`
    : `${year}-${month}-${day}`
}

/**
 * Minor units → tekst kwoty BEZ symbolu waluty (`voucher_currency` jest osobną
 * zmienną manifestu): `20000` → `200,00` (pl/de/ua) albo `200.00` (en).
 *
 * Akceptuje `string`, bo sterownik `pg` zwraca kolumny `numeric` jako łańcuchy
 * — `typeof value === "number"` cicho degradowałoby prawdziwą kwotę do
 * fallbacku (klasa defektu ADR-166 R-1). Wartość nieliczbowa → `null`.
 */
export function formatMinorAmountForLocale(
  minor: unknown,
  locale: string,
): string | null {
  const numeric =
    typeof minor === "number"
      ? minor
      : typeof minor === "string" && minor.trim().length > 0
        ? Number(minor)
        : Number.NaN

  if (!Number.isFinite(numeric)) return null

  const negative = numeric < 0
  const absolute = Math.abs(Math.round(numeric))
  const units = Math.floor(absolute / 100)
  const cents = String(absolute % 100).padStart(2, "0")
  const separator = COMMA_DECIMAL_LOCALES.has(localeRoot(locale)) ? "," : "."

  return `${negative ? "-" : ""}${units}${separator}${cents}`
}

/** Składniki adresu salonu, tak jak leżą w `seller_address`. */
export type SalonAddressParts = {
  address_1?: string | null
  address_2?: string | null
  postal_code?: string | null
  city?: string | null
}

/**
 * `ul. Handlowa 10` + `00-001` + `Warszawa` → `ul. Handlowa 10, 00-001 Warszawa`.
 *
 * Zwraca `null`, gdy nie ma ANI ulicy, ANI miasta — adres złożony z samego kodu
 * pocztowego nie jest adresem, do którego można pójść, a mail obiecuje „gdzie
 * zrealizować voucher".
 */
export function formatSalonAddress(
  parts: SalonAddressParts | null | undefined,
): string | null {
  if (!parts) return null

  const street = [parts.address_1, parts.address_2]
    .map((value) => value?.trim())
    .filter((value): value is string => Boolean(value))
    .join(" ")
  const city = [parts.postal_code, parts.city]
    .map((value) => value?.trim())
    .filter((value): value is string => Boolean(value))
    .join(" ")

  if (!street.trim() && !parts.city?.trim()) return null

  const formatted = [street, city]
    .map((value) => value.trim())
    .filter((value) => value.length > 0)
    .join(", ")

  return formatted.length > 0 ? formatted : null
}
