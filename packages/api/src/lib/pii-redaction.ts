/**
 * pii-redaction — STORY-2-2 logger-boundary PII redaction.
 *
 * Per AR-25 + scope #12. Defence-in-depth allowlist: any field NOT in the
 * allowlist is REDACTED (the inverse of denylist — adding a new field that
 * accidentally carries PII is safe by default; explicit allowlist entry is
 * required to expose it).
 *
 * Sentry `beforeSend` integration: re-applies the same redaction on
 * `event.message` + `event.contexts.*` so any path that bypasses the logger
 * (e.g. raw `Sentry.captureException`) still has PII stripped.
 *
 * The 1k synthetic log line CI test (`integration-tests/pii-redaction.test.ts`)
 * pumps 1000 envelopes carrying email + phone fixtures through the redactor
 * + Sentry transport mock; assertion: zero leaked literal PII strings on any
 * transport.
 */

/**
 * Allowlist of safe fields that may appear in log payloads.
 *
 * NEVER add `recipient_email`, `recipient_phone`, `email`, `phone`, or any
 * synonym to this list. PII fields live behind id references
 * (`recipient_pii_id`) — those are safe.
 */
const PII_ALLOWLIST: ReadonlySet<string> = new Set([
  // Correlation
  "request_id",
  "correlation_id",
  "causation_id",
  "trace_id",
  "event_id",
  "idempotency_key",
  // Scoping
  "market_id",
  "instance_id",
  "vendor_id",
  "location_id",
  "tenant_id",
  // Domain ids (safe — UUIDs / opaque strings)
  "order_id",
  "consent_audit_id",
  "withdrawal_audit_id",
  "recipient_pii_id",
  "delivery_decision_id",
  "entitlement_id",
  "audit_id",
  "shard_market_id",
  "shard_hour_bucket",
  "table_name",
  "rows_validated",
  "breakage_row_id",
  "breakage_index",
  // Domain enums / state
  "outcome",
  "state_machine_state",
  "withdrawal_path",
  "schema_version",
  "event_type",
  "actor",
  "scope",
  "action",
  "is_gift",
  "audit_chain_verified",
  "in_flight_dispatch_aborted",
  "delivery_attempt_n",
  "voucher_kind",
  // BCP47 locale (NOT free text — well-formed pattern enforced upstream)
  "locale",
  "recipient_locale",
  "message_locale",
  // Timing
  "occurred_at",
  "placed_at",
  "created_at",
  "latency_ms",
  "retry_after_ms",
  "rows_affected",
  "rows_deleted",
  "orphans_deleted",
  // Provider stub-only id (NOT a customer-facing token)
  "provider_ref",
]);

/** Pattern fallback — strip email + E.164 even if they slip in via free text. */
const EMAIL_REGEX = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const E164_REGEX = /\+[1-9]\d{1,14}/g;

const REDACTED = "[REDACTED]";

/**
 * Redact a payload object by allowlist. Recursive on nested objects/arrays.
 *
 * Behaviour matrix (per scope #12 — defence-in-depth allowlist):
 *   - Allowlisted key → recurse / scrub-string at the leaf.
 *   - Non-allowlisted key with a SCALAR value (string/number/bool) → REDACTED.
 *   - Non-allowlisted key with an OBJECT/ARRAY value → recurse into it (so
 *     nested allowlisted children survive); container itself is preserved.
 *   - Strings are also scrubbed for email + E.164 regex regardless of key.
 *
 * Rationale: non-allowlisted scalar leaves are the actual PII risk surface
 * (recipient_email = "user@example.com"). Non-allowlisted objects (like a
 * Sentry `contexts.request` envelope) are structural — recursing preserves
 * useful diagnostic structure while redacting any leaf scalar.
 */
export function redactPayload(value: unknown): unknown {
  return redactInternal(value, /*keyAllowed=*/ true);
}

function redactInternal(value: unknown, keyAllowed: boolean): unknown {
  if (value === null || value === undefined) {
    return value;
  }
  if (typeof value === "string") {
    return keyAllowed ? scrubString(value) : REDACTED;
  }
  if (typeof value !== "object") {
    return keyAllowed ? value : REDACTED;
  }
  if (Array.isArray(value)) {
    return value.map((v) => redactInternal(v, keyAllowed));
  }
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    const childAllowed =
      PII_ALLOWLIST.has(key) || key.startsWith("_") || key === "payload";
    out[key] = redactInternal(v, childAllowed);
  }
  return out;
}

/** Scrub a single string for email + E.164 patterns. */
export function scrubString(s: string): string {
  return s.replace(EMAIL_REGEX, REDACTED).replace(E164_REGEX, REDACTED);
}

/**
 * Sentry `beforeSend` hook — re-applies redaction on Sentry envelopes so any
 * path bypassing the logger still has PII stripped.
 *
 * Sentry SDK contract: returning null drops the event. We return the event
 * with redacted message + contexts — never drop, just strip.
 */
export function sentryBeforeSend(
  event: { message?: string; contexts?: Record<string, unknown> }
): typeof event {
  return {
    ...event,
    message:
      typeof event.message === "string" ? scrubString(event.message) : event.message,
    contexts: event.contexts
      ? (redactPayload(event.contexts) as Record<string, unknown>)
      : event.contexts,
  };
}
