/**
 * recovery-config.ts — config-as-code dla populacji odzysku (v1.16.0).
 *
 * JEDYNE miejsce wartości liczbowych populacji odzysku. Story 4.4 trzyma tu
 * termin SLA właściciela rekordu `deferred_issuance_trace`; Story 4.5 dopisuje
 * tu próg wieku jako OSOBNĄ nazwaną stałą (termin SLA ≠ próg wieku — nie
 * wolno ich scalać ani czytać jednej jako drugiej).
 *
 * Wartość ma źródło w artefakcie decyzyjnym, nie w kodzie trasy:
 * `_bmad-output/releases/v1.16.0/planning-artifacts/planning/decisions-2026-11-14.md`,
 * D-35 p.9 („owner ops-recovery, SLA 24 h").
 *
 * Fail-loud: niepoprawna wartość rzuca przy IMPORCIE modułu, więc proces
 * (route webhooka, subscriber) nie wystartuje z popsutą konfiguracją —
 * nigdy ciche pominięcie zapisu rekordu.
 */

export type DeferredIssuanceTraceSlaConfig = {
  readonly seconds: number
  readonly owner_id: string
  readonly source: string
}

/** Termin SLA właściciela rekordu śladu płatności bez zamówienia (D-35 p.9). */
export const DEFERRED_ISSUANCE_TRACE_SLA: DeferredIssuanceTraceSlaConfig = Object.freeze({
  seconds: 86400,
  owner_id: "ops-recovery",
  source:
    "_bmad-output/releases/v1.16.0/planning-artifacts/planning/decisions-2026-11-14.md#D-35 p.9",
})

/**
 * Walidacja konfiguracji SLA. Rzuca nazwanym błędem przy braku albo
 * niepoprawnej wartości (niedodatnia, niecałkowita, bez źródła).
 */
export function assertDeferredIssuanceTraceSla(
  config: Partial<DeferredIssuanceTraceSlaConfig> | null | undefined
): number {
  const seconds = config?.seconds
  if (typeof seconds !== "number" || !Number.isInteger(seconds) || seconds <= 0) {
    throw new Error(
      "[recovery-config] DEFERRED_ISSUANCE_TRACE_SLA.seconds musi byc dodatnia liczba calkowita " +
        `(otrzymano: ${JSON.stringify(seconds)})`
    )
  }
  if (typeof config?.owner_id !== "string" || !config.owner_id.trim()) {
    throw new Error("[recovery-config] DEFERRED_ISSUANCE_TRACE_SLA.owner_id jest wymagany")
  }
  if (typeof config?.source !== "string" || !config.source.trim()) {
    throw new Error("[recovery-config] DEFERRED_ISSUANCE_TRACE_SLA.source (zrodlo decyzji) jest wymagane")
  }
  return seconds
}

/** Zwalidowany termin SLA w sekundach — walidacja przy imporcie (fail-loud). */
export const DEFERRED_ISSUANCE_TRACE_SLA_SECONDS: number = assertDeferredIssuanceTraceSla(
  DEFERRED_ISSUANCE_TRACE_SLA
)
