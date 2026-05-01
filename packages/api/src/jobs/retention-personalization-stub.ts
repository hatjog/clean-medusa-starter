import type { MedusaContainer } from "@medusajs/framework/types"

/**
 * retention-personalization-stub — STUB for v1.4.0 (D-65 + ADR-065).
 *
 * Pure no-op schedule placeholder. v1.5.0 will implement actual retention
 * sweep per ADR-065 (365-day retention from MAX(entitlement.issued_at,
 * voucher_personalization.created_at), audit log entries, [redacted]
 * placeholder rewrite of event-store payloads). This stub registers the
 * cron schedule so monitoring + alerting are wired BEFORE the v1.5.0
 * delivery flag flips ON, eliminating "schema-runtime mismatch" risk.
 *
 * Hard contract for the stub (STORY-D65 AC #7 — anti-leak guarantees):
 *   - MUST NOT emit recipient PII fields in any log line.
 *   - MUST NOT delete rows.
 *   - MUST NOT read PII rows (no DB query touching recipient_email/phone).
 *   - Pure schedule placeholder — only emits {timestamp, schedule_name}.
 *
 * v1.5.0 will REPLACE (not extend) this stub with the real implementation:
 *   - Hard delete of voucher_personalization rows past retention window.
 *   - gdpr_audit_log insert per row with action="PURGE_RETENTION".
 *   - OrderPlaced.v2 event-store redaction worker handoff.
 *
 * References:
 *   - ADR-065 (specs/adr/2026-04-27-adr-065-voucher-pii-retention.md)
 *   - STORY-D65 (_bmad-output/implementation-artifacts/v140/STORY-D65-voucher-pii-walidator.md)
 *   - D-65 (architecture.md:329) — GDPR PII fields pull-forward
 *   - HARD GATE: legal counsel sign-off REQUIRED before prod migration touching PII columns.
 */

export const SCHEDULE_NAME = "retention-personalization-stub" as const
export const SCHEDULE_CRON = "0 3 * * *" as const // daily 03:00 UTC

export default async function retentionPersonalizationStub(
  container: MedusaContainer,
): Promise<void> {
  // Resolve logger defensively — fall back to console if container is partial
  // (keeps the stub safe to import in unit-test mocks).
  let logger: { info: (msg: string) => void } = console as unknown as {
    info: (msg: string) => void
  }

  try {
    const resolved = container?.resolve?.("logger") as
      | { info: (msg: string) => void }
      | undefined
    if (resolved && typeof resolved.info === "function") {
      logger = resolved
    }
  } catch {
    // container.resolve may throw if logger not registered in test mocks;
    // fallback already set above.
  }

  // ANTI-PII contract: log line MUST contain ONLY timestamp + schedule name.
  // Do NOT add recipient_email, recipient_phone, recipient_name, entitlement_id,
  // or any other PII / row-identifying field. v1.5.0 will rewrite this body.
  const timestamp = new Date().toISOString()
  logger.info(
    `[${SCHEDULE_NAME}] tick at ${timestamp} — stub no-op (v1.5.0 will implement retention sweep per ADR-065)`,
  )
}

export const config = {
  name: SCHEDULE_NAME,
  schedule: SCHEDULE_CRON,
}
