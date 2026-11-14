/**
 * runtime-instance-identity — tożsamość instancji runtime w kopercie zdarzeń
 * domenowych (v1.16.0 Story 11.2, NFR-3, AD-49, DW-15-183, ADR Proposed).
 *
 * ── Defekt, który ten moduł zamyka ──────────────────────────────────────────
 * Producenci `entitlement_state_changed` (i `entitlement_refund_applied`)
 * wpisywali do `scope.instance_id` ID UPRAWNIENIA. Pole mówiło więc „z której
 * instancji runtime pochodzi zdarzenie", a niosło coś zupełnie innego — dwie
 * instancje tego samego rynku były nierozróżnialne, a konsument stracił
 * strażnika odrzucającego kopertę z obcej instancji.
 *
 * ── Kontrakt ────────────────────────────────────────────────────────────────
 *   1. `scope.instance_id` = instancja runtime, WYŁĄCZNIE z autorytatywnego
 *      nośnika (`GP_INSTANCE_ID`, ten sam co granica RLS z 11.1). Bez domyślki
 *      `gp`/`gp-dev` — brak nośnika = odmowa emisji z nazwanym kodem.
 *   2. Entitlement id leży we własnym polu (`payload.entitlement_id`).
 *   3. Konsument porównuje `scope.instance_id` z własną instancją:
 *        - zgodna                       → przepuszczona,
 *        - nieobecna                    → przepuszczona (trigger lokalny: sweep
 *                                         rekonsyliacyjny / płaski payload — nie
 *                                         deklaruje cudzej tożsamości),
 *        - równa `payload.entitlement_id` → koperta ZASTANA sprzed 11.2
 *                                         (kompatybilność historyczna, `warn`)
 *                                         WYŁĄCZNIE gdy `occurred_at` koperty
 *                                         leży przed punktem odcięcia
 *                                         `LEGACY_ENTITLEMENT_SCOPED_CUTOFF_AT`;
 *                                         po nim (albo bez czytelnego
 *                                         `occurred_at`) → `mismatch`,
 *        - inna                         → ODRZUCONA (`GP_RUNTIME_INSTANCE_MISMATCH`).
 *
 * @module lib/runtime-instance-identity
 */

import { resolveRuntimeInstanceId } from "./market-context"

export const RUNTIME_INSTANCE_UNCONFIGURED_ERROR_CODE =
  "GP_RUNTIME_INSTANCE_UNCONFIGURED" as const

export const RUNTIME_INSTANCE_MISMATCH_ERROR_CODE =
  "GP_RUNTIME_INSTANCE_MISMATCH" as const

/**
 * Koniec okna kompatybilności kopert zastanych (ADR-240, kontrakt
 * `envelope.v1` `scope.instance_id`). Koperta w kształcie zastanym
 * (`scope.instance_id === payload.entitlement_id`) jest przyjmowana wyłącznie,
 * gdy jej `occurred_at` jest WCZEŚNIEJSZY niż ten punkt. Ta sama wartość jest
 * zapisana w opisie schematu i w ADR-240 — zmiana wymaga zmiany kontraktu.
 */
export const LEGACY_ENTITLEMENT_SCOPED_CUTOFF_AT = "2026-11-15T00:00:00.000Z" as const

/** Producent odmawia emisji, bo nie zna swojej instancji runtime. */
export class RuntimeInstanceIdentityError extends Error {
  readonly error_code = RUNTIME_INSTANCE_UNCONFIGURED_ERROR_CODE
  readonly producer: string

  constructor(producer: string) {
    super(
      `[${producer}] GP_INSTANCE_ID nie jest skonfigurowany — odmowa emisji ` +
        "koperty (scope.instance_id = instancja runtime, bez domyślki; Story 11.2)"
    )
    this.name = "RuntimeInstanceIdentityError"
    this.producer = producer
  }
}

/**
 * Rozpoznanie nazwanej klasy błędu także po przejściu przez granicę workflow
 * Medusy (która potrafi zgubić prototyp): `instanceof`, kod albo nazwa.
 */
export function isRuntimeInstanceIdentityError(
  err: unknown
): err is RuntimeInstanceIdentityError {
  if (err instanceof RuntimeInstanceIdentityError) return true
  if (!err || typeof err !== "object") return false
  const candidate = err as { error_code?: unknown; name?: unknown }
  return (
    candidate.error_code === RUNTIME_INSTANCE_UNCONFIGURED_ERROR_CODE ||
    candidate.name === "RuntimeInstanceIdentityError"
  )
}

/**
 * Instancja runtime dla producenta koperty. Rzuca
 * `RuntimeInstanceIdentityError`, gdy nośnik jest pusty albo niepoprawny.
 */
export function requireRuntimeInstanceId(
  producer: string,
  raw: string | undefined = process.env.GP_INSTANCE_ID
): string {
  const instanceId = resolveRuntimeInstanceId(raw)
  if (!instanceId) throw new RuntimeInstanceIdentityError(producer)
  return instanceId
}

export type EnvelopeInstanceVerdict =
  | "match"
  | "absent"
  | "legacy_entitlement_scoped"
  | "mismatch"

/**
 * Klasyfikacja tożsamości koperty wobec instancji konsumenta. Czysta funkcja —
 * strażnik konsumenta decyduje na jej podstawie (odrzuca wyłącznie `mismatch`).
 */
export function classifyEnvelopeInstance(input: {
  envelope_instance_id: string | null | undefined
  entitlement_id: string | null | undefined
  runtime_instance_id: string
  /** `occurred_at` koperty — decyduje o oknie kompatybilności kopert zastanych. */
  occurred_at?: string | null
}): EnvelopeInstanceVerdict {
  const claimed =
    typeof input.envelope_instance_id === "string"
      ? input.envelope_instance_id.trim()
      : ""
  if (!claimed) return "absent"
  if (claimed === input.runtime_instance_id) return "match"
  const entitlementId =
    typeof input.entitlement_id === "string" ? input.entitlement_id.trim() : ""
  if (
    entitlementId &&
    claimed === entitlementId &&
    isWithinLegacyCompatibilityWindow(input.occurred_at)
  ) {
    return "legacy_entitlement_scoped"
  }
  return "mismatch"
}

/**
 * Czy koperta mieści się w oknie kompatybilności kopert zastanych. Brak albo
 * nieczytelny `occurred_at` = poza oknem (fail-closed: wyjątek nie może zależeć
 * od pola, którego nie ma).
 */
export function isWithinLegacyCompatibilityWindow(
  occurredAt: string | null | undefined,
  cutoffAt: string = LEGACY_ENTITLEMENT_SCOPED_CUTOFF_AT
): boolean {
  if (typeof occurredAt !== "string" || !occurredAt.trim()) return false
  const occurred = Date.parse(occurredAt)
  const cutoff = Date.parse(cutoffAt)
  if (!Number.isFinite(occurred) || !Number.isFinite(cutoff)) return false
  return occurred < cutoff
}
