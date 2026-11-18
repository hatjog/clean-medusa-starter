import type { MedusaContainer } from "@medusajs/framework/types"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"

import { runPerRosterMarket } from "../lib/system-market-roster"

/**
 * voucher-consent-retention-sweep — v1.9.0 Wave F6 / Epic-2 HIGH-13.
 *
 * Daily PII retention sweep for the `voucher_consent` and
 * `voucher_consent_attempt` tables. Closes the BE-9 retention gap surfaced in
 * `epic-2-cross-review-findings.md HIGH-13` where consent records (IP, UA,
 * guardian email) accumulated indefinitely.
 *
 * Retention policy (legal basis: RODO Art. 5(1)(e), DPIA §3):
 *   - `voucher_consent_attempt`: hard delete after 7 days (audit signal
 *     window; longer retention provides no fraud-forensic value).
 *   - `voucher_consent.ip_address`: hash with sha256 after 90 days
 *     (preserves anti-fraud cross-correlation, removes direct PII).
 *   - `voucher_consent.user_agent`: NULL after 12 months (long enough for
 *     malicious-bot UA pattern detection; not a primary identifier).
 *   - `voucher_consent.guardian_email`: NULL after 12 months — kept short of
 *     full consent record deletion because the consent fact itself is the
 *     legal evidence (DPIA §3.4).
 *
 * Idempotent; the WHERE clauses gate on `<column> IS NOT NULL` so re-running
 * yields zero mutations for already-purged rows.
 *
 * Schedule: 03:30 UTC daily (15 min after magic-link-revocation-cleanup to
 * avoid lock contention on shared rows in the magic-link → consent join).
 */

export const SCHEDULE_NAME = "voucher-consent-retention-sweep" as const
export const SCHEDULE_CRON = "30 3 * * *" as const

const ATTEMPT_TTL_DAYS = 7
const IP_HASH_AFTER_DAYS = 90
const UA_NULL_AFTER_DAYS = 365
const EMAIL_NULL_AFTER_DAYS = 365

interface JobLogger {
  info: (msg: string) => void
  warn: (msg: string) => void
  error: (msg: string, err?: unknown) => void
}

type Db = {
  raw: (
    sql: string,
    bindings?: ReadonlyArray<unknown>
  ) => Promise<{ rows?: unknown[]; rowCount?: number | null } | unknown[]>
}

function resolveLogger(container: MedusaContainer | undefined): JobLogger {
  const fallback: JobLogger = {
    info: (m) => console.log(`[${SCHEDULE_NAME}] ${m}`),
    warn: (m) => console.warn(`[${SCHEDULE_NAME}] ${m}`),
    error: (m, e) => console.error(`[${SCHEDULE_NAME}] ${m}`, e),
  }
  try {
    const resolved = container?.resolve?.("logger") as Partial<JobLogger> | undefined
    if (resolved?.info) {
      return {
        info: resolved.info.bind(resolved),
        warn: (resolved.warn ?? resolved.info).bind(resolved),
        error: (resolved.error ?? resolved.info).bind(resolved),
      }
    }
  } catch {
    return fallback
  }
  return fallback
}

function resolveDb(container: MedusaContainer | undefined): Db | null {
  try {
    return container?.resolve?.(ContainerRegistrationKeys.PG_CONNECTION) as Db
  } catch {
    return null
  }
}

function rowCount(result: unknown): number {
  if (Array.isArray(result)) return result.length
  return (result as { rowCount?: number | null })?.rowCount ?? 0
}

export default async function voucherConsentRetentionSweep(
  container: MedusaContainer
): Promise<void> {
  const logger = resolveLogger(container)
  const db = resolveDb(container)
  if (!db) {
    logger.warn("pg connection unavailable; skipping voucher_consent retention sweep")
    return
  }

  // Story 8.7 (DW-15-374): przebieg PER RYNEK z rosteru instancji, pod
  // kontekstem rynku (hook RLS odmawia połączeń bez rynku). Każda porażka jest
  // zbierana i na końcu RZUCANA — wcześniej `catch` logował i job kończył się
  // sukcesem (maskowanie błędu retencji PII jako sukces).
  const failures: Array<{ market_id: string; step: string; error: string }> = []
  const totals = { attemptsDeleted: 0, ipHashed: 0, uaCleared: 0, emailCleared: 0 }

  await runPerRosterMarket(
    container as unknown as { resolve: (key: string) => unknown },
    { surface: "job", name: SCHEDULE_NAME },
    { error: (m, e) => logger.error(m, e) },
    async (marketId) => {
      const step = async (name: string, run: () => Promise<number>) => {
        try {
          return await run()
        } catch (err) {
          failures.push({ market_id: marketId, step: name, error: (err as Error).message })
          logger.error(`market=${marketId} ${name} failed`, err)
          return 0
        }
      }
      totals.attemptsDeleted += await step("voucher_consent_attempt cleanup", async () =>
        rowCount(await db.raw(
          `DELETE FROM voucher_consent_attempt
            WHERE market_id = ? AND created_at < NOW() - INTERVAL '${ATTEMPT_TTL_DAYS} days'`,
          [marketId]
        ))
      )
      totals.ipHashed += await step("voucher_consent ip_address minimisation", async () => {
        try {
          return rowCount(await db.raw(
            `UPDATE voucher_consent
                SET ip_address = ('sha256:' || encode(digest(host(ip_address)::text, 'sha256'), 'hex'))::inet
              WHERE market_id = ? AND ip_address IS NOT NULL
                AND created_at < NOW() - INTERVAL '${IP_HASH_AFTER_DAYS} days'
                AND host(ip_address)::text NOT LIKE 'sha256:%'`,
            [marketId]
          ))
        } catch (err) {
          // pgcrypto może być niedostępne — fallback NULL (minimalizacja PII);
          // porażka fallbacku wraca do `step` jako porażka przebiegu.
          logger.warn(`market=${marketId} voucher_consent ip_address hash failed; falling back to NULL: ${(err as Error).message}`)
          return rowCount(await db.raw(
            `UPDATE voucher_consent SET ip_address = NULL
              WHERE market_id = ? AND ip_address IS NOT NULL
                AND created_at < NOW() - INTERVAL '${IP_HASH_AFTER_DAYS} days'`,
            [marketId]
          ))
        }
      })
      totals.uaCleared += await step("voucher_consent user_agent cleanup", async () =>
        rowCount(await db.raw(
          `UPDATE voucher_consent SET user_agent = NULL
            WHERE market_id = ? AND user_agent IS NOT NULL
              AND created_at < NOW() - INTERVAL '${UA_NULL_AFTER_DAYS} days'`,
          [marketId]
        ))
      )
      totals.emailCleared += await step("voucher_consent guardian_email cleanup", async () =>
        rowCount(await db.raw(
          `UPDATE voucher_consent SET guardian_email = NULL
            WHERE market_id = ? AND guardian_email IS NOT NULL
              AND created_at < NOW() - INTERVAL '${EMAIL_NULL_AFTER_DAYS} days'`,
          [marketId]
        ))
      )
    }
  )

  logger.info(
    `attempts_deleted=${totals.attemptsDeleted} ip_hashed=${totals.ipHashed} ` +
      `ua_cleared=${totals.uaCleared} email_cleared=${totals.emailCleared} failures=${failures.length}`
  )
  if (failures.length > 0) {
    throw new Error(
      `${SCHEDULE_NAME}: ${failures.length} krok(ów) retencji nieudanych: ` +
        failures.map((f) => `${f.market_id}/${f.step}`).join(", ")
    )
  }
}

export const config = {
  name: SCHEDULE_NAME,
  schedule: SCHEDULE_CRON,
}
