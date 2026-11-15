/**
 * alert-channel.ts — v1.16.0 Story 4.3 AC3 (FR-11, AD-48, NFR-2, NFR-4; D-33).
 *
 * Trwały kanał dostarczenia alarmu runtime, OBOK `emitStructuredAlert`
 * (`alert-emit.ts`, log + ring buffer w pamięci procesu). Log rotuje, a ring
 * buffer ginie z procesem — dlatego nie są jedynym nośnikiem alarmu recovery.
 *
 * ── Konfiguracja przez env (D-33) ──────────────────────────────────────────
 *  - `GP_ALERT_CHANNELS` — uporządkowana lista kanałów (CSV), pierwszy =
 *    podstawowy, kolejne = fallback. Słownik: `sentry`, `webhook`.
 *  - `GP_ALERT_SENTRY_DSN` — DSN Sentry (kanał `sentry`, HTTP store API).
 *  - `GP_ALERT_WEBHOOK_URL` — URL odbiornika (kanał `webhook`, POST JSON).
 *  - `GP_ALERT_CHANNEL_TIMEOUT_MS` — limit jednej próby (domyślnie 5000).
 *
 * Kanał nie zależy od Brevo (D-21 bez zmian) ani od profilu pre-push/GROW.
 *
 * ── Fail-loud (NFR-4) ──────────────────────────────────────────────────────
 * Każda próba ma zapisany wynik (`attempts[]`), także udana po porażce
 * podstawowego. Gdy żaden kanał nie dostarczył albo żaden nie jest
 * skonfigurowany, wynik ma `status: "failed"` z NAZWANYM kodem i emitowany
 * jest alarm `ERROR` (`ALERT_CHANNEL_ALL_FAILED` / `ALERT_CHANNEL_NOT_CONFIGURED`)
 * — nigdy cisza. Funkcja nie rzuca: wywołujący (job, subscriber) dostaje wynik
 * i dołącza go do rekordu przebiegu.
 *
 * Bezpieczeństwo: payload niesie wyłącznie pola podane jawnie przez
 * wywołującego (bez surowych body, bez PII); DSN/URL nie trafiają do wyniku.
 */
import { emitStructuredAlert, type StructuredAlertPayload } from "./alert-emit"

export const ALERT_CHANNELS_ENV_VAR = "GP_ALERT_CHANNELS" as const
export const ALERT_SENTRY_DSN_ENV_VAR = "GP_ALERT_SENTRY_DSN" as const
export const ALERT_WEBHOOK_URL_ENV_VAR = "GP_ALERT_WEBHOOK_URL" as const
export const ALERT_CHANNEL_TIMEOUT_ENV_VAR = "GP_ALERT_CHANNEL_TIMEOUT_MS" as const
export const ALERT_CHANNEL_ENV_VARS = [
  ALERT_CHANNELS_ENV_VAR,
  ALERT_SENTRY_DSN_ENV_VAR,
  ALERT_WEBHOOK_URL_ENV_VAR,
  ALERT_CHANNEL_TIMEOUT_ENV_VAR,
] as const

export const ALERT_CHANNEL_KINDS = ["sentry", "webhook"] as const
export type AlertChannelKind = (typeof ALERT_CHANNEL_KINDS)[number]

export const ALERT_CODE_CHANNEL_ALL_FAILED = "ALERT_CHANNEL_ALL_FAILED" as const
export const ALERT_CODE_CHANNEL_NOT_CONFIGURED = "ALERT_CHANNEL_NOT_CONFIGURED" as const
/** INFO: alarm dostarczony pierwszą próbą (zapis wyniku dostarczenia, nie tylko wartość zwracana). */
export const ALERT_CODE_CHANNEL_DELIVERED = "ALERT_CHANNEL_DELIVERED" as const
/** WARN: alarm dostarczony dopiero po porażce wcześniejszej próby (np. fallback po podstawowym). */
export const ALERT_CODE_CHANNEL_DELIVERED_AFTER_FAILURE = "ALERT_CHANNEL_DELIVERED_AFTER_FAILURE" as const

const DEFAULT_TIMEOUT_MS = 5000

export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }
) => Promise<{ ok: boolean; status: number }>

export type AlertChannel = {
  kind: AlertChannelKind
  deliver: (alert: StructuredAlertPayload) => Promise<void>
}

export type AlertChannelAttempt =
  | { channel: AlertChannelKind; ok: true }
  | { channel: AlertChannelKind | "unknown"; ok: false; error: string }

export type AlertDeliveryResult =
  | { status: "delivered"; delivered_via: AlertChannelKind; attempts: AlertChannelAttempt[]; trace_emit_failed?: true }
  | {
      status: "failed"
      code: typeof ALERT_CODE_CHANNEL_ALL_FAILED | typeof ALERT_CODE_CHANNEL_NOT_CONFIGURED
      attempts: AlertChannelAttempt[]
    }

export class AlertChannelConfigError extends Error {
  constructor(message: string) {
    super(`[alert-channel] ${message}`)
    this.name = "AlertChannelConfigError"
  }
}

function timeoutMs(env: NodeJS.ProcessEnv): number {
  const raw = env[ALERT_CHANNEL_TIMEOUT_ENV_VAR]
  const parsed = raw === undefined ? NaN : Number(raw)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_TIMEOUT_MS
}

async function postJson(
  fetchImpl: FetchLike,
  url: string,
  headers: Record<string, string>,
  body: unknown,
  limitMs: number
): Promise<void> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), limitMs)
  try {
    const res = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
    if (!res.ok) {
      throw new Error(`http_status_${res.status}`)
    }
  } finally {
    clearTimeout(timer)
  }
}

/** DSN `https://<key>@<host>/<project>` → endpoint store API i nagłówek auth. */
export function parseSentryDsn(dsn: string): { storeUrl: string; authHeader: string } {
  let url: URL
  try {
    url = new URL(dsn)
  } catch {
    throw new AlertChannelConfigError(`${ALERT_SENTRY_DSN_ENV_VAR} nie jest poprawnym URL`)
  }
  const projectId = url.pathname.replace(/^\/+|\/+$/g, "")
  if (!url.username || !projectId) {
    throw new AlertChannelConfigError(`${ALERT_SENTRY_DSN_ENV_VAR} nie ma klucza albo projektu`)
  }
  return {
    storeUrl: `${url.protocol}//${url.host}/api/${projectId}/store/`,
    authHeader: `Sentry sentry_version=7, sentry_client=gp-alert-channel/1.0, sentry_key=${url.username}`,
  }
}

function sentryLevel(severity: StructuredAlertPayload["severity"]): string {
  if (severity === "CRITICAL") return "fatal"
  if (severity === "ERROR") return "error"
  if (severity === "WARN") return "warning"
  return "info"
}

function buildChannel(kind: AlertChannelKind, env: NodeJS.ProcessEnv, fetchImpl: FetchLike): AlertChannel {
  const limit = timeoutMs(env)
  if (kind === "webhook") {
    const url = env[ALERT_WEBHOOK_URL_ENV_VAR]?.trim()
    if (!url) throw new AlertChannelConfigError(`kanał webhook bez ${ALERT_WEBHOOK_URL_ENV_VAR}`)
    return {
      kind,
      deliver: (alert) =>
        postJson(fetchImpl, url, {}, { source: "gp-backend", ...alert, emitted_at: new Date().toISOString() }, limit),
    }
  }
  const dsn = env[ALERT_SENTRY_DSN_ENV_VAR]?.trim()
  if (!dsn) throw new AlertChannelConfigError(`kanał sentry bez ${ALERT_SENTRY_DSN_ENV_VAR}`)
  const { storeUrl, authHeader } = parseSentryDsn(dsn)
  return {
    kind,
    deliver: (alert) =>
      postJson(
        fetchImpl,
        storeUrl,
        { "x-sentry-auth": authHeader },
        {
          level: sentryLevel(alert.severity),
          logger: "gp-alert-channel",
          message: `${alert.code}: ${alert.message}`,
          tags: { alert_code: alert.code },
          extra: alert.context ?? {},
        },
        limit
      ),
  }
}

export type ResolvedAlertChannels = {
  channels: AlertChannel[]
  /** Kanały zadeklarowane, których nie dało się zbudować (nazwany powód). */
  config_errors: Array<{ channel: string; error: string }>
}

/** Buduje kanały z env w kolejności `GP_ALERT_CHANNELS`. Nie rzuca. */
export function resolveAlertChannels(
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: FetchLike = globalThis.fetch as unknown as FetchLike
): ResolvedAlertChannels {
  const declared = (env[ALERT_CHANNELS_ENV_VAR] ?? "")
    .split(",")
    .map((c) => c.trim().toLowerCase())
    .filter((c) => c.length > 0)
  const channels: AlertChannel[] = []
  const config_errors: Array<{ channel: string; error: string }> = []
  for (const name of declared) {
    if (!(ALERT_CHANNEL_KINDS as readonly string[]).includes(name)) {
      config_errors.push({ channel: name, error: "unknown_channel_kind" })
      continue
    }
    try {
      channels.push(buildChannel(name as AlertChannelKind, env, fetchImpl))
    } catch (err) {
      config_errors.push({ channel: name, error: err instanceof Error ? err.message : String(err) })
    }
  }
  return { channels, config_errors }
}

/** Kod błędu próby bez sekretów: URL/DSN w treści błędu są zastępowane znacznikiem. */
export function sanitizeAttemptError(message: string): string {
  return message.replace(/[a-z][a-z0-9+.-]*:\/\/\S+/gi, "<url>").slice(0, 200)
}

export type DeliverAlertDeps = {
  env?: NodeJS.ProcessEnv
  fetch?: FetchLike
  /** Wstrzyknięte kanały (testy); domyślnie z env. */
  channels?: AlertChannel[]
  emit?: (payload: StructuredAlertPayload) => void
}

/**
 * Dostarcza alarm kolejnymi kanałami aż do pierwszego sukcesu. Zawsze zwraca
 * wynik ze wszystkimi próbami; porażka wszystkich = ERROR z nazwanym kodem.
 */
export async function deliverAlert(
  alert: StructuredAlertPayload,
  deps: DeliverAlertDeps = {}
): Promise<AlertDeliveryResult> {
  const emit = deps.emit ?? emitStructuredAlert
  const resolved = deps.channels
    ? { channels: deps.channels, config_errors: [] }
    : resolveAlertChannels(deps.env ?? process.env, deps.fetch)
  const attempts: AlertChannelAttempt[] = resolved.config_errors.map((e) => ({
    channel: (ALERT_CHANNEL_KINDS as readonly string[]).includes(e.channel)
      ? (e.channel as AlertChannelKind)
      : ("unknown" as const),
    ok: false as const,
    error: sanitizeAttemptError(e.error),
  }))

  for (const channel of resolved.channels) {
    let delivered = false
    try {
      await channel.deliver(alert)
      delivered = true
    } catch (err) {
      attempts.push({
        channel: channel.kind,
        ok: false,
        error: sanitizeAttemptError(
          err instanceof Error ? (err.name === "AbortError" ? "timeout" : err.message) : String(err)
        ),
      })
    }
    if (!delivered) continue
    // Story 11.3 (DW-15-342 p.7): ślad dostarczenia emitowany POZA `try` wysyłki —
    // wyjątek `emit` nie może oznaczyć udanego kanału jako porażki ani wysłać
    // duplikatu fallbackiem.
    attempts.push({ channel: channel.kind, ok: true })
    // AC3: wynik dostarczenia jest ZAPISANY (log + ring buffer), a porażka
    // wcześniejszej próby przy sukcesie fallbacku zostawia nazwany ślad WARN.
    const afterFailure = attempts.some((a) => !a.ok)
    const result: AlertDeliveryResult = { status: "delivered", delivered_via: channel.kind, attempts }
    try {
      emit({
        severity: afterFailure ? "WARN" : "INFO",
        code: afterFailure ? ALERT_CODE_CHANNEL_DELIVERED_AFTER_FAILURE : ALERT_CODE_CHANNEL_DELIVERED,
        message: afterFailure
          ? `Alarm ${alert.code} dostarczony kanalem ${channel.kind} dopiero po porazce ${attempts.length - 1} wczesniejszej proby`
          : `Alarm ${alert.code} dostarczony kanalem ${channel.kind}`,
        context: { alert_code: alert.code, alert_severity: alert.severity, delivered_via: channel.kind, attempts },
      })
    } catch (emitErr) {
      // NFR-4: porażka zapisu śladu nie ginie — trafia do stderr i do wyniku.
      console.error(`[alert-channel] emit sladu dostarczenia nie powiodl sie: ${sanitizeAttemptError(String((emitErr as Error)?.message ?? emitErr))}`)
      return { ...result, trace_emit_failed: true } as AlertDeliveryResult
    }
    return result
  }

  const code = resolved.channels.length === 0 ? ALERT_CODE_CHANNEL_NOT_CONFIGURED : ALERT_CODE_CHANNEL_ALL_FAILED
  emit({
    severity: "ERROR",
    code,
    message:
      code === ALERT_CODE_CHANNEL_NOT_CONFIGURED
        ? `Alarm ${alert.code} bez trwalego kanalu: ${ALERT_CHANNELS_ENV_VAR} nie daje zadnego dzialajacego kanalu`
        : `Alarm ${alert.code} nie zostal dostarczony zadnym kanalem (${attempts.length} prob)`,
    context: { alert_code: alert.code, alert_severity: alert.severity, attempts },
  })
  return { status: "failed", code, attempts }
}
