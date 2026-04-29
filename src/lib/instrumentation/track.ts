/**
 * track — compile-time PII-refusing wrapper for canary instrumentation.
 *
 * Per AR-25 PII-redaction-FORBIDDEN rule + Risk #3 mitigation, this wrapper
 * refuses payloads containing fields matching known PII patterns:
 *   `email`, `phone`, `stripe_payment_intent`, `session_token`,
 *   `password`, `card_number`, `national_id`, `address`, `full_name`
 *
 * Refusal is enforced at TWO layers:
 *
 *   1. **Compile-time (TypeScript)** — the `Track<T>` conditional type
 *      resolves to `never` if `T` includes a PII field name. Callers passing
 *      such a payload will fail `tsc --noEmit`.
 *
 *   2. **Runtime** — `track()` runs a regex sweep over property keys. If a
 *      PII field is detected, the call THROWS (loud failure per project
 *      Sentry policy [M1]) — never silently strips the field.
 *
 * The wrapper also enforces presence of the AR-25 envelope (`request_id`,
 * `market_id`, `actor_id`, `event_type`, `outcome`) per NFR-OBS-5 ≥95% trace
 * correlation requirement.
 *
 * @see _bmad-output/implementation-artifacts/v150/STORY-1-4-CANARY-INSTRUMENTATION.md
 * @see _bmad-output/planning-artifacts/architecture.md AR-25 (logging conventions)
 */

import {
  emitCanaryMetric,
  emitCanaryAlert,
  emitForensicEvent,
  maskActorId,
  type CanaryAlertEvent,
  type CanaryMetricEvent,
  type ForensicEvent,
  type ForensicEventName,
} from "./posthog-canary";

/**
 * PII field-name patterns that MUST never reach PostHog or Sentry.
 *
 * Substring match (case-insensitive). When a key contains any of these
 * substrings, `track()` throws.
 */
export const PII_FORBIDDEN_FIELDS = [
  "email",
  "phone",
  "stripe_payment_intent",
  "session_token",
  "password",
  "card_number",
  "national_id",
  "address",
  "full_name",
] as const;

/**
 * Compile-time type guard. Resolves to `never` if `K` matches a PII field
 * name pattern. Used by `Track<T>` to refuse payloads at the type level.
 */
type IsPii<K extends string> = Lowercase<K> extends `${string}email${string}`
  ? true
  : Lowercase<K> extends `${string}phone${string}`
    ? true
    : Lowercase<K> extends `${string}stripe_payment_intent${string}`
      ? true
      : Lowercase<K> extends `${string}session_token${string}`
        ? true
        : Lowercase<K> extends `${string}password${string}`
          ? true
          : Lowercase<K> extends `${string}card_number${string}`
            ? true
            : Lowercase<K> extends `${string}national_id${string}`
              ? true
              : Lowercase<K> extends `${string}address${string}`
                ? true
                : Lowercase<K> extends `${string}full_name${string}`
                  ? true
                  : false;

/**
 * Conditional type that refuses a payload if any of its keys match a PII
 * pattern. Pass-through if all keys are clean.
 */
export type Track<T> = {
  [K in keyof T]: K extends string
    ? IsPii<K> extends true
      ? never
      : T[K]
    : T[K];
};

/** Runtime PII detection — case-insensitive substring sweep over keys. */
const _detectPii = (payload: Record<string, unknown>): string | null => {
  for (const key of Object.keys(payload)) {
    const lower = key.toLowerCase();
    for (const forbidden of PII_FORBIDDEN_FIELDS) {
      if (lower.includes(forbidden)) return key;
    }
  }
  return null;
};

/** AR-25 envelope presence check. Throws if any required field is missing. */
const _assertEnvelope = (
  payload: Record<string, unknown>,
  origin: string
): void => {
  const required = ["request_id", "market_id", "actor_id", "event_type", "outcome"];
  for (const field of required) {
    const value = payload[field];
    if (typeof value !== "string" || value.length === 0) {
      throw new Error(
        `track(${origin}): missing or empty AR-25 envelope field '${field}' (NFR-OBS-5 violation)`
      );
    }
  }
};

/**
 * track — type-safe canary metric emission.
 *
 * @throws Error if payload contains a PII field (refused at runtime).
 * @throws Error if AR-25 envelope is incomplete.
 *
 * Caller is responsible for masking `actor_id` via `maskActorId()` before
 * passing it in.
 */
export const trackMetric = <T extends CanaryMetricEvent>(event: Track<T>): void => {
  const payload = event as unknown as CanaryMetricEvent;
  const pii = _detectPii(payload as unknown as Record<string, unknown>);
  if (pii) {
    throw new Error(
      `track.metric: PII-redaction-FORBIDDEN rule violated — field '${pii}' is forbidden ` +
        `(see AR-25 + Story 1.4 Risk #3)`
    );
  }
  _assertEnvelope(payload as unknown as Record<string, unknown>, "metric");
  if (payload.dimensions) {
    const dimPii = _detectPii(payload.dimensions);
    if (dimPii) {
      throw new Error(
        `track.metric: PII-redaction-FORBIDDEN rule violated — dimensions field '${dimPii}' is forbidden`
      );
    }
  }
  emitCanaryMetric(payload);
};

export const trackAlert = <T extends CanaryAlertEvent>(event: Track<T>): "fired" | "suppressed" => {
  const payload = event as unknown as CanaryAlertEvent;
  const pii = _detectPii(payload as unknown as Record<string, unknown>);
  if (pii) {
    throw new Error(
      `track.alert: PII-redaction-FORBIDDEN rule violated — field '${pii}' is forbidden`
    );
  }
  _assertEnvelope(payload as unknown as Record<string, unknown>, "alert");
  return emitCanaryAlert(payload);
};

export const trackForensic = <T extends ForensicEvent>(event: Track<T>): void => {
  const payload = event as unknown as ForensicEvent;
  // Forensic payloads are richer — sweep both top-level and nested payload.
  const pii = _detectPii(payload as unknown as Record<string, unknown>);
  if (pii) {
    throw new Error(
      `track.forensic: PII-redaction-FORBIDDEN rule violated — field '${pii}' is forbidden`
    );
  }
  if (payload.payload && typeof payload.payload === "object") {
    const nestedPii = _detectPii(payload.payload as Record<string, unknown>);
    if (nestedPii) {
      throw new Error(
        `track.forensic: PII-redaction-FORBIDDEN rule violated — nested payload field '${nestedPii}' is forbidden`
      );
    }
  }
  _assertEnvelope(payload as unknown as Record<string, unknown>, "forensic");
  emitForensicEvent(payload);
};

/**
 * Convenience helper: build an envelope with a freshly masked actor_id.
 * Callers should prefer this over manually constructing the envelope.
 */
export const buildEnvelope = (input: {
  request_id: string;
  market_id: string;
  raw_actor_id: string;
  event_type: string;
  outcome: "pass" | "fail" | "skipped" | "suppressed" | "info";
}): {
  request_id: string;
  market_id: string;
  actor_id: string;
  event_type: string;
  outcome: "pass" | "fail" | "skipped" | "suppressed" | "info";
} => ({
  request_id: input.request_id,
  market_id: input.market_id,
  actor_id: maskActorId(input.raw_actor_id),
  event_type: input.event_type,
  outcome: input.outcome,
});

/** Re-export for callers building forensic events. */
export type { ForensicEventName };
