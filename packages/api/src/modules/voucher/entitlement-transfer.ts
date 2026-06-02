/**
 * entitlement-transfer.ts — Story 4.5 (v1.11.0 Epic 4 / Wave 4 — lifecycle L4 transfer/gifting).
 *
 * Czysta logika RECIPIENT BINDING + WALIDACJI TRYBU TRANSFEROWALNOŚCI + OKABLOWANIA
 * tranzycji CLAIM (bez I/O) na istniejącej maszynie stanów L4. Model domenowy
 * (analiza v1.11.0 §136): voucher (kupiony produkt) vs entitlement dla recipienta —
 * obdarowanie (gifting) nadaje **recipient binding** + **claim token**, a claim przez
 * recipienta **aktywuje** uprawnienie (tranzycja `ISSUED → ACTIVE` = „aktywacja przez
 * recipienta", §166) zgodnie z trybem transferowalności.
 *
 * Trzy tryby `transferability` (snapshot `policy_snapshot` przy ISSUED, FR15/§ 12 —
 * NIGDY z bieżącego profilu, kontrakt `market-config.v1.schema.json` BE-5 / FR1.16):
 *   - `bearer`       — na okaziciela (default § 7 regulaminu): claim token wystarcza,
 *                      brak wymogu tożsamości recipienta (recipient_customer_id = null).
 *   - `personalized` — imienny: `recipient.customer_id` WYMAGANY przy gifting i match
 *                      tożsamości egzekwowany (claimant == bound recipient), reuse
 *                      `assertTransferabilityAllowed` z 2.6/BE-5 (ochrona przed
 *                      wtórnym rynkiem, RODO control — analiza §489).
 *   - `hybrid`       — identity check OPCJONALNY: binding nadawany, weryfikacja miękka
 *                      (soft flag przy mismatch, NIE throw).
 *
 * Story REUŻYWA istniejący claim flow z v1.8.0 (P4 claim) — BEZ nowego UI (FR16):
 * claim token + strona claim to istniejąca powierzchnia; ta warstwa dokłada
 * BACKENDOWY recipient binding + walidację trybu + okablowanie tranzycji claim przez
 * JEDNOLITY punkt `wireEntitlementTransition` (3.4). Claim token reużywany z
 * `entitlement_instance.claim_token` (kolumna v1.9.0 F6) gdy istnieje.
 *
 * KRYTYCZNE — transfer/claim ≠ DERECOGNITION; posting GATED (ADR-139 D5):
 *   Transfer i claim to ZMIANA WIĄZANIA WŁASNOŚCI (recipient binding) — NIE zmieniają
 *   rozpoznania zobowiązania (liability stays; saldo i wartość pozostają; BRAK ruchu
 *   pieniądza). Tranzycja claim (`ISSUED → ACTIVE`) routuje przez TEN SAM
 *   `wireEntitlementTransition` (3.4) co każda inna tranzycja (event + audit + posting
 *   hook), ALE posting payload jest CELOWO POMINIĘTY ⇒ hook = no-op derecognition
 *   (brak kwoty do rozpoznania na transferze/claimie). Niezależnie posting globalnie
 *   GATED: `runtime_enabled` zostaje `false` (writer/hook inert, audit-only). Flip
 *   `false→true` = osobny P6 finance gate (E6/P6 + per-market signoff D-59),
 *   WYŁĄCZNIE ręczna decyzja P6 (Robert), NIE agent / NIE CI.
 *
 * GRANICE (AC3, D-5): NIE zmienia taksonomii stanów (`ALL_ENTITLEMENT_INSTANCE_STATES`,
 * 13 stanów) ani grafu `ALLOWED_ENTITLEMENT_TRANSITIONS` — używa ISTNIEJĄCEJ tranzycji
 * `ISSUED → ACTIVE`. NIE rusza hard-gate'ów `MPV_MULTI_VENDOR` (ADR-134) /
 * `SUBSCRIPTION_B2C` (ADR-136) — transfer single-vendor / bonbeauty-only (NIE
 * cross-vendor wallet = e-money/EMI). NIE buduje nowego UI (reuse v1.8.0 P4).
 *
 * Podstawa normatywna (NFR4 — referencja, NIE autorstwo): ADR-099 (4-warstwowy model /
 * `transferability` Layer 3 → snapshot Layer 4 przy ISSUED), ADR-137 (event/envelope
 * envelope.v1 / AR-EVENTS), ADR-139 (D3 posting hook = wołanie writera, D5 governed
 * activation — flip = P6), ADR-133 (separacja entitlement↔money).
 */

import {
  assertTransferabilityAllowed,
  TRANSFERABILITY_VALUES,
  type Transferability,
} from "./entitlement-boundary"
import {
  EntitlementInstanceState,
  type EntitlementPolicySnapshot,
} from "./models/entitlement"
import {
  emitTransitionEventAfterCommit,
  wireEntitlementTransitionPersisted,
  type TransitionActor,
  type TransitionAuditEnvelope,
  type TransitionEventEnvelope,
  type TransitionInput,
  type TransitionPostingResult,
  type TransitionScope,
  type TransitionWiringDeps,
} from "./entitlement-transition-wiring"

// ──────────────────────────────────────────────────────────────────────────
// Błędy fail-closed
// ──────────────────────────────────────────────────────────────────────────

/** Rzucany gdy snapshot niesie nieznaną wartość enuma `transferability` (data-integrity, fail-closed). */
export class TransferabilityEnumError extends Error {
  readonly value: unknown
  constructor(value: unknown) {
    super(
      `transfer: nieprawidłowy enum transferability '${String(value)}' w policy_snapshot — ` +
        `oczekiwano jednego z [${TRANSFERABILITY_VALUES.join(", ")}] (BE-5 / FR1.16).`
    )
    this.name = "TransferabilityEnumError"
    this.value = value
  }
}

/** Rzucany gdy `personalized` gifting bez `recipient.customer_id` (imienny wymaga tożsamości, fail-closed). */
export class TransferRecipientRequiredError extends Error {
  constructor() {
    super(
      `transfer: tryb 'personalized' (imienny) WYMAGA recipient.customer_id przy obdarowaniu — ` +
        `binding imienny nie może powstać bez tożsamości recipienta (FR1.16, ochrona przed wtórnym rynkiem).`
    )
    this.name = "TransferRecipientRequiredError"
  }
}

/** Rzucany gdy recipient == buyer (obdarowanie wymaga recipient ≠ buyer, fail-closed). */
export class TransferRecipientSameAsBuyerError extends Error {
  readonly customer_id: string
  constructor(customerId: string) {
    super(
      `transfer: recipient.customer_id '${customerId}' == buyer — obdarowanie wymaga ` +
        `recipient ≠ buyer (AC1; transfer rozdziela voucher dla buyera od entitlement dla recipienta).`
    )
    this.name = "TransferRecipientSameAsBuyerError"
    this.customer_id = customerId
  }
}

/** Rzucany gdy gifting żądany ze stanu innego niż ISSUED (binding nadawany PRZED aktywacją, fail-closed). */
export class TransferStateError extends Error {
  readonly state: EntitlementInstanceState
  constructor(state: EntitlementInstanceState) {
    super(
      `transfer: obdarowanie dozwolone WYŁĄCZNIE w stanie ISSUED (przed aktywacją przez ` +
        `recipienta), nie '${state}' (AC1; claim aktywuje ISSUED → ACTIVE).`
    )
    this.name = "TransferStateError"
    this.state = state
  }
}

/** Rzucany gdy brak źródła claim tokenu (ani reuse v1.8.0, ani generator, fail-closed). */
export class TransferClaimTokenSourceError extends Error {
  constructor() {
    super(
      `transfer: brak źródła claim tokenu — instancja nie ma claim_token (reuse v1.8.0 P4) ` +
        `ani nie podano generateClaimToken(). Obdarowanie wymaga claim tokenu (AC1).`
    )
    this.name = "TransferClaimTokenSourceError"
  }
}

/** Rzucany gdy claim token nieważny: brak / mismatch / odwołany (jednorazowy gate, fail-closed). */
export class ClaimTokenInvalidError extends Error {
  readonly reason: "absent" | "mismatch" | "revoked"
  constructor(reason: "absent" | "mismatch" | "revoked") {
    super(
      `claim: claim token nieważny (${reason}) — odrzucony fail-closed. ` +
        (reason === "absent"
          ? "Instancja nie ma nadanego claim tokenu."
          : reason === "mismatch"
            ? "Podany token nie zgadza się z tokenem instancji."
            : "Token został odwołany (claim_token_revoked_at).")
    )
    this.name = "ClaimTokenInvalidError"
    this.reason = reason
  }
}

/**
 * Rzucany gdy claim token został już zużyty (entitlement ACTIVE) a próbuje go zclaimować
 * INNA / nieznana tożsamość (double-claim ⇒ fail-closed). Token jednorazowy: pierwszy
 * claim aktywuje; replay TEJ SAMEJ tożsamości (lub okaziciela) = no-op idempotentny,
 * ale claim przez INNĄ tożsamość po zużyciu = odrzucony.
 */
export class ClaimTokenConsumedError extends Error {
  readonly claimant_customer_id: string | null
  readonly bound_recipient_customer_id: string | null
  constructor(
    claimantCustomerId: string | null,
    boundRecipientCustomerId: string | null
  ) {
    super(
      `claim: claim token już zużyty (entitlement aktywowany) — próba ponownego claimu przez ` +
        `inną/nieznaną tożsamość (claimant='${claimantCustomerId ?? "none"}', ` +
        `bound recipient='${boundRecipientCustomerId ?? "none"}') ODRZUCONA fail-closed ` +
        `(claim token jednorazowy; double-claim niedozwolony, AC2).`
    )
    this.name = "ClaimTokenConsumedError"
    this.claimant_customer_id = claimantCustomerId
    this.bound_recipient_customer_id = boundRecipientCustomerId
  }
}

/** Rzucany gdy claim żądany ze stanu, z którego token nie jest claimowalny (fail-closed). */
export class ClaimStateError extends Error {
  readonly state: EntitlementInstanceState
  constructor(state: EntitlementInstanceState) {
    super(
      `claim: claim token nie jest claimowalny ze stanu '${state}' — claim aktywuje ` +
        `WYŁĄCZNIE z ISSUED (pierwszy claim) lub jest no-op idempotentny z ACTIVE (replay). ` +
        `Inne stany ⇒ fail-closed (AC2).`
    )
    this.name = "ClaimStateError"
    this.state = state
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Odczyt transferowalności ZE SNAPSHOTU (FR15 / § 12 — NIGDY z bieżącego profilu)
// ──────────────────────────────────────────────────────────────────────────

/**
 * Czyta `transferability` ze SNAPSHOTU `policy_snapshot` instancji (ISSUED-time
 * immutability, FR15 / § 12) — NIGDY z bieżącego profilu (zmiana profilu nie dotyka
 * sprzedanych instancji). Brak pola ⇒ `bearer` (default § 7 regulaminu). Nieznana
 * wartość ⇒ {@link TransferabilityEnumError} (data-integrity, fail-closed).
 */
export function readTransferabilityFromSnapshot(
  policySnapshot: EntitlementPolicySnapshot
): Transferability {
  const raw = (policySnapshot as Record<string, unknown>).transferability
  const value = (raw ?? "bearer") as string
  if (!(TRANSFERABILITY_VALUES as readonly string[]).includes(value)) {
    throw new TransferabilityEnumError(raw)
  }
  return value as Transferability
}

// ──────────────────────────────────────────────────────────────────────────
// Recipient binding (model: voucher dla buyera ↔ entitlement dla recipienta)
// ──────────────────────────────────────────────────────────────────────────

/**
 * Recipient binding nadane przy obdarowaniu. RODO: dane recipienta MINIMALNE — wyłącznie
 * `recipient_customer_id` (brak imienia/email/telefonu; tożsamość po stabilnym id, analiza §489).
 * `bearer` binding = okazicielski (`recipient_customer_id = null`, claim token wystarcza).
 */
export type RecipientBinding = {
  /** Tożsamość recipienta (null dla `bearer`/okaziciela — claim token wystarcza). */
  recipient_customer_id: string | null
  /** Tryb transferowalności rządzący bindingiem (ze snapshotu). */
  transferability: Transferability
  /** true gdy binding okazicielski (`bearer`). */
  bearer: boolean
}

export type BuildTransferGrantInput = {
  entitlement_id: string
  /** Bieżący stan L4 — gifting dozwolony WYŁĄCZNIE z ISSUED (przed aktywacją). */
  state: EntitlementInstanceState
  /** Snapshot polityki przy ISSUED (źródło `transferability`, FR15). */
  policy_snapshot: EntitlementPolicySnapshot
  /** Tożsamość kupującego (buyer) — recipient MUSI być różny. */
  buyer_customer_id: string
  /** Recipient (odbiorca). `personalized` wymaga `customer_id`; `bearer`/`hybrid` opcjonalnie. */
  recipient?: { customer_id?: string | null }
  /** Istniejący claim_token na instancji (reuse v1.8.0 P4 gdy obecny). */
  existing_claim_token?: string | null
  /** Seam: generacja świeżego claim tokenu, gdy instancja go nie ma (reuse kształtu v1.8.0). */
  generateClaimToken?: () => string
  /** Dyskryminator idempotencji transferu (np. ULID / transfer seq) — replay ⇒ jeden transfer. */
  transfer_seq: string | number
}

/** Wynik obdarowania (gifting): recipient binding + claim token + idempotentny transfer_id. */
export type TransferGrant = {
  entitlement_id: string
  /** Deterministyczny, idempotentny identyfikator transferu (ten sam ⇒ jeden transfer). */
  transfer_id: string
  binding: RecipientBinding
  /** Claim token (reuse v1.8.0 P4 gdy istniał, inaczej nowo nadany). */
  claim_token: string
  /** true gdy claim_token reużyty z instancji (v1.8.0 P4), false gdy nowo nadany. */
  claim_token_reused: boolean
  transferability: Transferability
}

/**
 * Deterministyczny, idempotentny identyfikator transferu: per (entitlement_id,
 * dyskryminator transferu). Stabilny przy replay (ta sama para ⇒ ten sam id) ⇒ ponowny
 * ten sam transfer NIE tworzy drugiego (delegacja dedup do warstwy operacji). Spójny z
 * konwencją kluczy 3.4/4.4 (`buildExtendIdempotencyKey`).
 */
export function buildTransferId(
  entitlementId: string,
  transferSeq: string | number
): string {
  return `entitlement:${entitlementId}:transfer:${String(transferSeq)}`
}

/**
 * Buduje obdarowanie (gifting, AC1, czysta funkcja, fail-closed): nadaje recipient
 * binding + claim token wg trybu `transferability` (czytanego ZE SNAPSHOTU). Egzekwuje:
 *   (i)   gifting WYŁĄCZNIE z ISSUED ({@link TransferStateError});
 *   (ii)  `personalized` ⇒ `recipient.customer_id` WYMAGANY ({@link TransferRecipientRequiredError});
 *   (iii) recipient ≠ buyer ({@link TransferRecipientSameAsBuyerError}) gdy tożsamość znana;
 *   (iv)  claim token = reuse v1.8.0 (`existing_claim_token`) LUB świeży (`generateClaimToken`);
 *         brak obu ⇒ {@link TransferClaimTokenSourceError}.
 * Binding per tryb: `bearer` = okazicielski (recipient_customer_id null); `personalized`
 * = imienny (recipient.customer_id); `hybrid` = recipient.customer_id gdy podany, inaczej null.
 * RODO: zapisywany WYŁĄCZNIE `recipient_customer_id` (dane minimalne).
 */
export function buildTransferGrant(
  input: BuildTransferGrantInput
): TransferGrant {
  const transferability = readTransferabilityFromSnapshot(input.policy_snapshot)

  // (i) gifting WYŁĄCZNIE z ISSUED (binding nadawany przed aktywacją przez recipienta).
  if (input.state !== EntitlementInstanceState.ISSUED) {
    throw new TransferStateError(input.state)
  }

  const recipientId = input.recipient?.customer_id ?? null

  // (iii) recipient ≠ buyer (gdy tożsamość recipienta znana).
  if (recipientId != null && recipientId === input.buyer_customer_id) {
    throw new TransferRecipientSameAsBuyerError(recipientId)
  }

  // (ii) per tryb — binding recipienta.
  let binding: RecipientBinding
  if (transferability === "bearer") {
    // Okaziciel: claim token wystarcza, brak wymogu tożsamości (recipient_customer_id null).
    binding = {
      recipient_customer_id: null,
      transferability,
      bearer: true,
    }
  } else if (transferability === "personalized") {
    // Imienny: recipient.customer_id WYMAGANY (binding bez tożsamości niemożliwy).
    if (recipientId == null) {
      throw new TransferRecipientRequiredError()
    }
    binding = {
      recipient_customer_id: recipientId,
      transferability,
      bearer: false,
    }
  } else {
    // hybrid: binding z opcjonalną tożsamością (miękka weryfikacja przy claim/redeem).
    binding = {
      recipient_customer_id: recipientId,
      transferability,
      bearer: false,
    }
  }

  // (iv) claim token: reuse v1.8.0 P4 gdy istnieje, inaczej świeży (seam).
  const reused =
    input.existing_claim_token != null && input.existing_claim_token !== ""
  const claimToken = reused
    ? (input.existing_claim_token as string)
    : input.generateClaimToken?.()
  if (claimToken == null || claimToken === "") {
    throw new TransferClaimTokenSourceError()
  }

  return {
    entitlement_id: input.entitlement_id,
    transfer_id: buildTransferId(input.entitlement_id, input.transfer_seq),
    binding,
    claim_token: claimToken,
    claim_token_reused: reused,
    transferability,
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Determinacja CLAIM — token jednorazowy + idempotentny replay + binding wg trybu
// ──────────────────────────────────────────────────────────────────────────

/** Wynik claimu: pierwszy claim (`claimed`, aktywuje) lub idempotentny replay (no-op). */
export type ClaimOutcomeKind = "claimed" | "idempotent_replay"

export type DetermineClaimInput = {
  /** Claim token podany przez claimanta. */
  provided_claim_token: string
  /** Claim token zapisany na instancji (null = brak nadanego tokenu). */
  stored_claim_token: string | null
  /** Znacznik odwołania tokenu (buyer-self revoke, Epic-2 MED-09); ustawiony ⇒ token nieużywalny. */
  claim_token_revoked_at?: Date | string | null
  /** Bieżący stan L4. */
  state: EntitlementInstanceState
  /** Tożsamość recipienta związana przy gifting (null dla `bearer`). */
  bound_recipient_customer_id: string | null
  /** Tożsamość claimanta (null = okaziciel / anonimowo). */
  claimant_customer_id?: string | null
  /** Snapshot polityki przy ISSUED (źródło `transferability`, FR15). */
  policy_snapshot: EntitlementPolicySnapshot
}

export type ClaimDetermination = {
  outcome: ClaimOutcomeKind
  /** Binding recipienta do persystencji (RODO minimal). */
  binding: RecipientBinding
  /** true ⇒ claim wykonuje tranzycję ISSUED → ACTIVE (pierwszy claim); false ⇒ replay (no-op). */
  transition: boolean
  /** hybrid: miękki flag mismatch tożsamości (audit-only, NIE throw). */
  softFlag: boolean
  transferability: Transferability
}

/**
 * Rozstrzyga EFEKT claimu (czysta funkcja, fail-closed). Token jednorazowy +
 * idempotencja:
 *
 *   1. Walidacja tokenu (fail-closed): brak nadanego / mismatch / odwołany ⇒
 *      {@link ClaimTokenInvalidError}.
 *   2. ISSUED (pierwszy claim): powiązanie recipienta wg trybu + tranzycja ISSUED → ACTIVE.
 *      `personalized` egzekwuje match (claimant == bound recipient) przez REUSE
 *      `assertTransferabilityAllowed` (2.6/BE-5; mismatch ⇒ `TransferabilityError`);
 *      `bearer` przyjmuje okaziciela; `hybrid` — soft flag przy mismatch (NIE throw).
 *   3. ACTIVE (już zclaimowany): replay TEJ SAMEJ tożsamości (lub okaziciela `bearer`)
 *      ⇒ `idempotent_replay` (no-op: NIE podwaja bindingu, NIE re-aktywuje, NIE emituje
 *      drugiego eventu). Claim przez INNĄ/nieznaną tożsamość po zużyciu ⇒
 *      {@link ClaimTokenConsumedError} (double-claim fail-closed).
 *   4. Inny stan ⇒ {@link ClaimStateError} (fail-closed).
 */
export function determineClaimOutcome(
  input: DetermineClaimInput
): ClaimDetermination {
  const transferability = readTransferabilityFromSnapshot(input.policy_snapshot)

  // 1. Walidacja tokenu (jednorazowy gate, fail-closed).
  if (input.stored_claim_token == null || input.stored_claim_token === "") {
    throw new ClaimTokenInvalidError("absent")
  }
  if (input.provided_claim_token !== input.stored_claim_token) {
    throw new ClaimTokenInvalidError("mismatch")
  }
  if (input.claim_token_revoked_at != null) {
    throw new ClaimTokenInvalidError("revoked")
  }

  const claimantId = input.claimant_customer_id ?? null
  const boundId = input.bound_recipient_customer_id ?? null

  // 2. ISSUED — pierwszy claim: binding wg trybu + tranzycja ISSUED → ACTIVE.
  if (input.state === EntitlementInstanceState.ISSUED) {
    // REUSE walidatora transferowalności (2.6/BE-5): personalized egzekwuje match
    // (claimant == bound), bearer no-op, hybrid soft flag przy mismatch.
    const { softFlag } = assertTransferabilityAllowed(input.policy_snapshot, {
      customer_id: claimantId,
      recipient_customer_id: boundId,
    })

    let binding: RecipientBinding
    if (transferability === "bearer") {
      binding = { recipient_customer_id: null, transferability, bearer: true }
    } else if (transferability === "personalized") {
      // Match już wymuszony przez assertTransferabilityAllowed (boundId != null && ==).
      binding = {
        recipient_customer_id: boundId,
        transferability,
        bearer: false,
      }
    } else {
      // hybrid: utrwal bound recipient gdy znany, inaczej claimanta (miękka tożsamość).
      binding = {
        recipient_customer_id: boundId ?? claimantId,
        transferability,
        bearer: false,
      }
    }

    return {
      outcome: "claimed",
      binding,
      transition: true,
      softFlag,
      transferability,
    }
  }

  // 3. ACTIVE — token już zużyty: replay (no-op) vs double-claim (fail-closed).
  if (input.state === EntitlementInstanceState.ACTIVE) {
    const binding: RecipientBinding =
      transferability === "bearer"
        ? { recipient_customer_id: null, transferability, bearer: true }
        : { recipient_customer_id: boundId, transferability, bearer: false }

    if (transferability === "bearer") {
      // Okaziciel: brak tożsamości do rozróżnienia — re-prezentacja TEGO SAMEGO tokenu
      // na już-aktywnym entitlemencie = idempotentny no-op (jedna aktywacja, brak
      // drugiego grantu). To NIE drugi transfer (entitlement zaktywowany dokładnie raz).
      return {
        outcome: "idempotent_replay",
        binding,
        transition: false,
        softFlag: false,
        transferability,
      }
    }

    // personalized / hybrid: replay TYLKO gdy claimant == już-związany recipient.
    if (claimantId != null && claimantId === boundId) {
      return {
        outcome: "idempotent_replay",
        binding,
        transition: false,
        softFlag: false,
        transferability,
      }
    }
    // Double-claim przez inną / nieznaną tożsamość po zużyciu ⇒ fail-closed.
    throw new ClaimTokenConsumedError(claimantId, boundId)
  }

  // 4. Inny stan — token nie jest claimowalny (fail-closed).
  throw new ClaimStateError(input.state)
}

// ──────────────────────────────────────────────────────────────────────────
// Posting na transferze/claimie = NO-OP DERECOGNITION (binding-only, liability stays)
// ──────────────────────────────────────────────────────────────────────────

/** Powód no-op derecognition na transferze/claimie (ADR-139 D5 / §Granice). */
export const TRANSFER_POSTING_NOOP_REASON: string =
  "transfer/claim = zmiana wiązania własności (recipient binding) — NIE derecognition; " +
  "liability (saldo i wartość) pozostaje BEZ ZMIANY, BRAK ruchu pieniądza. Posting hook " +
  "na tej tranzycji jest no-op derecognition (BRAK payloadu postingu — nic do rozpoznania). " +
  "Niezależnie posting globalnie GATED: runtime_enabled zostaje false (flip = E6/P6 finance gate, " +
  "ręczna decyzja P6). NIE fabrykujemy kwot."

/**
 * Marker no-op derecognition transferu/claimu (fail-closed, dokumentacyjny). Transfer/claim
 * NIE niesie payloadu postingu ⇒ hook jest audit-only (`attempted:false`); liability bez zmiany.
 */
export type TransferPostingNoop = {
  /** Zawsze true — transfer/claim NIGDY nie księguje derecognition (binding-only). */
  noop: true
  reason: typeof TRANSFER_POSTING_NOOP_REASON
}

/** Buduje marker no-op derecognition transferu/claimu (ADR-139 D5). NIE wykonuje księgowania. */
export function buildTransferPostingNoop(): TransferPostingNoop {
  return { noop: true, reason: TRANSFER_POSTING_NOOP_REASON }
}

// ──────────────────────────────────────────────────────────────────────────
// Okablowanie tranzycji CLAIM — JEDNOLITY punkt (3.4), ISSUED → ACTIVE, posting no-op
// ──────────────────────────────────────────────────────────────────────────

/**
 * Hint aktora dla audytu claimu (append-only ślad: KTO OBDAROWAŁ / KTO ZCLAIMOWAŁ, AC2).
 * RODO: id-only (brak PII). Okaziciel (`bearer`) bez tożsamości claimanta ⇒ `claimed_by=bearer`.
 */
export function claimActorHint(
  giftedByCustomerId: string | null,
  claimantCustomerId: string | null
): string {
  return `claim:gifted_by=${giftedByCustomerId ?? "?"}:claimed_by=${claimantCustomerId ?? "bearer"}`
}

export type BuildClaimWiringInput = {
  entitlement_id: string
  scope: TransitionScope
  /** Claim token podany przez claimanta. */
  provided_claim_token: string
  /** Claim token zapisany na instancji. */
  stored_claim_token: string | null
  /** Znacznik odwołania tokenu (Epic-2 MED-09). */
  claim_token_revoked_at?: Date | string | null
  /** Bieżący stan L4. */
  state: EntitlementInstanceState
  /** Recipient związany przy gifting (null dla `bearer`). */
  bound_recipient_customer_id: string | null
  /** Tożsamość claimanta (null = okaziciel). */
  claimant_customer_id?: string | null
  /** Kto obdarował (buyer) — WYŁĄCZNIE audit hint (NIE persystowany w bindingu, RODO minimal). */
  gifted_by_customer_id?: string | null
  /** Snapshot polityki przy ISSUED (źródło `transferability`, FR15). */
  policy_snapshot: EntitlementPolicySnapshot
  /** Aktor tranzycji (envelope.v1). Domyślnie `customer` (recipient aktywuje). */
  actor?: TransitionActor
  /** Czas wystąpienia (ISO). Domyślnie `now` w builderze kopert. */
  occurred_at?: string
  /** Dyskryminator WYSTĄPIENIA claimu (cykl-safe key, 3.4 AI-Review-2) — np. claim/transfer seq. */
  claim_seq: string | number
}

export type ClaimWiringResult = {
  outcome: ClaimOutcomeKind
  binding: RecipientBinding
  transferability: Transferability
  /** hybrid: miękki flag mismatch tożsamości (audit-only). */
  softFlag: boolean
  /**
   * Koperta eventu tranzycji — obecna WYŁĄCZNIE przy pierwszym claimie (`claimed`);
   * `null` przy `idempotent_replay` (NIE emitujemy drugiego eventu, AC2).
   */
  event: TransitionEventEnvelope | null
  /** Audit envelope — obecny WYŁĄCZNIE przy pierwszym claimie; `null` przy replay. */
  audit: TransitionAuditEnvelope | null
  /** Wynik posting hooka — przy `claimed` ZAWSZE audit-only (`attempted:false`, no-op derecognition); `null` przy replay. */
  posting: TransitionPostingResult | null
  /** true gdy emit eventu zawiódł (best-effort; kompletność = reconciliation 2.6). false dla replay / braku emitEvent. */
  emitFailed: boolean
}

/**
 * Buduje `TransitionInput` claimu (ISSUED → ACTIVE = „aktywacja przez recipienta", §166).
 * KRYTYCZNE: posting payload CELOWO POMINIĘTY (`posting` undefined) — transfer/claim =
 * binding-only ⇒ hook jest no-op derecognition (liability bez zmiany; patrz
 * {@link buildTransferPostingNoop}). `actor_hint` koduje KTO OBDAROWAŁ / KTO ZCLAIMOWAŁ (AC2).
 */
export function buildClaimTransitionInput(
  input: BuildClaimWiringInput
): TransitionInput {
  return {
    from: EntitlementInstanceState.ISSUED,
    to: EntitlementInstanceState.ACTIVE,
    entitlement_id: input.entitlement_id,
    scope: input.scope,
    actor: input.actor ?? "customer",
    actor_hint: claimActorHint(
      input.gifted_by_customer_id ?? null,
      input.claimant_customer_id ?? null
    ),
    ...(input.occurred_at ? { occurred_at: input.occurred_at } : {}),
    transition_seq: input.claim_seq,
    // POSTING CELOWO pominięty — transfer/claim = binding-only (no-op derecognition).
  }
}

/**
 * Okablowuje claim recipienta przez JEDNOLITY punkt `wireEntitlementTransition` (3.4, AC2):
 *
 *   - Pierwszy claim (`claimed`): tranzycja ISSUED → ACTIVE przez
 *     `wireEntitlementTransitionPersisted` (fail-closed `assertWiringTransition` →
 *     krawędź ISSUED→ACTIVE legalna, D-5) ⇒ (1) append-only audit (kto obdarował / kto
 *     zclaimował / scope) atomowo w tx callera + (2) posting hook AUDIT-ONLY (brak payloadu
 *     ⇒ `attempted:false`, no-op derecognition, runtime_enabled=false). Następnie (3) event
 *     do outboxu emitowany best-effort PO COMMIT (`emitTransitionEventAfterCommit`).
 *   - Replay (`idempotent_replay`): NIE woła wiring — NIE re-aktywuje, NIE podwaja bindingu,
 *     NIE emituje drugiego eventu (idempotencja claim po tokenie, AC2).
 *
 * Determinacja (token jednorazowy / binding wg trybu) deleguje do {@link determineClaimOutcome}
 * (fail-closed: nieważny token / double-claim / zły stan ⇒ rzuca). NIE reimplementuje
 * event/audit/posting — reużywa prymitywów 3.4.
 */
export async function buildClaimWiring(
  deps: Pick<
    TransitionWiringDeps,
    "appendAudit" | "ledgerWriter" | "postingActivation" | "clock"
  > & {
    /** Best-effort emit eventu (post-COMMIT). Fail NIE blokuje (kompletność = reconciliation 2.6). */
    emitEvent?: (event: TransitionEventEnvelope) => Promise<void>
  },
  input: BuildClaimWiringInput
): Promise<ClaimWiringResult> {
  // Determinacja (fail-closed) — token jednorazowy + binding wg trybu + idempotencja.
  const determination = determineClaimOutcome({
    provided_claim_token: input.provided_claim_token,
    stored_claim_token: input.stored_claim_token,
    ...(input.claim_token_revoked_at != null
      ? { claim_token_revoked_at: input.claim_token_revoked_at }
      : {}),
    state: input.state,
    bound_recipient_customer_id: input.bound_recipient_customer_id,
    ...(input.claimant_customer_id != null
      ? { claimant_customer_id: input.claimant_customer_id }
      : {}),
    policy_snapshot: input.policy_snapshot,
  })

  // Replay idempotentny: ZERO efektów ubocznych okablowania (no-op, AC2).
  if (determination.outcome === "idempotent_replay") {
    return {
      outcome: "idempotent_replay",
      binding: determination.binding,
      transferability: determination.transferability,
      softFlag: determination.softFlag,
      event: null,
      audit: null,
      posting: null,
      emitFailed: false,
    }
  }

  // Pierwszy claim: tranzycja ISSUED → ACTIVE przez JEDNOLITY punkt (3.4).
  const transitionInput = buildClaimTransitionInput(input)
  const { event, audit, posting } = await wireEntitlementTransitionPersisted(
    {
      appendAudit: deps.appendAudit,
      ...(deps.ledgerWriter ? { ledgerWriter: deps.ledgerWriter } : {}),
      ...(deps.postingActivation
        ? { postingActivation: deps.postingActivation }
        : {}),
      ...(deps.clock ? { clock: deps.clock } : {}),
    },
    transitionInput
  )

  // Event best-effort PO COMMIT (caller woła po commit zmiany stanu; tu deleguje seam).
  let emitFailed = false
  if (deps.emitEvent) {
    emitFailed = await emitTransitionEventAfterCommit(deps.emitEvent, event)
  }

  return {
    outcome: "claimed",
    binding: determination.binding,
    transferability: determination.transferability,
    softFlag: determination.softFlag,
    event,
    audit,
    posting,
    emitFailed,
  }
}
