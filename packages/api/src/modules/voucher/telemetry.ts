import type { VatClassification } from "./vat-resolver"

export const LNE_THRESHOLD_EUR_MINOR = 100_000_000
export const LNE_EARLY_WARN_RATIO = 0.8

export type VoucherTelemetryLifecycle = "ISSUED" | "REDEEMED" | "EXPIRED"

export type VoucherTelemetryEvent = {
  event_type?: string
  entry_type?: string
  occurred_at?: string
  posting_profile?: string
  vat_classification?: VatClassification
  lifecycle_event?: VoucherTelemetryLifecycle | string
  entitlement_id?: string
  issued_at?: string
  redeemed_at?: string
  currency?: string
  amount_minor?: number
  gross_minor?: number
  /** Brutto wyemitowane vouchera (face value) — alias źródła wolumenu LNE; patrz `voucher.value_minor`. */
  face_value_minor?: number
  /** Wartość vouchera w minor units (`voucher.value_minor`) — alias brutto. */
  value_minor?: number
  is_lne?: boolean
  lne?: boolean
  regulatory_model?: string
  voucher_code?: string
  customer_id?: string
  metadata?: Record<string, unknown>
  payload?: Record<string, unknown>
  [key: string]: unknown
}

export type RedemptionVelocityBucket = {
  label: string
  upper_bound_ms: number | null
  count: number
}

export type RedemptionVelocityResult = {
  profile: string
  count: number
  unredeemed_count: number
  min_ms: number | null
  max_ms: number | null
  avg_ms: number | null
  percentiles_ms: {
    p50: number | null
    p90: number | null
  }
  buckets: RedemptionVelocityBucket[]
  data_quality: {
    invalid_event_count: number
    unmatched_redeem_count: number
  }
}

export type RollingVolumeLNEResult = {
  profile: string
  window: {
    start_at: string
    /**
     * Okno rolling-12m jest PÓŁOTWARTE `(start, asOf]` — początek EKSKLUZYWNY,
     * koniec INKLUZYWNY (standard rolling-window). Dzięki temu event dokładnie na
     * granicy `windowStart` NIE jest liczony dwukrotnie w dwóch sąsiednich
     * przebiegach raportowania (eliminuje double-count w czasie; review MEDIUM).
     */
    start_inclusive: false
    end_at: string
    end_inclusive: true
  }
  volume: {
    currency: "EUR"
    minor: number
  }
  threshold: {
    currency: "EUR"
    minor: number
  }
  ratio: number
  early_warn: boolean
  alert: boolean
  events_included_count: number
  data_quality: {
    /**
     * Eventy bez `posting_profile` doliczone do KAŻDEGO odpytywanego profilu
     * (fail-safe: niejasny profil nie ukrywa wolumenu). Licznik jest ROZŁĄCZNY —
     * konsument (6.4) sumujący wolumeny per-profil MUSI odjąć te eventy, by
     * uniknąć cross-profil over-count (review LOW).
     */
    ambiguous_profile_included_count: number
    ambiguous_lne_scope_included_count: number
    ambiguous_lifecycle_included_count: number
    ambiguous_currency_included_count: number
    non_eur_currency_included_count: number
    /** Eventy non-EUR przeliczone na EUR po wstrzykniętym kursie referencyjnym. */
    fx_converted_count: number
    /** Eventy non-EUR BEZ dostępnego kursu FX → fail-safe (alert), NIE sumowane jako EUR. */
    non_eur_missing_fx_count: number
    unknown_timestamp_included_count: number
    fail_safe_missing_amount_count: number
    /** Duplikaty ISSUED (ten sam `entitlement_id`) pominięte — replay-safe, spójne z velocity. */
    duplicate_issued_skipped_count: number
    explicit_non_lne_excluded_count: number
    events_outside_window_count: number
    events_skipped_profile_count: number
  }
}

export type RedemptionVelocityOptions = {
  profile: string
  bucket_edges_ms?: readonly number[]
}

export type RollingVolumeLNEOptions = {
  profile: string
  asOf: string | number | Date
  threshold_minor?: number
  early_warn_ratio?: number
  /**
   * Tabela kursów referencyjnych do EUR (DI — deterministyczna, np. EBC/NBP na
   * `asOf`): `{ "PLN": 0.23, "GBP": 1.17 }` = wartość 1 jednostki waluty w EUR.
   * Próg LNE jest stricte EUR (ADR-134), platforma operuje domyślnie w PLN, więc
   * kwoty non-EUR MUSZĄ być przeliczone PRZED sumowaniem. Założenie: jednakowa
   * liczba miejsc po przecinku (minor exponent = 2) dla EUR/PLN/GBP — kurs major
   * stosowany wprost do minor units. Brak kursu dla waluty non-EUR (lub waluta
   * nieznana/`null`) ⇒ event NIE jest sumowany jako EUR, lecz wymusza fail-safe
   * (alert) — nigdy ciche dodanie groszy jako eurocentów (review HIGH-2/VER-H1).
   */
  fx_rates_to_eur?: Readonly<Record<string, number>>
}

const DAY_MS = 24 * 60 * 60 * 1000

const DEFAULT_BUCKET_EDGES_MS = Object.freeze([
  DAY_MS,
  7 * DAY_MS,
  30 * DAY_MS,
  90 * DAY_MS,
  180 * DAY_MS,
  365 * DAY_MS,
] as const)

type NormalizedEvent = {
  lifecycle: VoucherTelemetryLifecycle | null
  profile: string | null
  entitlementId: string | null
  timestampMs: number | null
  amountMinor: number | null
  currency: string | null
  lne: "yes" | "no" | "unknown"
  isCompletedRedeem: boolean
}

export function redemptionVelocity(
  events: readonly VoucherTelemetryEvent[],
  options: RedemptionVelocityOptions
): RedemptionVelocityResult {
  const issued = new Map<string, number>()
  const completedRedeems = new Map<string, number>()
  let invalidEventCount = 0
  let unmatchedRedeemCount = 0

  for (const event of events) {
    const normalized = normalizeEvent(event)

    if (normalized.profile !== options.profile) {
      continue
    }

    if (
      !normalized.lifecycle ||
      !normalized.entitlementId ||
      normalized.timestampMs == null
    ) {
      invalidEventCount += 1
      continue
    }

    if (normalized.lifecycle === "ISSUED") {
      const current = issued.get(normalized.entitlementId)
      if (current == null || normalized.timestampMs < current) {
        issued.set(normalized.entitlementId, normalized.timestampMs)
      }
      continue
    }

    if (normalized.lifecycle === "REDEEMED" && normalized.isCompletedRedeem) {
      const current = completedRedeems.get(normalized.entitlementId)
      if (current == null || normalized.timestampMs < current) {
        completedRedeems.set(normalized.entitlementId, normalized.timestampMs)
      }
    }
  }

  const durations: number[] = []
  let unredeemedCount = 0

  for (const [entitlementId, issuedAtMs] of issued.entries()) {
    const redeemedAtMs = completedRedeems.get(entitlementId)
    if (redeemedAtMs == null) {
      unredeemedCount += 1
      continue
    }

    const duration = redeemedAtMs - issuedAtMs
    if (duration < 0) {
      invalidEventCount += 1
      continue
    }

    durations.push(duration)
  }

  for (const entitlementId of completedRedeems.keys()) {
    if (!issued.has(entitlementId)) {
      unmatchedRedeemCount += 1
    }
  }

  durations.sort((a, b) => a - b)

  return {
    profile: options.profile,
    count: durations.length,
    unredeemed_count: unredeemedCount,
    min_ms: durations[0] ?? null,
    max_ms: durations.length > 0 ? durations[durations.length - 1] : null,
    avg_ms:
      durations.length > 0
        ? durations.reduce((sum, duration) => sum + duration, 0) /
          durations.length
        : null,
    percentiles_ms: {
      p50: nearestRankPercentile(durations, 50),
      p90: nearestRankPercentile(durations, 90),
    },
    buckets: histogramBuckets(
      durations,
      options.bucket_edges_ms ?? DEFAULT_BUCKET_EDGES_MS
    ),
    data_quality: {
      invalid_event_count: invalidEventCount,
      unmatched_redeem_count: unmatchedRedeemCount,
    },
  }
}

export function rollingVolumeLNE(
  events: readonly VoucherTelemetryEvent[],
  options: RollingVolumeLNEOptions
): RollingVolumeLNEResult {
  const asOfMs = parseInstantMs(options.asOf)
  if (asOfMs == null) {
    throw new Error("rollingVolumeLNE requires a valid asOf instant")
  }

  const thresholdMinor = options.threshold_minor ?? LNE_THRESHOLD_EUR_MINOR
  if (!Number.isInteger(thresholdMinor) || thresholdMinor <= 0) {
    throw new Error("rollingVolumeLNE threshold_minor must be a positive integer")
  }

  const earlyWarnRatio =
    options.early_warn_ratio ?? LNE_EARLY_WARN_RATIO
  if (!Number.isFinite(earlyWarnRatio) || earlyWarnRatio < 0) {
    throw new Error("rollingVolumeLNE early_warn_ratio must be non-negative")
  }

  const windowStartMs = subtractUtcMonths(asOfMs, 12)
  const dataQuality: RollingVolumeLNEResult["data_quality"] = {
    ambiguous_profile_included_count: 0,
    ambiguous_lne_scope_included_count: 0,
    ambiguous_lifecycle_included_count: 0,
    ambiguous_currency_included_count: 0,
    non_eur_currency_included_count: 0,
    fx_converted_count: 0,
    non_eur_missing_fx_count: 0,
    unknown_timestamp_included_count: 0,
    fail_safe_missing_amount_count: 0,
    duplicate_issued_skipped_count: 0,
    explicit_non_lne_excluded_count: 0,
    events_outside_window_count: 0,
    events_skipped_profile_count: 0,
  }

  let volumeMinor = 0
  let includedCount = 0
  let failSafeAlert = false
  // Dedup ISSUED per entitlement_id (VER-M1) — spójne z redemptionVelocity.
  // At-least-once feed/replay nie może zawyżyć wolumenu regulacyjnego.
  const seenIssued = new Set<string>()

  for (const event of events) {
    const normalized = normalizeEvent(event)

    if (normalized.profile == null) {
      dataQuality.ambiguous_profile_included_count += 1
    } else if (normalized.profile !== options.profile) {
      dataQuality.events_skipped_profile_count += 1
      continue
    }

    if (normalized.lifecycle == null) {
      dataQuality.ambiguous_lifecycle_included_count += 1
    } else if (normalized.lifecycle !== "ISSUED") {
      continue
    }

    if (normalized.lne === "no") {
      dataQuality.explicit_non_lne_excluded_count += 1
      continue
    }
    if (normalized.lne === "unknown") {
      dataQuality.ambiguous_lne_scope_included_count += 1
    }

    // Okno PÓŁOTWARTE `(start, asOf]`: początek ekskluzywny, koniec inkluzywny
    // (eliminuje double-count eventu na granicy między sąsiednimi przebiegami).
    if (normalized.timestampMs == null) {
      dataQuality.unknown_timestamp_included_count += 1
    } else if (
      normalized.timestampMs <= windowStartMs ||
      normalized.timestampMs > asOfMs
    ) {
      dataQuality.events_outside_window_count += 1
      continue
    }

    // Dedup po przejściu bramek profile/lifecycle/lne/window: duplikat ISSUED
    // tego samego entitlementu jest pomijany (replay-safe). Eventy bez
    // entitlement_id nie są deduplikowane (każdy liczony — fail-safe ku alertowi).
    if (normalized.entitlementId != null) {
      if (seenIssued.has(normalized.entitlementId)) {
        dataQuality.duplicate_issued_skipped_count += 1
        continue
      }
      seenIssued.add(normalized.entitlementId)
    }

    includedCount += 1

    // VER-M2: brak kwoty LUB kwota 0 (bez dodatniego brutto) jest niejednoznaczna
    // dla progu LNE → fail-safe (alert), nigdy ciche under-count jako 0.
    if (normalized.amountMinor == null || normalized.amountMinor === 0) {
      dataQuality.fail_safe_missing_amount_count += 1
      failSafeAlert = true
      continue
    }

    // HIGH-2/VER-H1: przelicz na EUR PRZED sumowaniem; brak kursu / waluta
    // nieznana ⇒ fail-safe (alert), nie ciche dodanie do sumy EUR.
    const eurMinor = convertToEurMinor(
      normalized.currency,
      normalized.amountMinor,
      options.fx_rates_to_eur,
      dataQuality
    )
    if (eurMinor == null) {
      failSafeAlert = true
      continue
    }

    volumeMinor += eurMinor
  }

  const earlyWarnMinor = Math.ceil(thresholdMinor * earlyWarnRatio)
  // Próg `alert` jest ściśle `>` (regulacyjne „przekroczenie" 1 mln EUR; story
  // AC2 / ADR-134 — LNE art. 6c UUP). `early_warn` (≥80%) i fail-safe i tak
  // zapalają się wcześniej, więc dokładny grosz == próg daje early_warn bez
  // twardego alertu — świadomy, udokumentowany wybór (review MEDIUM `>` vs `≥`).
  const alert = volumeMinor > thresholdMinor || failSafeAlert
  const earlyWarn = volumeMinor >= earlyWarnMinor || alert

  return {
    profile: options.profile,
    window: {
      start_at: toIso(windowStartMs),
      start_inclusive: false,
      end_at: toIso(asOfMs),
      end_inclusive: true,
    },
    volume: {
      currency: "EUR",
      minor: volumeMinor,
    },
    threshold: {
      currency: "EUR",
      minor: thresholdMinor,
    },
    ratio: volumeMinor / thresholdMinor,
    early_warn: earlyWarn,
    alert,
    events_included_count: includedCount,
    data_quality: dataQuality,
  }
}

function normalizeEvent(event: VoucherTelemetryEvent): NormalizedEvent {
  const lifecycle = normalizeLifecycle(event)
  const amountMinor = readVolumeMinor(event)

  return {
    lifecycle,
    profile: readString(
      event.posting_profile,
      readMetadata(event, "posting_profile"),
      readPayload(event, "posting_profile")
    ),
    entitlementId: readString(
      event.entitlement_id,
      readPayload(event, "entitlement_id"),
      readMetadata(event, "entitlement_id")
    ),
    timestampMs: timestampForLifecycle(event, lifecycle),
    amountMinor,
    currency: readString(
      event.currency,
      readPayload(event, "currency"),
      readMetadata(event, "currency")
    )?.toUpperCase() ?? null,
    lne: classifyLne(event),
    isCompletedRedeem: isCompletedRedeem(event),
  }
}

function normalizeLifecycle(
  event: VoucherTelemetryEvent
): VoucherTelemetryLifecycle | null {
  const direct = readString(
    event.lifecycle_event,
    readMetadata(event, "lifecycle_event"),
    readPayload(event, "lifecycle_event")
  )
  const normalizedDirect = normalizeLifecycleToken(direct)
  if (normalizedDirect) {
    return normalizedDirect
  }

  const entryType = readString(event.entry_type)
  if (entryType === "ENTITLEMENT_ISSUED") {
    return "ISSUED"
  }
  if (entryType === "ENTITLEMENT_REDEEMED") {
    return "REDEEMED"
  }
  if (
    entryType === "ENTITLEMENT_EXPIRED" ||
    entryType === "ENTITLEMENT_BREAKAGE"
  ) {
    return "EXPIRED"
  }

  const eventType = readString(event.event_type)?.toLowerCase() ?? ""
  if (eventType.includes("entitlement_issued")) {
    return "ISSUED"
  }
  if (eventType.includes("entitlement_redeemed")) {
    return "REDEEMED"
  }
  if (
    eventType.includes("entitlement_expired") ||
    eventType.includes("entitlement_breakage")
  ) {
    return "EXPIRED"
  }

  return null
}

function normalizeLifecycleToken(
  token: string | null
): VoucherTelemetryLifecycle | null {
  const normalized = token?.toUpperCase()
  if (
    normalized === "ISSUED" ||
    normalized === "REDEEMED" ||
    normalized === "EXPIRED"
  ) {
    return normalized
  }
  return null
}

function timestampForLifecycle(
  event: VoucherTelemetryEvent,
  lifecycle: VoucherTelemetryLifecycle | null
): number | null {
  const timestamp =
    lifecycle === "ISSUED"
      ? readString(
          event.issued_at,
          readPayload(event, "issued_at"),
          readMetadata(event, "issued_at"),
          event.occurred_at
        )
      : lifecycle === "REDEEMED"
        ? readString(
            event.redeemed_at,
            readPayload(event, "redeemed_at"),
            readMetadata(event, "redeemed_at"),
            event.occurred_at
          )
        : readString(event.occurred_at, readPayload(event, "occurred_at"))

  return parseInstantMs(timestamp)
}

function isCompletedRedeem(event: VoucherTelemetryEvent): boolean {
  const status = readString(
    readPayload(event, "new_status"),
    readMetadata(event, "new_status"),
    event.new_status
  )?.toUpperCase()

  if (status === "PARTIALLY_REDEEMED") {
    return false
  }
  if (status === "REDEEMED") {
    return true
  }

  const remainingMinor = readInteger(
    readPayload(event, "remaining_minor_after"),
    readMetadata(event, "remaining_minor_after"),
    event.remaining_minor_after
  )
  if (remainingMinor != null) {
    return remainingMinor === 0
  }

  // Domyślnie `true`: kanoniczny event `gp.entitlements.entitlement_redeemed.v1`
  // ZAWSZE niesie `new_status` + `remaining_minor_after`, więc partial jest
  // rozpoznawany explicite powyżej. Default dotyczy wyłącznie eventów bez tych
  // pól (legacy/niepełne) — REDEEMED bez sygnału partial = pełny redeem (review LOW).
  return true
}

function classifyLne(event: VoucherTelemetryEvent): "yes" | "no" | "unknown" {
  // Konflikt flag (np. top-level `is_lne:false` vs `payload.is_lne:true`):
  // INKLUZJA wygrywa — dowolne źródło `true` ⇒ LNE (fail-safe ku monitoringowi
  // progu KNF; review LOW). `false` tylko gdy ŻADNE źródło nie twierdzi `true`.
  const booleans = [
    event.is_lne,
    event.lne,
    readPayload(event, "is_lne"),
    readPayload(event, "lne"),
    readMetadata(event, "is_lne"),
    readMetadata(event, "lne"),
  ].filter((value): value is boolean => typeof value === "boolean")

  if (booleans.some((value) => value === true)) {
    return "yes"
  }
  if (booleans.some((value) => value === false)) {
    return "no"
  }

  const model = readString(
    event.regulatory_model,
    readPayload(event, "regulatory_model"),
    readPayload(event, "lne_scope"),
    readMetadata(event, "regulatory_model"),
    readMetadata(event, "lne_scope")
  )

  if (model == null) {
    return "unknown"
  }

  const normalized = model.toUpperCase()
  if (normalized === "NON_LNE" || normalized === "OUT_OF_LNE") {
    return "no"
  }
  if (normalized.includes("LNE") || normalized.includes("LIMITED_NETWORK")) {
    return "yes"
  }

  return "unknown"
}

function histogramBuckets(
  sortedDurations: readonly number[],
  bucketEdgesMs: readonly number[]
): RedemptionVelocityBucket[] {
  const sortedEdges = [...bucketEdgesMs].sort((a, b) => a - b)
  const buckets: RedemptionVelocityBucket[] = sortedEdges.map((edge) => ({
    label: `<=${formatBucketLabel(edge)}`,
    upper_bound_ms: edge,
    count: 0,
  }))
  buckets.push({
    label: `>${formatBucketLabel(sortedEdges[sortedEdges.length - 1] ?? 0)}`,
    upper_bound_ms: null,
    count: 0,
  })

  for (const duration of sortedDurations) {
    const bucket = buckets.find(
      (candidate) =>
        candidate.upper_bound_ms == null || duration <= candidate.upper_bound_ms
    )
    if (bucket) {
      bucket.count += 1
    }
  }

  return buckets
}

function formatBucketLabel(edgeMs: number): string {
  if (edgeMs % DAY_MS === 0) {
    return `${edgeMs / DAY_MS}d`
  }
  return `${edgeMs}ms`
}

function nearestRankPercentile(
  sortedValues: readonly number[],
  percentile: number
): number | null {
  if (sortedValues.length === 0) {
    return null
  }

  const rank = Math.ceil((percentile / 100) * sortedValues.length)
  const index = Math.min(Math.max(rank - 1, 0), sortedValues.length - 1)
  return sortedValues[index]
}

function subtractUtcMonths(epochMs: number, months: number): number {
  const date = new Date(epochMs)
  const totalMonths = date.getUTCFullYear() * 12 + date.getUTCMonth() - months
  const year = Math.floor(totalMonths / 12)
  const month = totalMonths - year * 12
  const day = Math.min(date.getUTCDate(), daysInUtcMonth(year, month))

  return Date.UTC(
    year,
    month,
    day,
    date.getUTCHours(),
    date.getUTCMinutes(),
    date.getUTCSeconds(),
    date.getUTCMilliseconds()
  )
}

function daysInUtcMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month + 1, 0)).getUTCDate()
}

function parseInstantMs(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null
  }
  if (value instanceof Date) {
    const ms = value.getTime()
    return Number.isFinite(ms) ? ms : null
  }
  if (typeof value !== "string" || value.length === 0) {
    return null
  }

  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}

function toIso(epochMs: number): string {
  return new Date(epochMs).toISOString()
}

function readPayload(event: VoucherTelemetryEvent, key: string): unknown {
  return event.payload?.[key]
}

function readMetadata(event: VoucherTelemetryEvent, key: string): unknown {
  return event.metadata?.[key]
}

function readString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.length > 0) {
      return value
    }
  }
  return null
}

function readInteger(...values: unknown[]): number | null {
  for (const value of values) {
    if (typeof value === "number" && Number.isInteger(value) && value >= 0) {
      return value
    }
  }
  return null
}

/**
 * Wolumen LNE = BRUTTO WYEMITOWANE vouchera (stored-value, ADR-134). Źródła w
 * kolejności preferencji brutto: `gross_minor` / `face_value_minor` / `value_minor`
 * (`voucher.value_minor`), a dopiero potem `amount_minor` (pole kanonicznego eventu
 * `gp.entitlements.entitlement_issued.v1` = kwota wyemitowana). Czytamy z top-level
 * / `payload` / `metadata` i bierzemy MAKSIMUM dostępnych kandydatów — dzięki temu
 * `amount_minor:0` maskujące dodatnie `gross_minor` NIE zaniża wolumenu (VER-M2),
 * a kierunek niejednoznaczności jest ku wyższej sumie (fail-safe ku alertowi;
 * review LOW „amount source").
 *
 * UWAGA (HIGH-1): kanoniczny envelope `ledger-transaction.v1` dla ENTITLEMENT_ISSUED
 * niesie w `lines[]` WYŁĄCZNIE carve-out VAT (debet liability = `vat_minor`), NIE
 * brutto stored-value (noga rozpoznania brutto żyje w money-ledger / Story 2.5).
 * Taki envelope nie ma żadnego z pól brutto powyżej ⇒ `null` ⇒ ścieżka fail-safe
 * w `rollingVolumeLNE` (alert, nie ciche `volume=0`). Brutto pochodzi z domenowego
 * eventu lifecycle `entitlement_issued.v1` (`payload.amount_minor`).
 */
function readVolumeMinor(event: VoucherTelemetryEvent): number | null {
  const candidates = [
    event.gross_minor,
    readPayload(event, "gross_minor"),
    readMetadata(event, "gross_minor"),
    event.face_value_minor,
    readPayload(event, "face_value_minor"),
    readMetadata(event, "face_value_minor"),
    event.value_minor,
    readPayload(event, "value_minor"),
    readMetadata(event, "value_minor"),
    event.amount_minor,
    readPayload(event, "amount_minor"),
    readMetadata(event, "amount_minor"),
  ]
  let max: number | null = null
  for (const value of candidates) {
    if (typeof value === "number" && Number.isInteger(value) && value >= 0) {
      if (max == null || value > max) {
        max = value
      }
    }
  }
  return max
}

/**
 * Przelicza kwotę minor w danej walucie na EUR-minor wg wstrzykniętej tabeli FX
 * (HIGH-2/VER-H1). Zwraca `null` (sygnał fail-safe dla wołającego), gdy waluta jest
 * nieznana (`null`) albo non-EUR bez dostępnego kursu — wtedy kwoty NIE wolno
 * dodać do sumy EUR (próg LNE jest stricte EUR; ADR-134). EUR zwracane wprost.
 */
function convertToEurMinor(
  currency: string | null,
  amountMinor: number,
  fxRates: Readonly<Record<string, number>> | undefined,
  dataQuality: RollingVolumeLNEResult["data_quality"]
): number | null {
  if (currency == null) {
    dataQuality.ambiguous_currency_included_count += 1
    return null
  }
  if (currency === "EUR") {
    return amountMinor
  }

  dataQuality.non_eur_currency_included_count += 1
  const rate = fxRates?.[currency]
  if (typeof rate === "number" && Number.isFinite(rate) && rate > 0) {
    dataQuality.fx_converted_count += 1
    return Math.round(amountMinor * rate)
  }

  dataQuality.non_eur_missing_fx_count += 1
  return null
}
