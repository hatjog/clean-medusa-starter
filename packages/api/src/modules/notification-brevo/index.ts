/**
 * notification-brevo — punkt wejścia providera modułu Notification (Story 2.2).
 *
 * Default-eksportuje wartość `ModuleProvider(Modules.NOTIFICATION, { services })`,
 * której oczekuje loader providerów modułu Notification
 * (`@medusajs/notification/dist/loaders/providers.js`). Wiring w
 * `GP/backend/medusa-config.ts` wskazuje `resolve` na ten katalog przez
 * `moduleRoot(...)` (absolutny resolve — Medusa prependuje `src/`).
 */

import { ModuleProvider, Modules } from "@medusajs/framework/utils"

import { BrevoNotificationProviderService } from "./service"

export { BrevoNotificationProviderService, BREVO_API_KEY_ENV } from "./service"
export type {
  BrevoNotificationProviderOptions,
  BrevoNotificationProviderSeams,
} from "./service"
export { resolveBrevoSenders, BREVO_SENDERS_ENV } from "./senders"
export { toNotificationIntent, normalizeLocale } from "./intent"

export default ModuleProvider(Modules.NOTIFICATION, {
  services: [BrevoNotificationProviderService],
})
