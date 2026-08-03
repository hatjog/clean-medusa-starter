import { Modules } from "@medusajs/framework/utils"

import type { NotificationTemplateKey } from "@gp/messaging"

import { assertNotificationProviderReady } from "./vendor-notification-provider-readiness"
import { resolveNotificationMarketId } from "./notification-market-context"

type ScopeResolver = {
  resolve: (key: string) => unknown
}

type NotificationModuleLike = {
  createNotifications?: (data: unknown, ...rest: unknown[]) => Promise<unknown>
  send?: (data: unknown, ...rest: unknown[]) => Promise<unknown>
}

export class NotificationModuleUnavailableError extends Error {
  readonly code = "VENDOR_NOTIFICATION_MODULE_UNAVAILABLE"

  constructor() {
    super(
      "Vendor notification module is not available for live dispatch. " +
        "Ensure the Medusa notification module is registered in the runtime container.",
    )
    this.name = "NotificationModuleUnavailableError"
  }
}

export type DispatchVendorEmailInput = {
  scope: ScopeResolver
  to: string
  subject: string
  text: string
  html: string
  /**
   * Story 2.2 (dług nazewniczy z 2.1, poz. 3): pole nazywa się `templateKey` i
   * przyjmuje WYŁĄCZNIE klucz z rejestru (`NOTIFICATION_TEMPLATE_KEYS`).
   * Literał w call-site = drugie źródło prawdy → łamie AD-6.
   */
  templateKey: NotificationTemplateKey
  triggerBy: string
  /** Rynek odbiorcy; domyślnie `resolveNotificationMarketId()` (patrz dług tam). */
  marketId?: string
  /**
   * Locale wiadomości (pl/en/ua/de albo BCP-47) — WYMAGANE.
   *
   * R-2.2-L1: wcześniej pole było opcjonalne z cichym defaultem `"pl"`, co łamało
   * kontrakt fail-loud `GP_NOTIFICATION_LOCALE_UNSUPPORTED` z `intent.ts`:
   * pominięcie locale przez nowego wołającego wysłałoby polski szablon zamiast
   * wybuchnąć. Oba dzisiejsze call-site'y i tak je podają.
   */
  locale: string
  /** Flow dla KPI/feature-flag; domyślnie `templateKey`. */
  flowId?: string
  /** Klucz idempotencji gatewaya; brak = wysyłka bez dedupe. */
  idempotencyKey?: string
  metadata?: Record<string, unknown>
}

export type DispatchVendorEmailResult = {
  notificationId: string | null
}

function resolveNotificationModule(scope: ScopeResolver): NotificationModuleLike {
  const notificationModule = scope.resolve(Modules.NOTIFICATION) as
    | NotificationModuleLike
    | undefined

  if (
    !notificationModule ||
    (typeof notificationModule.createNotifications !== "function" &&
      typeof notificationModule.send !== "function")
  ) {
    throw new NotificationModuleUnavailableError()
  }

  return notificationModule
}

function extractNotificationId(value: unknown): string | null {
  if (!value) {
    return null
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const nested = extractNotificationId(item)
      if (nested) {
        return nested
      }
    }
    return null
  }

  if (typeof value !== "object") {
    return null
  }

  const record = value as Record<string, unknown>
  if (typeof record.id === "string" && record.id.length > 0) {
    return record.id
  }

  for (const key of ["data", "notification", "notifications", "result", "results"] as const) {
    const nested = extractNotificationId(record[key])
    if (nested) {
      return nested
    }
  }

  return null
}

export async function dispatchVendorEmail(
  input: DispatchVendorEmailInput,
): Promise<DispatchVendorEmailResult> {
  assertNotificationProviderReady()

  const notificationModule = resolveNotificationModule(input.scope)
  const payload = {
    to: input.to,
    channel: "email",
    // `template` to pole KONTRAKTU Medusy (ProviderSendNotificationDTO) — nie da
    // się go przemianować bez łamania modułu. Kanoniczne GP `template_key`
    // (ADR-158) jedzie w `data` i ma pierwszeństwo po stronie wrappera brevo;
    // obie wartości pochodzą z tej samej stałej rejestru.
    template: input.templateKey,
    // R-2.2-I2: top-level `idempotency_key` włącza TRWAŁY, międzyprocesowy dedupe
    // modułu Notification Medusy (lookup `list({ idempotency_key })`) — kopia
    // w `data` obsługuje osobną warstwę (in-memory cache gatewaya).
    ...(input.idempotencyKey ? { idempotency_key: input.idempotencyKey } : {}),
    data: {
      // R-2.2-L2: metadane call-site'u rozlewają się PRZED kluczami sterującymi,
      // więc przypadkowy `template_key`/`market_id`/`locale` w `metadata` nie
      // nadpisze allowlisty AD-6 ani rozwiązania nadawcy. Wcześniej spread stał
      // na końcu i był niejawnym kanałem nadpisania.
      ...input.metadata,
      template_key: input.templateKey,
      market_id: input.marketId ?? resolveNotificationMarketId(),
      locale: input.locale,
      flow_id: input.flowId ?? input.templateKey,
      ...(input.idempotencyKey ? { idempotency_key: input.idempotencyKey } : {}),
      subject: input.subject,
      text: input.text,
      html: input.html,
    },
    content: {
      subject: input.subject,
      text: input.text,
      html: input.html,
    },
    metadata: {
      triggered_by: input.triggerBy,
      ...input.metadata,
    },
  }

  const result =
    typeof notificationModule.createNotifications === "function"
      ? await notificationModule.createNotifications(payload)
      : await notificationModule.send?.(payload)

  return {
    notificationId: extractNotificationId(result),
  }
}