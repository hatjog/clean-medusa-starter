/**
 * posthog-canary — D-68 + AR-4 real-time canary instrumentation client wrapper.
 *
 * Wraps `posthog-node ^5.11` to emit the 7 canary metrics with the AR-25
 * structured envelope (`request_id`, `market_id`, masked `actor_id`,
 * `event_type`, `outcome`) per NFR-OBS-5 ≥95% trace correlation.
 *
 * The 7 canary metrics (Story 1.4 scope #2):
 *   1. vendor_offer_capacity_utilization (per market)
 *   2. mor_policy_evaluation_latency_p95 (per market)
 *   3. voucher_pii_consent_completion_rate (per market)
 *   4. flag_state_transition_counter (per market+flag+actor)
 *   5. voucher_dispatch_success_rate (per market)
 *   6. cart_settlement_rate (per market)
 *   7. audit_log_write_rate (per audit table) — REQUIRES Story 1.1 emission contract
 *
 * Idempotency: `request_id` is the canonical deduplication key.
 *
 * @see _bmad-output/planning-artifacts/architecture.md L436-448 (D-68)
 * @see _bmad-output/implementation-artifacts/v150/STORY-1-4-CANARY-INSTRUMENTATION.md
 * @see GP/backend/src/lib/instrumentation/flag-propagation.ts (Story 1.3 reuse pattern)
 */

import { createHash } from "node:crypto";

/**
 * The 7 canonical canary metrics. Adding a NEW metric requires an ADR
 * amendment per `_grow/patterns/canary-metrics.md` "Adding a NEW metric"
 * section.
 */
export const CANARY_METRIC_NAMES = [
  "vendor_offer_capacity_utilization",
  "mor_policy_evaluation_latency_p95",
  "voucher_pii_consent_completion_rate",
  "flag_state_transition_counter",
  "voucher_dispatch_success_rate",
  "cart_settlement_rate",
  "audit_log_write_rate",
] as const;

export type CanaryMetricName = (typeof CANARY_METRIC_NAMES)[number];

/**
 * AR-25 structured envelope — REQUIRED on every canary event.
 * Validated at the type level by the `track()` wrapper.
 */
export interface CanaryEnvelope {
  request_id: string;
  market_id: string;
  /** Masked via `maskActorId()` — SHA-256 + per-env salt, truncated to 16 hex. */
  actor_id: string;
  event_type: string;
  outcome: "pass" | "fail" | "skipped" | "suppressed" | "info";
}

/** Canary metric event — extends envelope with metric-specific value. */
export interface CanaryMetricEvent extends CanaryEnvelope {
  metric_name: CanaryMetricName;
  metric_value: number;
  /** Per-market dimensionality; flag transitions also include flag_name+actor. */
  dimensions?: Record<string, string | number | null>;
  /** Cold-start flag — true during first 24h post-deploy (per D-68 baseline contract). */
  is_cold_start?: boolean;
}

/** Severity for Sentry mirror routing (D-68: HIGH/CRITICAL only mirrored). */
export type CanarySeverity = "info" | "warning" | "high" | "critical";

/** Canary alert event — fires when a metric diverges >2σ from baseline. */
export interface CanaryAlertEvent extends CanaryEnvelope {
  metric_name: CanaryMetricName;
  metric_value: number;
  baseline_p50: number;
  baseline_p95: number;
  baseline_p99: number;
  divergence_sigma: number;
  severity: CanarySeverity;
  /** Sample size in evaluation window — drives FM-71-9 suppression rule. */
  sample_n: number;
  /** Reference to `gp-ops/runbooks/canary-alert-response.md` for first-responder. */
  runbook_path: "gp-ops/runbooks/canary-alert-response.md";
}

/** Minimal PostHog client interface (matches `posthog-node` `PostHog.capture`). */
export interface PostHogCanaryClient {
  capture(input: {
    distinctId: string;
    event: string;
    properties: Record<string, unknown>;
  }): void;
  shutdown?(): Promise<void>;
}

/** Optional Sentry mirror sink — wired by `sentry-mirror.ts`. */
export interface SentryCanarySink {
  mirrorAlert(alert: CanaryAlertEvent): void;
}

let _client: PostHogCanaryClient | null = null;
let _sentrySink: SentryCanarySink | null = null;

/**
 * Wire a real PostHog client (e.g. `new PostHog(apiKey, { host })` from
 * `posthog-node`). Should be called once at boot via Medusa loader.
 */
export const setPostHogCanaryClient = (client: PostHogCanaryClient | null): void => {
  _client = client;
};

/** Wire the Sentry mirror sink. Called by `sentry-mirror.ts#wireMirror`. */
export const setSentryCanarySink = (sink: SentryCanarySink | null): void => {
  _sentrySink = sink;
};

/**
 * Mask `actor_id` per AR-25 PII-redaction-FORBIDDEN rule + Risk #3 mitigation.
 * SHA-256 + per-environment secret salt → truncated to 16 hex characters.
 *
 * Salt source: `CANARY_ACTOR_ID_SALT` env var (rotated quarterly; stored in
 * ops vault; NEVER in code). Falls back to a static dev-salt to keep tests
 * deterministic — production deploys MUST set the env var (validated by
 * `validate_canary_baseline.py` pre-deploy).
 */
export const maskActorId = (rawId: string): string => {
  const salt = process.env.CANARY_ACTOR_ID_SALT ?? "gp-canary-dev-salt-v1.5.0";
  return createHash("sha256")
    .update(`${salt}::${rawId}`)
    .digest("hex")
    .slice(0, 16);
};

/**
 * Sample size threshold for FM-71-9 alert fatigue suppression. Below this,
 * alerts are suppressed and a daily summary log records the count.
 */
export const CANARY_SUPPRESSION_THRESHOLD_N = 100;

/**
 * Emit a canary metric event to PostHog. Idempotent on `request_id`.
 *
 * The `track()` wrapper in `track.ts` is the preferred entry point — it
 * provides compile-time PII refusal. `emitCanaryMetric` is the lower-level
 * primitive used by trusted internal code.
 */
export const emitCanaryMetric = (event: CanaryMetricEvent): void => {
  if (!_client) return;
  _client.capture({
    distinctId: event.actor_id, // already masked
    event: `canary.metric.${event.metric_name}`,
    properties: {
      request_id: event.request_id,
      market_id: event.market_id,
      actor_id: event.actor_id,
      event_type: event.event_type,
      outcome: event.outcome,
      metric_name: event.metric_name,
      metric_value: event.metric_value,
      is_cold_start: event.is_cold_start ?? false,
      ...event.dimensions,
    },
  });
};

/**
 * Emit a canary divergence alert. PostHog is the source of truth; Sentry is
 * mirrored only for HIGH/CRITICAL (per D-68 mirror policy).
 *
 * Applies FM-71-9 suppression: if `sample_n < CANARY_SUPPRESSION_THRESHOLD_N`,
 * the alert is downgraded to a `canary.alert.suppressed_low_sample` event for
 * the daily summary dashboard, and Sentry is NOT paged.
 */
export const emitCanaryAlert = (alert: CanaryAlertEvent): "fired" | "suppressed" => {
  const suppressed = alert.sample_n < CANARY_SUPPRESSION_THRESHOLD_N;
  if (!_client) return suppressed ? "suppressed" : "fired";

  if (suppressed) {
    _client.capture({
      distinctId: alert.actor_id,
      event: "canary.alert.suppressed_low_sample",
      properties: {
        request_id: alert.request_id,
        market_id: alert.market_id,
        actor_id: alert.actor_id,
        event_type: alert.event_type,
        outcome: "suppressed",
        metric_name: alert.metric_name,
        metric_value: alert.metric_value,
        sample_n: alert.sample_n,
        suppression_threshold: CANARY_SUPPRESSION_THRESHOLD_N,
        runbook_path: alert.runbook_path,
      },
    });
    return "suppressed";
  }

  _client.capture({
    distinctId: alert.actor_id,
    event: `canary.alert.${alert.metric_name}`,
    properties: {
      request_id: alert.request_id,
      market_id: alert.market_id,
      actor_id: alert.actor_id,
      event_type: alert.event_type,
      outcome: alert.outcome,
      metric_name: alert.metric_name,
      metric_value: alert.metric_value,
      baseline_p50: alert.baseline_p50,
      baseline_p95: alert.baseline_p95,
      baseline_p99: alert.baseline_p99,
      divergence_sigma: alert.divergence_sigma,
      severity: alert.severity,
      sample_n: alert.sample_n,
      runbook_path: alert.runbook_path,
    },
  });

  // Mirror HIGH/CRITICAL to Sentry (D-68 mirror policy).
  if (alert.severity === "high" || alert.severity === "critical") {
    _sentrySink?.mirrorAlert(alert);
  }

  return "fired";
};

/**
 * Emit a forensic event (per AR-29). Three NEW v1.5.0 events:
 *   - `consent.audit.replay_attempted`
 *   - `mor.policy.replay_outcome`
 *   - `voucher.delivery.retry_decision`
 *
 * Forensic events extend the AR-25 envelope with replay-specific payload.
 * They are emitted independently of canary metrics; their job is post-mortem
 * reconstruction (NFR-OBS-5 ≥95% trace correlation for incident T+30min).
 */
export type ForensicEventName =
  | "consent.audit.replay_attempted"
  | "mor.policy.replay_outcome"
  | "voucher.delivery.retry_decision";

export interface ForensicEvent extends CanaryEnvelope {
  event_name: ForensicEventName;
  payload: Record<string, unknown>;
}

export const emitForensicEvent = (event: ForensicEvent): void => {
  if (!_client) return;
  _client.capture({
    distinctId: event.actor_id,
    event: event.event_name,
    properties: {
      request_id: event.request_id,
      market_id: event.market_id,
      actor_id: event.actor_id,
      event_type: event.event_type,
      outcome: event.outcome,
      ...event.payload,
    },
  });
};

/** Test-only helpers. */
export const __resetCanaryClientForTests = (): void => {
  _client = null;
  _sentrySink = null;
};
export const __getCanaryClientForTests = (): PostHogCanaryClient | null => _client;
export const __getSentrySinkForTests = (): SentryCanarySink | null => _sentrySink;
