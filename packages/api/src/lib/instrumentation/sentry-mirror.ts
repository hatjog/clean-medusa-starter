/**
 * sentry-mirror — D-68 Sentry HIGH/CRITICAL mirror for canary alerts.
 *
 * PostHog is the canary state of record; Sentry is a *mirror only* for HIGH and
 * CRITICAL severity alerts. This avoids double-paging while ensuring deep stack
 * traces + on-call paging via PagerDuty-equivalent channel reach the on-call
 * operator within the I6 SLA (30min mean ack).
 *
 * Mirror direction: PostHog → Sentry (one-way; Sentry NEVER feeds back).
 *
 * Sentry projects (per AR-31 / Step 7 supplement L2456-2463 — see
 * `gp-ops/dashboards/sentry-canary-projects.yaml`):
 *   - gp-backend-prod (HIGH+ severity → Ops on-call)
 *   - gp-storefront-prod (ERROR+ for Tier 1 surfaces → Ops on-call → Sally for UX)
 *   - gp-jobs-prod (cron failure → Ops on-call)
 *   - gp-workers-prod (DLQ overflow + worker crash → Ops on-call → Architecture lead)
 *
 * @see _bmad-output/planning-artifacts/architecture.md L436-448 (D-68)
 * @see _bmad-output/implementation-artifacts/v150/STORY-1-4-CANARY-INSTRUMENTATION.md
 * @see GP/backend/src/jobs/audit-hash-chain-validate.ts (Story 1.1 Sentry alert pattern)
 */

import {
  setSentryCanarySink,
  type CanaryAlertEvent,
  type SentryCanarySink,
} from "./posthog-canary";

/**
 * Minimal Sentry client interface (matches `@sentry/node` `Sentry.captureMessage`
 * + `setTag` + `addBreadcrumb`).
 */
export interface SentryMirrorClient {
  captureMessage(
    message: string,
    level?: "fatal" | "error" | "warning" | "info" | "debug"
  ): string;
  setTag(key: string, value: string): void;
  addBreadcrumb(crumb: {
    category: string;
    message: string;
    level?: string;
    data?: Record<string, unknown>;
  }): void;
}

let _sentry: SentryMirrorClient | null = null;

export const setSentryMirrorClient = (client: SentryMirrorClient | null): void => {
  _sentry = client;
};

const _severityToLevel = (
  severity: CanaryAlertEvent["severity"]
): "fatal" | "error" | "warning" => {
  switch (severity) {
    case "critical":
      return "fatal";
    case "high":
      return "error";
    default:
      return "warning";
  }
};

/**
 * Mirror a canary alert to Sentry. Only HIGH/CRITICAL reaches here per D-68
 * mirror policy (the gate is in `posthog-canary.ts#emitCanaryAlert`).
 *
 * Sentry tag conventions (mirror runbook + AR-31 dashboard ownership):
 *   - canary.metric: <metric_name>
 *   - canary.severity: high | critical
 *   - canary.market: <market_id>
 *   - canary.runbook: gp-ops/runbooks/canary-alert-response.md
 */
const _mirrorAlert = (alert: CanaryAlertEvent): void => {
  if (!_sentry) return;

  _sentry.setTag("canary.metric", alert.metric_name);
  _sentry.setTag("canary.severity", alert.severity);
  _sentry.setTag("canary.market", alert.market_id);
  _sentry.setTag("canary.runbook", alert.runbook_path);

  _sentry.addBreadcrumb({
    category: "canary.divergence",
    level: alert.severity === "critical" ? "fatal" : "error",
    message: `canary divergence ${alert.metric_name} ${alert.divergence_sigma.toFixed(2)}σ`,
    data: {
      request_id: alert.request_id,
      market_id: alert.market_id,
      metric_name: alert.metric_name,
      metric_value: alert.metric_value,
      baseline_p50: alert.baseline_p50,
      baseline_p95: alert.baseline_p95,
      baseline_p99: alert.baseline_p99,
      divergence_sigma: alert.divergence_sigma,
      sample_n: alert.sample_n,
    },
  });

  const message =
    `canary.divergence: metric=${alert.metric_name} market=${alert.market_id} ` +
    `value=${alert.metric_value} σ=${alert.divergence_sigma.toFixed(2)} ` +
    `n=${alert.sample_n} runbook=${alert.runbook_path}`;
  _sentry.captureMessage(message, _severityToLevel(alert.severity));
};

/**
 * Wire the Sentry mirror into the PostHog canary pipeline. Should be called
 * once at boot, after `setPostHogCanaryClient` + `setSentryMirrorClient` are
 * both wired.
 */
export const wireSentryMirror = (): SentryCanarySink => {
  const sink: SentryCanarySink = {
    mirrorAlert: _mirrorAlert,
  };
  setSentryCanarySink(sink);
  return sink;
};

/** Test-only helpers. */
export const __resetSentryMirrorForTests = (): void => {
  _sentry = null;
  setSentryCanarySink(null);
};

export const __mirrorAlertForTests = (alert: CanaryAlertEvent): void => {
  _mirrorAlert(alert);
};
