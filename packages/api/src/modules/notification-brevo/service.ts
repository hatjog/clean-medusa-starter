/**
 * notification-brevo/service.ts — cienki wrapper providera notyfikacji Medusy
 * nad `@gp/messaging` (Story 2.2, AC1 / AD-5).
 *
 * Wiring: `GP/backend/medusa-config.ts` → modules[notification].providers[]
 *   { resolve: moduleRoot("notification-brevo"), id: "brevo", options: { channels: ["email"] } }
 * `id` jest pinowany jawnie, więc runtime key providera to `np_brevo`
 * (`NotificationProviderRegistrationPrefix + id`, `@medusajs/notification/dist/loaders/providers.js`)
 * i nie powstaje identyfikator pochodny od nazwy pluginu — to ta sama regresja,
 * której pilnuje `id: "stripe"` w module payment (`pp_stripe` vs `pp_stripe_stripe`).
 *
 * ── ROZSTRZYGNIĘCIE: wrapper ↔ MessagingGateway (AC1, wariant (a)) ───────────
 * `BrevoAdapter.toBrevoPayload` niesie kontrakt: „produkcyjne callsite MUSZĄ
 * wywoływać przez `MessagingGateway.send` — bezpośrednie użycie pomija invariant
 * `audit_event`". Wrapper WOŁA GATEWAY (`DefaultMessagingGateway`), a nie adapter
 * wprost.
 *
 * Stan po review 2.2 (R-2.2-H1) — bez zaokrągleń, bo AC1 wymaga zapisu, który
 * odpowiada kodowi:
 *   - `audit_event` — ODTWORZONY TUTAJ. Gateway buduje envelope, a wrapper go
 *     KONSUMUJE: `emitAuditEnvelope()` oddaje go do `auditSink` (domyślnie
 *     structured log przez `logger`). Envelope jest PII-free z konstrukcji
 *     (`hashed_recipient`), więc log nie łamie D-70. Bez tego envelope powstawał
 *     i przepadał — invariant był deklarowany, nie realizowany.
 *   - `idempotency-cache` — ZACHOWANY (to natywna własność gatewaya; pre-flight
 *     faile nie są cache'owane, patrz R-2.2-M2 w `gateway.ts`).
 *   - `flagResolver` (per-market kill-switch flow) i `flowKpiTelemetry` (KPI
 *     `sent` → denominator `delivered_rate`) — WSTRZYKIWALNE przez `seams`, ale
 *     produkcyjnie NIEPODPIĘTE. Podpięcie wymaga loadera czytającego konfigurację
 *     flag komunikacyjnych i rejestr approvali 5-8 (PostHog client) — infrastruktura
 *     spoza zakresu 2.2. WŁAŚCICIEL: Story 2.3, deferral architektoniczny
 *     (wymaga ADR na wiring flag/KPI w module Notification). Do tego czasu:
 *     kill-switch per rynek/flow NIE działa na tej ścieżce, a KPI `sent` nie są
 *     emitowane — to jawny dług, nie spełniona własność.
 *
 * Konsekwencja wymagająca jawnej obsługi: gateway ŁAPIE `MessagingProviderError`
 * i zwraca `NotificationDispatch{status:"failed"}` zamiast rzucać (patrz
 * `gateway.ts` R2-M1 — cache'owanie niejednoznacznego failu). Dla powierzchni
 * providera Medusy taki „miękki fail" byłby cichym no-opem i łamałby NFR8/AD-6,
 * dlatego wrapper przekłada `status === "failed"` z powrotem na rzucony
 * `MedusaError` z `error_code` z audit envelope (m.in. `BREVO_TEMPLATE_NOT_CONFIGURED`).
 * Audit envelope powstaje w gatewayu ZANIM wrapper rzuci — nic nie ginie.
 *
 * ── Boot bez `BREVO_API_KEY` (AC1) ──────────────────────────────────────────
 * Konstruktor NIE czyta sekretu i NIE buduje klienta HTTP — wyłącznie zapamiętuje
 * opcje (wzorzec lazy-init z `payment-stripe-multi-market`). Gateway + klient
 * powstają przy pierwszym `send()`. Brak `BREVO_API_KEY` → `NotConfiguredBrevoClient`
 * (fail-loud przy wysyłce), NIGDY crash startu backendu.
 */

import { MedusaError } from "@medusajs/framework/utils"
import type { Logger } from "@medusajs/framework/types"
import type { NotificationTypes } from "@medusajs/types"
import { AbstractNotificationProviderService } from "@medusajs/framework/utils"

import {
  BrevoHttpClient,
  DefaultMessagingGateway,
  MessagingError,
  NotConfiguredBrevoClient,
  RegistryBackedBrevoProvider,
  type FlowKpiTelemetryHook,
  type IBrevoClient,
  type ICommunicationFlowFlagResolver,
  type MessagingGateway,
  type NotificationAuditEnvelope,
} from "@gp/messaging"

import { toNotificationIntent } from "./intent"
import { resolveBrevoSenders } from "./senders"

export const BREVO_API_KEY_ENV = "BREVO_API_KEY"

export interface BrevoNotificationProviderOptions {
  /** Kanały obsługiwane przez providera (Medusa `validateProviders`). */
  channels?: string[]
  /** Override endpointu (test/staging); domyślnie publiczny endpoint Brevo. */
  endpoint?: string
  timeoutMs?: number
}

type InjectedDependencies = {
  logger?: Logger
}

/**
 * Sink envelope'u audytowego (R-2.2-H1).
 *
 * `NotificationAuditEnvelope` jest PII-free z konstrukcji (`hashed_recipient`),
 * więc domyślną implementacją jest structured log. Gdy 2.3 doda trwały ledger,
 * wystarczy wstrzyknąć inny sink — wrapper nie zmienia się.
 */
export type NotificationAuditSink = (envelope: NotificationAuditEnvelope) => void

/** Seamy testowe — pozwalają sprawdzić wrapper bez sieci i bez kontenera Medusy. */
export interface BrevoNotificationProviderSeams {
  client?: IBrevoClient
  gateway?: MessagingGateway
  env?: NodeJS.ProcessEnv
  auditSink?: NotificationAuditSink
  /**
   * R-2.2-H1: gniazda na kill-switch per rynek/flow i telemetrię KPI. Produkcyjny
   * wiring (config flag + rejestr approvali) należy do Story 2.3 — tutaj są
   * wstrzykiwalne, żeby gateway dostał je BEZ zmiany tego pliku, gdy powstaną.
   */
  flagResolver?: ICommunicationFlowFlagResolver
  flowKpiTelemetry?: FlowKpiTelemetryHook
}

export class BrevoNotificationProviderService extends AbstractNotificationProviderService {
  static identifier = "brevo"

  protected readonly logger_?: Logger
  protected readonly options_: BrevoNotificationProviderOptions
  private readonly seams_: BrevoNotificationProviderSeams
  private gateway_?: MessagingGateway

  constructor(
    { logger }: InjectedDependencies,
    options: BrevoNotificationProviderOptions = {},
    seams: BrevoNotificationProviderSeams = {},
  ) {
    super()
    this.logger_ = logger
    this.options_ = options
    this.seams_ = seams
  }

  /**
   * Świadomie NIE waliduje obecności `BREVO_API_KEY` — walidacja opcji biegnie
   * przy boocie, a brak sekretu nie może wywrócić startu backendu (AC1).
   */
  static validateOptions(options: Record<string, unknown>): void {
    const channels = options?.channels
    if (channels !== undefined && !Array.isArray(channels)) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        "notification-brevo: `channels` musi być tablicą (np. [\"email\"])",
      )
    }
  }

  async send(
    notification: NotificationTypes.ProviderSendNotificationDTO,
  ): Promise<NotificationTypes.ProviderSendNotificationResultsDTO> {
    const intent = toNotificationIntent(notification)
    const dispatch = await this.gateway().send(intent)

    // R-2.2-H1: envelope audytowy MUSI zostać skonsumowany — na obu ścieżkach,
    // zanim wrapper zwróci wynik albo rzuci. Wcześniej powstawał i przepadał.
    this.emitAuditEnvelope(dispatch.audit_event)

    if (dispatch.status === "failed") {
      const errorCode = dispatch.audit_event.error_code ?? "BREVO_DISPATCH_FAILED"
      throw new MedusaError(
        MedusaError.Types.UNEXPECTED_STATE,
        `[notification-brevo] dispatch failed for template '${intent.template_key}': ` +
          `${errorCode}${dispatch.audit_event.error_message ? ` — ${dispatch.audit_event.error_message}` : ""}`,
        errorCode,
      )
    }

    return { id: dispatch.provider_message_id ?? dispatch.dispatch_id }
  }

  /**
   * Oddaje envelope audytowy do sinka. Domyślnie structured log — envelope jest
   * PII-free (`hashed_recipient`), więc nie łamie D-70. Sink NIGDY nie może
   * wywrócić wysyłki, dlatego jest w try/catch.
   */
  private emitAuditEnvelope(envelope: NotificationAuditEnvelope): void {
    try {
      if (this.seams_.auditSink) {
        this.seams_.auditSink(envelope)
        return
      }
      this.logger_?.info?.(
        `[notification-brevo] audit_event ${JSON.stringify(envelope)}`,
      )
    } catch {
      // Awaria sinka audytowego nie może zmienić wyniku wysyłki.
    }
  }

  /** Lazy-init: gateway + provider + klient powstają przy pierwszej wysyłce. */
  private gateway(): MessagingGateway {
    if (this.gateway_) {
      return this.gateway_
    }

    // R-2.2-L3: seam `gateway` sprawdzany PRZED budową providera/klienta —
    // inaczej wstrzyknięty gateway i tak powodował powstanie `BrevoHttpClient`
    // (seam nie izolował tak, jak sugeruje nazwa).
    if (this.seams_.gateway) {
      this.gateway_ = this.seams_.gateway
      return this.gateway_
    }

    const env = this.seams_.env ?? process.env
    const { senders, warning } = resolveBrevoSenders(env)
    if (warning) {
      this.logger_?.warn?.(`[notification-brevo] ${warning}`)
    }

    const provider = new RegistryBackedBrevoProvider(this.resolveClient(env), { senders })

    this.gateway_ = new DefaultMessagingGateway({ brevo: provider }, "brevo", {
      // R-2.2-H1: gniazda podpięte do gatewaya. Dziś zwykle `undefined`
      // (kill-switch/KPI = Story 2.3), ale wiring istnieje i jest testowalny —
      // nie ma już rozjazdu „opcje pominięte w całości" vs deklaracja w AC1.
      flagResolver: this.seams_.flagResolver,
      flowKpiTelemetry: this.seams_.flowKpiTelemetry,
    })

    return this.gateway_
  }

  private resolveClient(env: NodeJS.ProcessEnv): IBrevoClient {
    if (this.seams_.client) {
      return this.seams_.client
    }

    const apiKey = env[BREVO_API_KEY_ENV]?.trim()
    if (!apiKey) {
      this.logger_?.warn?.(
        `[notification-brevo] ${BREVO_API_KEY_ENV} is not set — provider registered in ` +
          "no-op-safe mode; every dispatch fails loud with BREVO_API_KEY_NOT_CONFIGURED",
      )
      return new NotConfiguredBrevoClient()
    }

    try {
      return new BrevoHttpClient({
        apiKey,
        endpoint: this.options_.endpoint,
        timeoutMs: this.options_.timeoutMs,
      })
    } catch (error) {
      // Konstrukcja klienta nie może wywrócić wysyłki innym błędem niż
      // kontrolowany fail-loud — degradujemy do klienta „not configured".
      const code = error instanceof MessagingError ? error.error_code : "BREVO_CLIENT_INIT_FAILED"
      this.logger_?.warn?.(`[notification-brevo] client init failed (${code})`)
      return new NotConfiguredBrevoClient()
    }
  }
}

export default BrevoNotificationProviderService
