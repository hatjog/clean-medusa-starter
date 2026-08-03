import { Modules } from "@medusajs/framework/utils"

// Story 2.2 (AC5 poz.5): klucz szablonu WYŁĄCZNIE ze stałej rejestru (AD-6).
import { NOTIFICATION_TEMPLATE_KEYS } from "@gp/messaging"

import { resolveNotificationMarketId } from "../notification-market-context"

type ScopeResolver = {
  resolve: (key: string) => unknown
}

type NotificationModuleLike = {
  createNotifications?: (data: unknown, ...rest: unknown[]) => Promise<unknown>
  send?: (data: unknown, ...rest: unknown[]) => Promise<unknown>
}

export type RecoverMagicLinkEmailInput = {
  scope: ScopeResolver
  to: string
  locale: string
  token: string
  /**
   * Rynek odbiorcy — wymagany przez providera brevo (nadawca + market-scoped
   * audit). Route recover ma go z `marketContextStorage`; brak = fallback
   * konfiguracyjny (patrz notification-market-context.ts).
   */
  marketId?: string
}

type RecoverEmailLocale = "pl" | "en" | "ua" | "de"

type RecoverEmailCopy = {
  subject: string
  title: string
  intro: string
  cta: string
  ttl: string
  ignore: string
}

const DEFAULT_STOREFRONT_URL = "http://localhost:3001"
const SUPPORTED_LOCALES = new Set<RecoverEmailLocale>(["pl", "en", "ua", "de"])
const RECOVER_EMAIL_COPY: Record<RecoverEmailLocale, RecoverEmailCopy> = {
  pl: {
    subject: "Twój link do voucherów BonBeauty",
    title: "Odzyskaj dostęp do voucherów BonBeauty",
    intro: "Kliknij bezpieczny link, aby wrócić do swoich voucherów.",
    cta: "Otwórz vouchery",
    ttl: "Link jest ważny 7 dni.",
    ignore: "Jeśli to nie Ty prosisz o dostęp, zignoruj tę wiadomość.",
  },
  en: {
    subject: "Your BonBeauty voucher access link",
    title: "Recover access to your BonBeauty vouchers",
    intro: "Use this secure link to return to your vouchers.",
    cta: "Open vouchers",
    ttl: "The link is valid for 7 days.",
    ignore: "If you did not ask for access, you can ignore this email.",
  },
  ua: {
    subject: "Ваше посилання доступу до ваучерів BonBeauty",
    title: "Відновіть доступ до ваучерів BonBeauty",
    intro: "Скористайтеся безпечним посиланням, щоб повернутися до своїх ваучерів.",
    cta: "Відкрити ваучери",
    ttl: "Посилання дійсне 7 днів.",
    ignore: "Якщо ви не просили доступ, просто проігноруйте цей лист.",
  },
  de: {
    subject: "Ihr Link zu den BonBeauty-Gutscheinen",
    title: "Zugriff auf Ihre BonBeauty-Gutscheine wiederherstellen",
    intro: "Nutzen Sie diesen sicheren Link, um zu Ihren Gutscheinen zurückzukehren.",
    cta: "Gutscheine öffnen",
    ttl: "Der Link ist 7 Tage gültig.",
    ignore: "Wenn Sie keinen Zugriff angefordert haben, können Sie diese E-Mail ignorieren.",
  },
}

function resolveStorefrontUrl(): string {
  const raw =
    process.env.STOREFRONT_URL ??
    process.env.STOREFRONT_BASE_URL ??
    process.env.NEXT_PUBLIC_BASE_URL ??
    DEFAULT_STOREFRONT_URL

  return raw.trim().replace(/\/+$/, "")
}

export function buildRecoverMagicLinkUrl({
  locale,
  token,
}: {
  locale: string
  token: string
}): string {
  const safeLocale = resolveLocale(locale)
  return `${resolveStorefrontUrl()}/${safeLocale}/user/recover/${encodeURIComponent(token)}`
}

function resolveLocale(locale: string): RecoverEmailLocale {
  const normalized = locale.trim().toLowerCase()
  return SUPPORTED_LOCALES.has(normalized as RecoverEmailLocale)
    ? (normalized as RecoverEmailLocale)
    : "pl"
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
}

function resolveNotificationModule(
  scope: ScopeResolver
): NotificationModuleLike | null {
  try {
    const notificationModule = scope.resolve(Modules.NOTIFICATION) as
      | NotificationModuleLike
      | undefined

    if (
      !notificationModule ||
      (typeof notificationModule.createNotifications !== "function" &&
        typeof notificationModule.send !== "function")
    ) {
      return null
    }

    return notificationModule
  } catch {
    return null
  }
}

function renderText(url: string, copy: RecoverEmailCopy): string {
  return [
    copy.title,
    "",
    copy.intro,
    url,
    "",
    `${copy.ttl} ${copy.ignore}`,
  ].join("\n")
}

function renderHtml(url: string, copy: RecoverEmailCopy, locale: RecoverEmailLocale): string {
  const escapedUrl = escapeHtml(url)
  return [
    `<html lang="${locale}"><body>`,
    `<h1>${escapeHtml(copy.title)}</h1>`,
    `<p>${escapeHtml(copy.intro)}</p>`,
    `<p><a href="${escapedUrl}">${escapeHtml(copy.cta)}</a></p>`,
    `<p>${escapeHtml(copy.ttl)} ${escapeHtml(copy.ignore)}</p>`,
    "</body></html>",
  ].join("")
}

export async function dispatchRecoverMagicLinkEmail({
  scope,
  to,
  locale,
  token,
  marketId,
}: RecoverMagicLinkEmailInput): Promise<boolean> {
  const notificationModule = resolveNotificationModule(scope)
  if (!notificationModule) {
    return false
  }

  const resolvedLocale = resolveLocale(locale)
  const copy = RECOVER_EMAIL_COPY[resolvedLocale]
  const url = buildRecoverMagicLinkUrl({ locale: resolvedLocale, token })
  const subject = copy.subject
  const text = renderText(url, copy)
  const html = renderHtml(url, copy, resolvedLocale)
  const payload = {
    to,
    channel: "email",
    // `template` = pole kontraktu Medusy; `data.template_key` = kanoniczne GP
    // (ADR-158). Obie wartości pochodzą z tej samej stałej rejestru.
    template: NOTIFICATION_TEMPLATE_KEYS.CUSTOMER_RECOVER_MAGIC_LINK,
    data: {
      template_key: NOTIFICATION_TEMPLATE_KEYS.CUSTOMER_RECOVER_MAGIC_LINK,
      market_id: marketId ?? resolveNotificationMarketId(),
      flow_id: "customer_recover",
      subject,
      text,
      html,
      locale: resolvedLocale,
      recover_url: url,
      ttl_days: 7,
    },
    content: {
      subject,
      text,
      html,
    },
    metadata: {
      triggered_by: "storefront-recover",
      notification_type: "customer_recover_magic_link",
      locale: resolvedLocale,
      ttl_days: 7,
    },
  }

  if (typeof notificationModule.createNotifications === "function") {
    await notificationModule.createNotifications(payload)
    return true
  }

  await notificationModule.send?.(payload)
  return true
}
