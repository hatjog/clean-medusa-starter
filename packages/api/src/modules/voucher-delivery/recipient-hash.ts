/**
 * recipient-hash.ts — jedyne miejsce, w którym adres e-mail zamienia się w
 * identyfikator odbiorcy zapisywalny do ledgera (Story 2.3, AC1 / AC4).
 *
 * Inwariant D-70: ledger `voucher_delivery_dispatch` (ani jego audit) NIGDY nie
 * trzyma surowego adresu. Klucz idempotencji niesie WYŁĄCZNIE
 * `recipient_hash = sha256(znormalizowany e-mail)` w kształcie
 * `sha256:<64 hex>` — tym samym, którego wymaga
 * `recipient_contact_hash` w `gp.communication.delivery_state_changed.v1`
 * (`^sha256:[a-f0-9]{64}$`). Kształt jest wspólny świadomie: gdy kiedyś event
 * zacznie być emitowany (NIE w v1.14.0, AD-7), hash z ledgera wchodzi tam bez
 * konwersji.
 *
 * Normalizacja jest JAWNA i przetestowana: `trim()` + `toLowerCase()`. Nie
 * robimy nic więcej (żadnego usuwania kropek w local-part, żadnego strippingu
 * `+tagów`) — te transformacje są provider-specific i zmieniłyby tożsamość
 * odbiorcy, a klucz idempotencji musi odpowiadać adresowi, na który realnie
 * poszedł mail.
 *
 * Typ `RecipientHash` jest **brandowany**: funkcja `hashRecipientEmail` (albo
 * `parseRecipientHash` dla wartości już zahashowanej) to jedyne wejścia. API
 * ledgera przyjmuje wyłącznie `RecipientHash`, więc wstawienie surowego maila
 * do ledgera jest błędem KOMPILACJI, nie tylko naruszeniem konwencji.
 */

import { createHash } from "node:crypto"

const RECIPIENT_HASH_PREFIX = "sha256:"

/** `^sha256:[a-f0-9]{64}$` — parity z `delivery_state_changed.v1`. */
export const RECIPIENT_HASH_PATTERN = /^sha256:[a-f0-9]{64}$/

declare const recipientHashBrand: unique symbol

/** Zahashowany odbiorca — jedyna forma, w jakiej ledger poznaje adresata. */
export type RecipientHash = string & { readonly [recipientHashBrand]: true }

export class RecipientHashError extends Error {
  readonly error_code = "VOUCHER_DELIVERY_RECIPIENT_HASH_INVALID"

  constructor(message: string) {
    super(message)
    this.name = "RecipientHashError"
  }
}

/** Normalizacja adresu przed hashowaniem: trim + lowercase. Nic więcej. */
export function normalizeRecipientEmail(email: string): string {
  return email.trim().toLowerCase()
}

/**
 * `sha256:<hex>` ze znormalizowanego adresu. Pusty/whitespace-only adres jest
 * błędem — hash pustego stringa byłby poprawnie wyglądającym kluczem
 * idempotencji dla „każdego odbiorcy bez adresu", czyli cichym scaleniem
 * różnych wysyłek w jeden wiersz.
 */
export function hashRecipientEmail(email: string): RecipientHash {
  const normalized = normalizeRecipientEmail(email)
  if (!normalized) {
    throw new RecipientHashError(
      "Nie można zahashować pustego adresu odbiorcy (recipient_hash musi identyfikować konkretnego adresata)",
    )
  }

  const digest = createHash("sha256").update(normalized, "utf8").digest("hex")
  return `${RECIPIENT_HASH_PREFIX}${digest}` as RecipientHash
}

/**
 * Zawęża wartość już zahashowaną (np. odczytaną z ledgera) do `RecipientHash`.
 * Fail-loud przy złym kształcie — nie chcemy, by cokolwiek innego niż hash
 * przecisnęło się do kolumny klucza idempotencji.
 */
export function parseRecipientHash(value: string): RecipientHash {
  if (!RECIPIENT_HASH_PATTERN.test(value)) {
    throw new RecipientHashError(
      `recipient_hash ma nieprawidłowy kształt (oczekiwano ${RECIPIENT_HASH_PATTERN})`,
    )
  }
  return value as RecipientHash
}

export function isRecipientHash(value: unknown): value is RecipientHash {
  return typeof value === "string" && RECIPIENT_HASH_PATTERN.test(value)
}
