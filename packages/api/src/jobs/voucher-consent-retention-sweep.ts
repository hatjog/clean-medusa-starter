import type { MedusaContainer } from "@medusajs/framework/types"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"

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

  let attemptsDeleted = 0
  let ipHashed = 0
  let uaCleared = 0
  let emailCleared = 0

  try {
    const r1 = await db.raw(
      `DELETE FROM voucher_consent_attempt
        WHERE created_at < NOW() - INTERVAL '${ATTEMPT_TTL_DAYS} days'`
    )
    attemptsDeleted = rowCount(r1)
  } catch (err) {
    logger.error("voucher_consent_attempt cleanup failed", err)
  }

  try {
    // Hash ip_address with sha256 once past the IP retention window. We store
    // the hash back into the same column (keeps schema flat) but prefix with
    // `sha256:` so callers can distinguish raw IP from hashed IP. Idempotent
    // — once prefixed, the WHERE clause skips the row.
    const r2 = await db.raw(
      `UPDATE voucher_consent
          SET ip_address = ('sha256:' || encode(digest(host(ip_address)::text, 'sha256'), 'hex'))::inet
        WHERE ip_address IS NOT NULL
          AND created_at < NOW() - INTERVAL '${IP_HASH_AFTER_DAYS} days'
          AND host(ip_address)::text NOT LIKE 'sha256:%'`
    )
    ipHashed = rowCount(r2)
  } catch (err) {
    // pgcrypto's `digest` may be unavailable in some deployments. Fall back to
    // NULLing the ip_address column on failure (preserves PII minimisation
    // posture even if pgcrypto isn't enabled).
    logger.warn(`voucher_consent ip_address hash failed; falling back to NULL: ${(err as Error).message}`)
    try {
      const fallback = await db.raw(
        `UPDATE voucher_consent
            SET ip_address = NULL
          WHERE ip_address IS NOT NULL
            AND created_at < NOW() - INTERVAL '${IP_HASH_AFTER_DAYS} days'`
      )
      ipHashed = rowCount(fallback)
    } catch (fallbackErr) {
      logger.error("voucher_consent ip_address fallback NULL failed", fallbackErr)
    }
  }

  try {
    const r3 = await db.raw(
      `UPDATE voucher_consent
          SET user_agent = NULL
        WHERE user_agent IS NOT NULL
          AND created_at < NOW() - INTERVAL '${UA_NULL_AFTER_DAYS} days'`
    )
    uaCleared = rowCount(r3)
  } catch (err) {
    logger.error("voucher_consent user_agent cleanup failed", err)
  }

  try {
    const r4 = await db.raw(
      `UPDATE voucher_consent
          SET guardian_email = NULL
        WHERE guardian_email IS NOT NULL
          AND created_at < NOW() - INTERVAL '${EMAIL_NULL_AFTER_DAYS} days'`
    )
    emailCleared = rowCount(r4)
  } catch (err) {
    logger.error("voucher_consent guardian_email cleanup failed", err)
  }

  logger.info(
    `attempts_deleted=${attemptsDeleted} ip_hashed=${ipHashed} ` +
      `ua_cleared=${uaCleared} email_cleared=${emailCleared}`
  )
}

export const config = {
  name: SCHEDULE_NAME,
  schedule: SCHEDULE_CRON,
}
