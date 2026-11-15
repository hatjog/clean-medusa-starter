/**
 * addressing-axis.ts — oś (a) adresowania jako bramka maszynowa
 * (v1.16.0 Story 6.4; FR-20, AD-36 oś (a), NFR-2, NFR-4, SM-4).
 *
 * Oś (a): adresat powiadomienia prezentowego (handoff) jest RÓŻNY od płatnika.
 * Porównanie idzie po WARTOŚCI adresu — `recipient_hash` wiersza dispatch vs
 * `hashRecipientEmail(buyer_email)` (ta sama normalizacja trim+lowercase co
 * ledger) — a nie po obecności pola. Dwa obecne pola o równej wartości to
 * FAIL, nie PASS.
 *
 * GRANICA: wynik tej bramki jest warunkiem KONIECZNYM, a NIE dowodem
 * dostarczenia. Oś (b) (skrzynka odbiorcy) dowodzi bramka ludzka 6.7.
 *
 * Kontrola ujemna (AC2): zapytanie dowodowe osi (a) szuka wierszy handoffu
 * zaadresowanych do płatnika i oczekuje `(0 rows)`. Pusty wynik jest uznawany
 * WYŁĄCZNIE po kontroli dodatniej — to samo zapytanie, uruchomione na wierszu
 * kontrolnym z `recipient_hash == hash(buyer_email)`, musi go znaleźć. Bez tego
 * `(0 rows)` z pustej kolumny łączącej albo literówki w `template_key`
 * wyglądałoby jak brak zjawiska.
 */

import { NOTIFICATION_TEMPLATE_KEYS } from "@gp/messaging"

import { VOUCHER_DELIVERY_DISPATCH_TABLE } from "./dispatch-ledger"
import { hashRecipientEmail, isRecipientHash } from "./recipient-hash"

export const ADDRESSING_AXIS_ID = "AD-36(a)" as const
/** Szablon, którego adresat MUSI być różny od płatnika. */
export const ADDRESSING_AXIS_TEMPLATE_KEY = NOTIFICATION_TEMPLATE_KEYS.VOUCHER_HANDOFF_LINK

export type AddressingAxisRefusalCode =
  | "ADDRESSING_AXIS_PAYER_ADDRESS_MISSING"
  | "ADDRESSING_AXIS_RECIPIENT_HASH_MISSING"
  | "ADDRESSING_AXIS_RECIPIENT_HASH_INVALID"

export type AddressingAxisVerdict =
  | { verdict: "PASS"; is_delivery_proof: false }
  | { verdict: "FAIL"; reason_code: "ADDRESSING_AXIS_RECIPIENT_EQUALS_PAYER"; is_delivery_proof: false }
  | { verdict: "REFUSED"; reason_code: AddressingAxisRefusalCode; is_delivery_proof: false }

/**
 * Czysta funkcja osi (a). Brak któregokolwiek adresu = odmowa diagnozowalna
 * (NFR-4), nigdy PASS.
 */
export function checkAddressingAxis(input: {
  notification_recipient_hash: string | null | undefined
  payer_email: string | null | undefined
}): AddressingAxisVerdict {
  const payer = typeof input.payer_email === "string" ? input.payer_email.trim() : ""
  if (!payer) {
    return { verdict: "REFUSED", reason_code: "ADDRESSING_AXIS_PAYER_ADDRESS_MISSING", is_delivery_proof: false }
  }
  const recipient = input.notification_recipient_hash
  if (typeof recipient !== "string" || recipient.length === 0) {
    return { verdict: "REFUSED", reason_code: "ADDRESSING_AXIS_RECIPIENT_HASH_MISSING", is_delivery_proof: false }
  }
  if (!isRecipientHash(recipient)) {
    return { verdict: "REFUSED", reason_code: "ADDRESSING_AXIS_RECIPIENT_HASH_INVALID", is_delivery_proof: false }
  }
  if (recipient === hashRecipientEmail(payer)) {
    return { verdict: "FAIL", reason_code: "ADDRESSING_AXIS_RECIPIENT_EQUALS_PAYER", is_delivery_proof: false }
  }
  return { verdict: "PASS", is_delivery_proof: false }
}

/** Zapytanie dowodowe osi (a): wiersze handoffu zaadresowane do płatnika. */
export const ADDRESSING_AXIS_PROOF_SQL = `SELECT dispatch_id, recipient_hash
  FROM ${VOUCHER_DELIVERY_DISPATCH_TABLE}
 WHERE entitlement_id = $1
   AND template_key = $2
   AND recipient_hash = $3`

export function buildAddressingAxisProofQuery(input: {
  entitlement_id: string
  payer_email: string
}): { text: string; values: [string, string, string] } {
  return {
    text: ADDRESSING_AXIS_PROOF_SQL,
    values: [input.entitlement_id, ADDRESSING_AXIS_TEMPLATE_KEY, hashRecipientEmail(input.payer_email)],
  }
}

/**
 * Zapytanie wierszy BADANEGO entitlementu (fix D-31, finding „pusty join”):
 * wszystkie wiersze handoffu entitlementu, BEZ filtra hasha płatnika. Zero
 * wierszy to odmowa `TARGET_ROW_MISSING`, nie PASS — inaczej literówka w
 * `entitlement_id` albo niezapisany handoff dawałyby `(0 rows)` zapytania
 * właściwego, czyli zieleń bez zjawiska.
 */
export const ADDRESSING_AXIS_TARGET_ROWS_SQL = `SELECT dispatch_id, entitlement_id, recipient_hash
  FROM ${VOUCHER_DELIVERY_DISPATCH_TABLE}
 WHERE entitlement_id = $1
   AND template_key = $2
 ORDER BY dispatch_id`

export type QueryRunner = {
  query(
    text: string,
    values: unknown[],
  ): Promise<{ rows: Array<{ dispatch_id: string; recipient_hash: string; entitlement_id?: string }> }>
}

export type AddressingAxisTargetRow = {
  dispatch_id: string
  entitlement_id: string
  recipient_hash: string
  axis_verdict: AddressingAxisVerdict["verdict"]
}

export type AddressingAxisProofVerdict = "PASS" | "FAIL" | "CONTROL_FAILED" | "TARGET_ROW_MISSING"

export type AddressingAxisProof = {
  axis: typeof ADDRESSING_AXIS_ID
  is_delivery_proof: false
  query_sql: string
  target_query_sql: string
  template_key: string
  payer_hash: string
  positive_control: {
    entitlement_id: string
    row_count: number
    recipient_hashes: string[]
    executed_seq: 1
  }
  target: {
    entitlement_id: string
    row_count: number
    rows: AddressingAxisTargetRow[]
    executed_seq: 2 | null
  }
  proof: {
    entitlement_id: string
    row_count: number
    executed_seq: 3 | null
  }
  verdict: AddressingAxisProofVerdict
}

/**
 * Kolejność: (1) kontrola dodatnia, (2) wiersze BADANEGO entitlementu,
 * (3) zapytanie właściwe. Pusta kontrola ⇒ CONTROL_FAILED; brak wiersza
 * badanego ⇒ TARGET_ROW_MISSING (nazwana odmowa, nie PASS). PASS wyłącznie,
 * gdy każdy wiersz badanego przechodzi `checkAddressingAxis` po wartości
 * i zapytanie właściwe zwraca `(0 rows)`.
 */
export async function runAddressingAxisProof(
  db: QueryRunner,
  input: { entitlement_id: string; control_entitlement_id: string; payer_email: string },
): Promise<AddressingAxisProof> {
  const control = buildAddressingAxisProofQuery({
    entitlement_id: input.control_entitlement_id,
    payer_email: input.payer_email,
  })
  const controlResult = await db.query(control.text, control.values)
  const base = {
    axis: ADDRESSING_AXIS_ID as typeof ADDRESSING_AXIS_ID,
    is_delivery_proof: false as const,
    query_sql: ADDRESSING_AXIS_PROOF_SQL,
    target_query_sql: ADDRESSING_AXIS_TARGET_ROWS_SQL,
    template_key: ADDRESSING_AXIS_TEMPLATE_KEY,
    payer_hash: control.values[2],
    positive_control: {
      entitlement_id: input.control_entitlement_id,
      row_count: controlResult.rows.length,
      recipient_hashes: controlResult.rows.map((row) => row.recipient_hash),
      executed_seq: 1 as const,
    },
  }
  const emptyTarget = { entitlement_id: input.entitlement_id, row_count: 0, rows: [], executed_seq: null }
  const notRun = { entitlement_id: input.entitlement_id, row_count: 0, executed_seq: null }
  if (controlResult.rows.length < 1) {
    return { ...base, target: emptyTarget, proof: notRun, verdict: "CONTROL_FAILED" }
  }

  const targetResult = await db.query(ADDRESSING_AXIS_TARGET_ROWS_SQL, [
    input.entitlement_id,
    ADDRESSING_AXIS_TEMPLATE_KEY,
  ])
  const rows: AddressingAxisTargetRow[] = targetResult.rows.map((row) => ({
    dispatch_id: row.dispatch_id,
    entitlement_id: String(row.entitlement_id ?? ""),
    recipient_hash: row.recipient_hash,
    axis_verdict: checkAddressingAxis({
      notification_recipient_hash: row.recipient_hash,
      payer_email: input.payer_email,
    }).verdict,
  }))
  const target = { entitlement_id: input.entitlement_id, row_count: rows.length, rows, executed_seq: 2 as const }
  if (rows.length < 1) {
    return { ...base, target, proof: notRun, verdict: "TARGET_ROW_MISSING" }
  }

  const proof = buildAddressingAxisProofQuery({
    entitlement_id: input.entitlement_id,
    payer_email: input.payer_email,
  })
  const proofResult = await db.query(proof.text, proof.values)
  const rowsBelongToTarget = rows.every((row) => row.entitlement_id === input.entitlement_id)
  const allRowsPass = rows.every((row) => row.axis_verdict === "PASS")
  return {
    ...base,
    target,
    proof: { entitlement_id: input.entitlement_id, row_count: proofResult.rows.length, executed_seq: 3 },
    verdict: proofResult.rows.length === 0 && allRowsPass && rowsBelongToTarget ? "PASS" : "FAIL",
  }
}
