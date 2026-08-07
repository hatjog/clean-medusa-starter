/**
 * intent.ts — mapowanie payloadu modułu Notification (Medusa v2) na
 * `NotificationIntent` z `@gp/messaging` (Story 2.2, AD-5).
 *
 * Funkcja czysta (bez kontenera, bez env, bez sieci) — cała testowalność
 * mapowania siedzi tutaj, a `service.ts` zostaje cienki.
 *
 * KONTRAKT PÓL — dług nazewniczy `template` → `template_key` (poz. 3 listy do
 * naprawy z 2.1) domknięty jako JAWNE MAPOWANIE, nie ciche przemianowanie:
 *   - `notification.template` to pole KONTRAKTU MEDUSY (`ProviderSendNotificationDTO`)
 *     — nie możemy go przemianować bez łamania modułu Notification;
 *   - `data.template_key` to pole KANONICZNE GP (ADR-158, rejestr, subscriber
 *     `brevo-delivery-tracker`) i ma PIERWSZEŃSTWO, gdy call-site je poda;
 *   - wartości obu pól pochodzą z tej samej stałej rejestru, więc rozjazd
 *     jest niemożliwy w kodzie produkcyjnym, a gdyby powstał — wygrywa
 *     `template_key` i jest to udokumentowane tutaj.
 */

import { randomUUID } from "node:crypto"

import {
  MessagingValidationError,
  type ConsentBasis,
  type Locale,
  type NotificationAttachment,
  type NotificationIntent,
} from "@gp/messaging"

/**
 * R-2.2-M1: `attachments` JEST polem kontraktu Medusy
 * (`ProviderSendNotificationDTO`) i realnie dociera do providera — przed fixem
 * wrapper go nie znał, więc mail potwierdzenia wizyty jechał bez pliku ICS
 * (cicha utrata treści, bez fail-loud).
 */
type ProviderAttachmentLike = {
  filename?: unknown
  name?: unknown
  content?: unknown
  content_base64?: unknown
  encoding?: unknown
}

type ProviderSendNotificationLike = {
  to: string
  channel: string
  template: string
  data?: Record<string, unknown> | null
  content?: unknown
  provider_data?: Record<string, unknown> | null
  attachments?: ProviderAttachmentLike[] | null
}

/** Klucze sterujące — kontekst GP, nie zmienne szablonu Brevo. */
const CONTROL_KEYS = new Set([
  "template_key",
  "market_id",
  "locale",
  "flow_id",
  "consent_basis",
  "idempotency_key",
  // `attachments` w `data` to duplikat pola top-level (tak robi call-site
  // appointment-confirmed) — jest konsumowany jako załącznik, nie jako zmienna
  // szablonu; bez tego cała treść ICS trafiłaby do `params` Brevo.
  "attachments",
])

const LOCALE_ALIASES: Readonly<Record<string, Locale>> = {
  pl: "pl-PL",
  "pl-pl": "pl-PL",
  en: "en-US",
  "en-us": "en-US",
  ua: "uk-UA",
  uk: "uk-UA",
  "uk-ua": "uk-UA",
  de: "de-DE",
  "de-de": "de-DE",
}

const CONSENT_BASES = new Set<ConsentBasis>([
  "transactional_critical",
  "transactional_supportive",
  "lifecycle_consented",
  "marketing",
])

export function normalizeLocale(raw: unknown): Locale | undefined {
  if (typeof raw !== "string") {
    return undefined
  }
  return LOCALE_ALIASES[raw.trim().toLowerCase()]
}

function readString(source: Record<string, unknown> | null | undefined, key: string): string | undefined {
  const value = source?.[key]
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

/**
 * Mapuje załączniki call-site'u na kontrakt `NotificationAttachment`
 * (`content_base64` ZAWSZE base64 — R-2.2-M1).
 *
 * Reguła jest jawna, nie zgadywana:
 *   - `content_base64` podane            → bierzemy verbatim,
 *   - `encoding: "base64"`               → `content` jest już base64,
 *   - w pozostałych przypadkach          → `content` to tekst (np. surowy ICS)
 *                                          i kodujemy go tutaj.
 * Załącznik bez nazwy albo bez treści jest pomijany — pusty `attachment[]`
 * Brevo odrzuca, a wysłanie pliku bez nazwy nie ma sensu biznesowego.
 */
function toNotificationAttachments(
  raw: ProviderAttachmentLike[] | null | undefined,
): NotificationAttachment[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0) {
    return undefined
  }

  const attachments: NotificationAttachment[] = []
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") {
      continue
    }
    const name =
      (typeof entry.filename === "string" && entry.filename.trim()) ||
      (typeof entry.name === "string" && entry.name.trim()) ||
      ""
    const alreadyBase64 =
      typeof entry.content_base64 === "string" && entry.content_base64.trim()
        ? entry.content_base64.trim()
        : entry.encoding === "base64" && typeof entry.content === "string"
          ? entry.content
          : undefined
    const content =
      alreadyBase64 ??
      (typeof entry.content === "string" && entry.content
        ? Buffer.from(entry.content, "utf8").toString("base64")
        : undefined)

    if (!name || !content) {
      continue
    }
    attachments.push({ name, content_base64: content })
  }

  return attachments.length > 0 ? attachments : undefined
}

/**
 * Buduje `NotificationIntent` z payloadu Medusy.
 *
 * Fail-loud (nigdy cichy no-op, nigdy „domyślny rynek/język"):
 *   - brak `market_id`   → `GP_NOTIFICATION_MARKET_ID_REQUIRED`
 *   - brak/nieznane `locale` → `GP_NOTIFICATION_LOCALE_UNSUPPORTED`
 *   - brak `template`/`template_key` → `GP_NOTIFICATION_TEMPLATE_KEY_REQUIRED`
 *
 * ── `idempotency_key` — od Story 4.1 GŁOŚNY, gdy go brakuje (AC2) ───────────
 * Do v1.14.0 brakujący klucz był po cichu zastępowany losowym `uuid()`. Skutek
 * był mierzalny i zły: dla KAŻDEGO call-site'u, który klucza nie podał, bariera
 * idempotencji NIGDY nie trafiała — dwa przebiegi tego samego zdarzenia dawały
 * dwa różne klucze, więc dwie wysyłki. Przeniesienie takiej bariery do
 * Postgresa utrwaliłoby zero ochrony i tabelę rosnącą o wiersz na wysyłkę.
 *
 * Losowy klucz ZOSTAJE jako zachowanie awaryjne (deterministyczny klucz
 * wymyślony tutaj sklejałby dwie LEGALNE wysyłki w jedną — gorzej niż brak
 * dedupe), ale przestaje być CICHY: każde takie wejście podnosi licznik
 * `NOTIFICATION_MISSING_IDEMPOTENCY_KEY_METRIC` (odpytywalny) i woła
 * `deps.onMissingIdempotencyKey`. Nowy call-site bez klucza jest więc WIDOCZNY,
 * a nie cicho niechroniony.
 *
 * Kolejność źródeł klucza: `data.idempotency_key` (kanoniczne GP) → TOP-LEVEL
 * `notification.idempotency_key` (pole kontraktu Medusy, którym call-site
 * włącza jej własny dedupe) → losowy z licznikiem. Człon top-level dołożyła
 * Story 4.1: call-site, który podał klucz Medusie, oczywiście chce tej samej
 * tożsamości wysyłki także tutaj.
 */
export function toNotificationIntent(
  notification: ProviderSendNotificationLike,
  deps: {
    uuid?: () => string
    /** Wołane, gdy klucz trzeba było wygenerować — patrz nagłówek. */
    onMissingIdempotencyKey?: (info: { template_key: string; market_id: string }) => void
  } = {},
): NotificationIntent {
  const data = (notification.data ?? {}) as Record<string, unknown>
  const uuid = deps.uuid ?? (() => randomUUID())

  const templateKey = readString(data, "template_key") ?? notification.template?.trim()
  if (!templateKey) {
    throw new MessagingValidationError(
      "Notification template key is required (data.template_key or template)",
      { error_code: "GP_NOTIFICATION_TEMPLATE_KEY_REQUIRED" },
    )
  }

  const marketId = readString(data, "market_id")
  if (!marketId) {
    throw new MessagingValidationError(
      `Notification for template '${templateKey}' is missing data.market_id ` +
        "(required for sender resolution and market-scoped audit)",
      { error_code: "GP_NOTIFICATION_MARKET_ID_REQUIRED" },
    )
  }

  const locale = normalizeLocale(data.locale)
  if (!locale) {
    throw new MessagingValidationError(
      `Notification for template '${templateKey}' has unsupported data.locale ` +
        `'${String(data.locale ?? "")}' (expected pl/en/ua/de or BCP-47 equivalent)`,
      { error_code: "GP_NOTIFICATION_LOCALE_UNSUPPORTED" },
    )
  }

  const consentBasisRaw = readString(data, "consent_basis") as ConsentBasis | undefined
  // Domyślnie `transactional_critical`: wszystkie dzisiejsze call-site'y (decyzja
  // vendora, magic-link, potwierdzenia vouchera) to maile transakcyjne. Marketing
  // MUSI podać `consent_basis` jawnie — nie dziedziczy tej wartości.
  const consentBasis: ConsentBasis =
    consentBasisRaw && CONSENT_BASES.has(consentBasisRaw)
      ? consentBasisRaw
      : "transactional_critical"

  const variables: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(data)) {
    if (!CONTROL_KEYS.has(key)) {
      variables[key] = value
    }
  }

  // Top-level `attachments` (kontrakt Medusy) ma pierwszeństwo; `data.attachments`
  // to forma używana przez zastane call-site'y i jest równoważna.
  const attachments = toNotificationAttachments(
    notification.attachments ?? (data.attachments as ProviderAttachmentLike[] | undefined),
  )

  // AC2: brak klucza jest GŁOŚNY. Zero to nie „bez zdarzenia" — to „żaden
  // call-site nie przeszedł tędy bez bariery".
  const declaredKey =
    readString(data, "idempotency_key") ??
    readTopLevelIdempotencyKey(notification)
  let idempotencyKey = declaredKey
  if (!idempotencyKey) {
    recordMissingIdempotencyKey(templateKey)
    deps.onMissingIdempotencyKey?.({ template_key: templateKey, market_id: marketId })
    idempotencyKey = uuid()
  }

  return {
    flow_id: readString(data, "flow_id") ?? templateKey,
    channel: "email",
    template_key: templateKey,
    recipient: { email: notification.to, market_id: marketId },
    variables,
    locale,
    consent_basis: consentBasis,
    idempotency_key: idempotencyKey,
    ...(attachments ? { attachments } : {}),
  }
}

/**
 * Nazwa metryki „wysyłka bez bariery". Zapisana W KODZIE, nie tylko w prozie:
 * metryka bez nazwy jest metryką, której nikt nie odpyta (NFR-2).
 */
export const NOTIFICATION_MISSING_IDEMPOTENCY_KEY_METRIC =
  "gp_notification_missing_idempotency_key_total"

/** Licznik per `template_key` — proces-lokalny i ODPYTYWALNY, jak w `system-market-context`. */
const missingIdempotencyKeyCounters = new Map<string, number>()

function recordMissingIdempotencyKey(templateKey: string): void {
  missingIdempotencyKeyCounters.set(
    templateKey,
    (missingIdempotencyKeyCounters.get(templateKey) ?? 0) + 1,
  )
}

/** Odczyt metryki — test asertuje NA METRYCE, a nie na treści linii logu. */
export function getMissingIdempotencyKeyCounts(): Record<string, number> {
  return Object.fromEntries(missingIdempotencyKeyCounters)
}

/** Wyłącznie do izolacji przypadków testowych. */
export function resetMissingIdempotencyKeyCounts(): void {
  missingIdempotencyKeyCounters.clear()
}

function readTopLevelIdempotencyKey(
  notification: ProviderSendNotificationLike,
): string | undefined {
  const raw = (notification as { idempotency_key?: unknown }).idempotency_key
  if (typeof raw !== "string") {
    return undefined
  }
  const trimmed = raw.trim()
  return trimmed.length > 0 ? trimmed : undefined
}
