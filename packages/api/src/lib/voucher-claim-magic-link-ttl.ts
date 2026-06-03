/**
 * voucher-claim-magic-link-ttl — Story 7.4 (v1.11.0, ADR-138 DEC-1).
 *
 * Net-new TTL egzekucja dla magic-linka **voucher-claim** (token `claim_token`
 * na `entitlement_instance`). To JEDYNY net-new backend Stream A (AR-STREAMA-THIN).
 *
 * Kontekst (audyt ADR-138, Story 7.4 T1):
 *   - `entitlement_instance.expires_at` to wygaśnięcie **vouchera** (face value),
 *     NIE TTL magic-linka.
 *   - `claim_token_revoked_at` to ręczne unieważnienie (buyer-self revoke),
 *     NIE TTL.
 *   - Sam `claim_token` NIE miał TTL — link nie wygasał. Net-new = stempel
 *     `claim_token_issued_at` (migracja 1778930000000) + egzekucja okna TTL.
 *
 * Scope tokenów (KRYTYCZNE — ADR-138 DEC-1): ten TTL dotyczy WYŁĄCZNIE
 * voucher-claim magic-linka. Auth-login magic-link (storefront `(auth-recover)`
 * W3-05/W3-06) ma WŁASNY, ODRĘBNY scope i TTL — NIE wydłużać go ani nie ruszać.
 *
 * Default TTL = 24h (PM-2), konfigurowalny per-market. Balans: recipient claim
 * flow (ADR-112; prezent dla osoby trzeciej) potrzebuje okna na dostarczenie +
 * claim, ale ≤24h ogranicza okno ataku na scoped token.
 *
 * Rollback (feature-flag): `VOUCHER_CLAIM_MAGIC_LINK_TTL_ENABLED=false` ⇒ link
 * bez wygasania (poprzedni stan, przed tą story).
 */

/** Default TTL magic-linka voucher-claim w godzinach (ADR-138 DEC-1 / PM-2). */
export const DEFAULT_CLAIM_TOKEN_TTL_HOURS = 24

/** Górny bezpieczny limit (sanity) — odrzuca absurdalne konfiguracje. */
const MAX_CLAIM_TOKEN_TTL_HOURS = 24 * 365

type EnvLike = Record<string, string | undefined>

function readEnv(env?: EnvLike): EnvLike {
  return env ?? (process.env as EnvLike)
}

/**
 * Czy egzekucja TTL magic-linka voucher-claim jest włączona.
 *
 * Domyślnie WŁĄCZONA. Rollback przez `VOUCHER_CLAIM_MAGIC_LINK_TTL_ENABLED`
 * ustawione na jedną z wartości fałszu (`false`/`0`/`off`/`no`, case-insensitive)
 * ⇒ link nigdy nie wygasa (poprzedni stan).
 */
export function isClaimTokenTtlEnforced(env?: EnvLike): boolean {
  const raw = readEnv(env).VOUCHER_CLAIM_MAGIC_LINK_TTL_ENABLED
  if (raw == null) return true
  const v = raw.trim().toLowerCase()
  return !(v === "false" || v === "0" || v === "off" || v === "no")
}

/**
 * Rozwiązuje TTL (w godzinach) dla danego marketu.
 *
 * Kolejność precedencji:
 *   1. per-market override `VOUCHER_CLAIM_MAGIC_LINK_TTL_HOURS__<MARKET_UPPER>`
 *   2. globalny `VOUCHER_CLAIM_MAGIC_LINK_TTL_HOURS`
 *   3. {@link DEFAULT_CLAIM_TOKEN_TTL_HOURS} (24h)
 *
 * Wartości niepoprawne (≤0, NaN, > MAX) są ignorowane i degradują do następnego
 * źródła — fail-safe do 24h, nigdy do "bez wygasania" przez literówkę w env.
 */
export function resolveClaimTokenTtlHours(marketId?: string | null, env?: EnvLike): number {
  const e = readEnv(env)
  const candidates: Array<string | undefined> = []
  if (marketId && marketId.trim()) {
    const key = `VOUCHER_CLAIM_MAGIC_LINK_TTL_HOURS__${marketId.trim().toUpperCase().replace(/[^A-Z0-9]+/g, "_")}`
    candidates.push(e[key])
  }
  candidates.push(e.VOUCHER_CLAIM_MAGIC_LINK_TTL_HOURS)

  for (const raw of candidates) {
    if (raw == null) continue
    const parsed = Number(raw.trim())
    if (Number.isFinite(parsed) && parsed > 0 && parsed <= MAX_CLAIM_TOKEN_TTL_HOURS) {
      return parsed
    }
  }
  return DEFAULT_CLAIM_TOKEN_TTL_HOURS
}

/** Zamienia wartość kolumny `claim_token_issued_at` na epoch ms (lub null). */
export function toIssuedAtMs(issuedAt: Date | string | number | null | undefined): number | null {
  if (issuedAt == null) return null
  if (issuedAt instanceof Date) {
    const t = issuedAt.getTime()
    return Number.isFinite(t) ? t : null
  }
  if (typeof issuedAt === "number") {
    return Number.isFinite(issuedAt) ? issuedAt : null
  }
  const t = new Date(issuedAt).getTime()
  return Number.isFinite(t) ? t : null
}

export interface ClaimTokenExpiryInput {
  /** Wartość `entitlement_instance.claim_token_issued_at` (NULL = legacy/grandfather). */
  issuedAt: Date | string | number | null | undefined
  /** TTL w godzinach (z {@link resolveClaimTokenTtlHours}). */
  ttlHours: number
  /** "Teraz" w epoch ms (default Date.now()). */
  now?: number
  /** Czy egzekucja TTL jest włączona (z {@link isClaimTokenTtlEnforced}). */
  enforced?: boolean
}

/**
 * Czy magic-link voucher-claim wygasł (przekroczył okno TTL).
 *
 * Grandfather: gdy `issuedAt` jest NULL (legacy rows sprzed tej story — brak
 * stempla; brak baseline per ADR-138 M-4), link NIE wygasa. Nowo mintowane
 * tokeny dostają stempel `claim_token_issued_at` przez trigger DB, więc niosą
 * TTL od momentu wdrożenia. Gdy `enforced=false`, NIGDY nie wygasa (rollback).
 *
 * Funkcja czysta — to jest jednostkowo weryfikowalny rdzeń AC1-a (test-the-test:
 * link świeży ⇒ false; link wygasły ⇒ true).
 */
export function isClaimTokenExpired(input: ClaimTokenExpiryInput): boolean {
  const enforced = input.enforced ?? true
  if (!enforced) return false

  const issuedAtMs = toIssuedAtMs(input.issuedAt)
  if (issuedAtMs == null) return false // grandfather: brak stempla ⇒ bez wygasania

  const ttlMs = input.ttlHours * 60 * 60 * 1000
  if (!(ttlMs > 0)) return false

  const now = input.now ?? Date.now()
  return now > issuedAtMs + ttlMs
}

/** Moment wygaśnięcia magic-linka (epoch ms) lub null gdy nie dotyczy. */
export function claimTokenExpiryMs(
  issuedAt: Date | string | number | null | undefined,
  ttlHours: number
): number | null {
  const issuedAtMs = toIssuedAtMs(issuedAt)
  if (issuedAtMs == null) return null
  const ttlMs = ttlHours * 60 * 60 * 1000
  if (!(ttlMs > 0)) return null
  return issuedAtMs + ttlMs
}

/** Neutralny payload HTTP 410 (Gone) dla wygasłego magic-linka voucher-claim. */
export const EXPIRED_CLAIM_LINK_GONE_BODY = {
  type: "magic_link_expired",
  message: "This claim link has expired. Please request a new link.",
  state: "EXPIRED_LINK",
} as const
