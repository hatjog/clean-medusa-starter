import { Modules } from "@medusajs/framework/utils"

import { assertNotificationProviderReady } from "./vendor-notification-provider-readiness"

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
  template: string
  triggerBy: string
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
    template: input.template,
    data: {
      subject: input.subject,
      text: input.text,
      html: input.html,
      ...input.metadata,
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