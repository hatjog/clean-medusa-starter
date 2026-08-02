/// <reference lib="es2022.error" />
import type { NotificationAuditEnvelope } from "./types";

interface MessagingErrorOptions {
  error_code: string;
  audit_event?: NotificationAuditEnvelope;
  cause?: unknown;
  status_code?: number;
  /**
   * R-2.2-M2: błąd PRE-FLIGHT — rzucony ZANIM cokolwiek poszło do providera
   * (walidacja payloadu, brak sendera/szablonu w allowliście, brak API key).
   * Semantycznie jednoznaczny: „na pewno nic nie wysłano".
   *
   * Gateway używa tej flagi do rozstrzygnięcia, czy wolno zacache'ować `failed`
   * pod idempotency cache key. Cache'owanie ma sens WYŁĄCZNIE dla błędów
   * niejednoznacznych (timeout-after-send) — dla pre-flight zablokowałoby
   * retry po naprawie konfiguracji na cały TTL (24 h).
   */
  preflight?: boolean;
  /**
   * ZREDAGOWANA treść odpowiedzi providera (kod HTTP + komunikat), gotowa do
   * zapisu w logu, audycie i ledgerze.
   *
   * MUSI pochodzić z `sanitizeProviderDetail` (`provider-detail.ts`) — nigdy
   * z surowego body. Pole istnieje po to, żeby operator odróżnił problem konta
   * (np. autoryzacja IP w Brevo, HTTP 401) od błędu kodu, nie żeby przenieść
   * odpowiedź providera w całości. `cause` trzyma surowy błąd i celowo NIE
   * przeżywa przepakowania przez moduł Notification Medusy.
   */
  provider_detail?: string;
}

export class MessagingError extends Error {
  readonly error_code: string;
  readonly audit_event?: NotificationAuditEnvelope;
  readonly status_code?: number;
  /** patrz `MessagingErrorOptions.preflight` — „na pewno nic nie wysłano". */
  readonly preflight: boolean;
  /** patrz `MessagingErrorOptions.provider_detail` — ZAWSZE po redakcji. */
  readonly provider_detail?: string;

  constructor(message: string, options: MessagingErrorOptions) {
    // Root tsconfig targets ES2021 (lib.es2021) where Error constructor
    // signature is `(message?: string)` — `{ cause }` ErrorOptions arrived
    // in ES2022. Set `cause` post-construction to stay compatible with the
    // shared baseline without touching the package-level `lib` override.
    super(message);
    if (options.cause !== undefined) {
      (this as { cause?: unknown }).cause = options.cause;
    }
    this.name = new.target.name;
    this.error_code = options.error_code;
    this.audit_event = options.audit_event;
    this.status_code = options.status_code;
    this.preflight = options.preflight ?? false;
    this.provider_detail = options.provider_detail;
  }
}

export class MessagingValidationError extends MessagingError {}

export class MessagingProviderError extends MessagingError {}

export class UnsupportedProviderError extends MessagingError {}

export class UnsupportedChannelError extends MessagingError {}

export class CommunicationConfigNotFoundError extends MessagingError {}

export class CommunicationConfigValidationError extends MessagingError {}

export class UnknownFlowError extends MessagingError {}

/**
 * ── Marker kodu błędu w treści komunikatu (Story 2.3, R-2.3-M3) ─────────────
 *
 * Problem: wysyłka biegnie przez `Modules.NOTIFICATION.createNotifications`,
 * a moduł Notification Medusy **przepakowuje** wyjątek providera
 * (`new MedusaError(UNEXPECTED_STATE, "Failed to send notification with id …")`
 * — BEZ trzeciego argumentu, czyli bez `code`), a `promiseAll({ aggregateErrors:
 * true })` opakowuje to jeszcze raz w zwykły `Error`. Do konsumenta (subscriber
 * ledgera) NIE dociera więc ani `error_code`, ani `code` — tylko `message`.
 *
 * Skutek bez markera: każdy wiersz `failed` w ledgerze dostawał kod generyczny,
 * więc „brak szablonu dla `ua`" był nieodróżnialny od awarii sieci czy
 * `FLOW_DISABLED` — triage i sweep 2.5 traciły jedyny sygnał kierunkowy.
 *
 * Rozwiązanie: kod błędu jest osadzany w komunikacie w DETERMINISTYCZNYM,
 * maszynowo parsowalnym markerze. Marker niesie WYŁĄCZNIE kod (`[A-Z0-9_]+`) —
 * nigdy adresu ani treści maila (D-70), więc przetrwanie go w logach jest
 * bezpieczne. Parser czyta wyłącznie zawartość markera, nigdy reszty komunikatu.
 */
const ERROR_CODE_MARKER_PATTERN = /\[gp_error_code=([A-Z0-9_]+)\]/

/** Formatuje marker doklejany do komunikatu wyjątku przepakowywanego przez Medusę. */
export function formatErrorCodeMarker(errorCode: string): string {
  return `[gp_error_code=${errorCode}]`
}

/**
 * Wyciąga kod błędu z komunikatu (dowolnie zagnieżdżonego), o ile marker jest
 * obecny. `null`, gdy markera nie ma — wołający decyduje o fallbacku.
 */
export function extractErrorCodeMarker(message: unknown): string | null {
  if (typeof message !== "string") return null
  return ERROR_CODE_MARKER_PATTERN.exec(message)?.[1] ?? null
}
