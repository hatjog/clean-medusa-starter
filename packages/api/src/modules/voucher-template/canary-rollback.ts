/**
 * canary-rollback — STORY-2-3 AR-4 auto-rollback hook for E-R11 flag flip.
 *
 * Consumes Story 1.4 canary divergence alerts and, when the threshold is
 * crossed, calls the per-market RuntimeFlagResolver to flip the flag back
 * to "off". Fully audited — the rollback itself emits another
 * `voucher.template.runtime.activated.v1` event with `new_state: "off"` and
 * `actor_id: "system:canary"`.
 *
 * Logic:
 *   1. Activated event captured at T0 → register a 60-min observation window.
 *   2. Inside window, sample three metrics (consent completion rate, dispatch
 *      latency p95, runtime error rate) and compute z-score against the
 *      pre-flip baseline (Story 1.4).
 *   3. If divergence > 2σ on ANY metric → call `resolver.flip({new_state: "off",
 *      reason: "canary_auto_rollback", actor_id: "system:canary"})`.
 *   4. After rollback, watch a second 60-min window. If divergence persists →
 *      Sentry CRITICAL + ops on-call page; do NOT auto-flip ON again.
 *
 * Per pre-mortem #34: a forged signoff would not bypass the canary — the
 * canary observes runtime metrics, NOT signoff state. Rollback is therefore
 * the second line of defence after D-59.
 *
 * @see _bmad-output/implementation-artifacts/v150/STORY-1-4-CANARY-INSTRUMENTATION.md
 * @see _bmad-output/planning-artifacts/architecture.md L573-578 (D-79 + AR-4)
 */

import {
  RuntimeFlagResolver,
  type RuntimeFlagState,
} from "./runtime-flag-resolver";

export type CanaryMetricKey =
  | "voucher.recipient.consent.completion_rate"
  | "voucher.delivery.dispatch.latency_p95"
  | "voucher.template.runtime.error_rate";

export const TRACKED_METRICS: ReadonlyArray<CanaryMetricKey> = [
  "voucher.recipient.consent.completion_rate",
  "voucher.delivery.dispatch.latency_p95",
  "voucher.template.runtime.error_rate",
];

/** Default per AC-VTEMP-RUNTIME-2.3-01 ("within 60min"). */
export const DEFAULT_OBSERVATION_WINDOW_MS = 60 * 60 * 1000;
export const DEFAULT_DIVERGENCE_SIGMA = 2.0;

export interface MetricSample {
  metric: CanaryMetricKey;
  value: number;
  timestamp_ms: number;
}

export interface MetricBaseline {
  metric: CanaryMetricKey;
  /** Mean across the pre-flip 24h baseline window. */
  mean: number;
  /** Standard deviation across the pre-flip 24h baseline window. */
  stddev: number;
  /** Sample size in the baseline window — used for FM-71-9 suppression. */
  sample_n: number;
}

/** Source of pre-flip baselines (committed evidence files per AC-TELEMETRY-BASELINE-01). */
export interface BaselineLoaderPort {
  loadBaseline(input: { market_id: string; metric: CanaryMetricKey }): Promise<MetricBaseline | null>;
}

/** Reads metrics inside the post-flip observation window. */
export interface MetricSamplerPort {
  sample(input: {
    market_id: string;
    metric: CanaryMetricKey;
    window_start_ms: number;
    window_end_ms: number;
  }): Promise<MetricSample[]>;
}

/** Sentry escalation when post-rollback divergence persists. */
export interface CanaryEscalationPort {
  pageOnCallCritical(input: {
    market_id: string;
    reason: "post_rollback_divergence_persists" | "auto_rollback_failed";
    metrics: Array<{ metric: CanaryMetricKey; value: number; sigma: number }>;
  }): Promise<void>;
}

export interface DivergenceFinding {
  metric: CanaryMetricKey;
  value: number;
  baseline: MetricBaseline;
  sigma: number;
  divergent: boolean;
}

export interface RollbackDecision {
  market_id: string;
  rolled_back: boolean;
  reason:
    | "no_divergence"
    | "divergence_within_threshold"
    | "auto_rollback_executed"
    | "auto_rollback_skipped_low_sample"
    | "post_rollback_persists_paged";
  findings: DivergenceFinding[];
  /** Set when `rolled_back === true` AND the resolver flip succeeded. */
  rollback_event_id?: string;
}

const SUPPRESSION_THRESHOLD_N = 100;

export class CanaryRollback {
  constructor(
    private readonly resolver: RuntimeFlagResolver,
    private readonly baselines: BaselineLoaderPort,
    private readonly sampler: MetricSamplerPort,
    private readonly escalation: CanaryEscalationPort,
    private readonly opts: {
      window_ms?: number;
      sigma?: number;
      now?: () => number;
    } = {}
  ) {}

  /**
   * Evaluate the post-flip observation window for `market_id`. If any tracked
   * metric diverges > Nσ from baseline AND sample_n ≥ suppression threshold,
   * auto-rollback the flag to OFF.
   */
  async evaluateAndMaybeRollback(input: {
    market_id: string;
    flip_timestamp_ms: number;
  }): Promise<RollbackDecision> {
    if (!input.market_id) throw new Error("CanaryRollback.evaluate: market_id is required");
    const window = this.opts.window_ms ?? DEFAULT_OBSERVATION_WINDOW_MS;
    const sigma = this.opts.sigma ?? DEFAULT_DIVERGENCE_SIGMA;
    const now = this.opts.now ?? (() => Date.now());

    const windowEnd = Math.min(input.flip_timestamp_ms + window, now());
    const findings: DivergenceFinding[] = [];

    let lowSample = false;

    for (const metric of TRACKED_METRICS) {
      const baseline = await this.baselines.loadBaseline({ market_id: input.market_id, metric });
      if (!baseline) continue; // Baseline unavailable — Story 1.4 owns evidence capture.

      const samples = await this.sampler.sample({
        market_id: input.market_id,
        metric,
        window_start_ms: input.flip_timestamp_ms,
        window_end_ms: windowEnd,
      });
      if (samples.length === 0) continue;

      const value = mean(samples.map((s) => s.value));
      const z = baseline.stddev > 0 ? Math.abs((value - baseline.mean) / baseline.stddev) : 0;
      const divergent = z > sigma;

      findings.push({
        metric,
        value,
        baseline,
        sigma: z,
        divergent,
      });

      if (divergent && samples.length < SUPPRESSION_THRESHOLD_N) {
        lowSample = true;
      }
    }

    const anyDivergent = findings.some((f) => f.divergent);
    if (!anyDivergent) {
      return {
        market_id: input.market_id,
        rolled_back: false,
        reason: findings.length === 0 ? "no_divergence" : "divergence_within_threshold",
        findings,
      };
    }

    if (lowSample) {
      // FM-71-9 suppression — do not auto-rollback on too-small samples.
      return {
        market_id: input.market_id,
        rolled_back: false,
        reason: "auto_rollback_skipped_low_sample",
        findings,
      };
    }

    // Auto-rollback path.
    try {
      const flip = await this.resolver.flip({
        market_id: input.market_id,
        new_state: "off" satisfies RuntimeFlagState,
        reason: "canary_auto_rollback",
        actor_id: "system:canary",
      });
      return {
        market_id: input.market_id,
        rolled_back: true,
        reason: "auto_rollback_executed",
        findings,
        rollback_event_id: flip.event_id,
      };
    } catch (err) {
      await this.escalation.pageOnCallCritical({
        market_id: input.market_id,
        reason: "auto_rollback_failed",
        metrics: findings
          .filter((f) => f.divergent)
          .map((f) => ({ metric: f.metric, value: f.value, sigma: f.sigma })),
      });
      throw err;
    }
  }

  /**
   * Second-window verification after a rollback. Used by ops automation; pages
   * Sentry CRITICAL when divergence persists post-flip-OFF.
   */
  async verifyPostRollback(input: {
    market_id: string;
    rollback_timestamp_ms: number;
  }): Promise<RollbackDecision> {
    const window = this.opts.window_ms ?? DEFAULT_OBSERVATION_WINDOW_MS;
    const sigma = this.opts.sigma ?? DEFAULT_DIVERGENCE_SIGMA;

    const findings: DivergenceFinding[] = [];

    for (const metric of TRACKED_METRICS) {
      const baseline = await this.baselines.loadBaseline({ market_id: input.market_id, metric });
      if (!baseline) continue;
      const samples = await this.sampler.sample({
        market_id: input.market_id,
        metric,
        window_start_ms: input.rollback_timestamp_ms,
        window_end_ms: input.rollback_timestamp_ms + window,
      });
      if (samples.length === 0) continue;
      const value = mean(samples.map((s) => s.value));
      const z = baseline.stddev > 0 ? Math.abs((value - baseline.mean) / baseline.stddev) : 0;
      findings.push({
        metric,
        value,
        baseline,
        sigma: z,
        divergent: z > sigma,
      });
    }

    const persists = findings.some((f) => f.divergent);
    if (persists) {
      await this.escalation.pageOnCallCritical({
        market_id: input.market_id,
        reason: "post_rollback_divergence_persists",
        metrics: findings
          .filter((f) => f.divergent)
          .map((f) => ({ metric: f.metric, value: f.value, sigma: f.sigma })),
      });
      return {
        market_id: input.market_id,
        rolled_back: false,
        reason: "post_rollback_persists_paged",
        findings,
      };
    }

    return {
      market_id: input.market_id,
      rolled_back: false,
      reason: "no_divergence",
      findings,
    };
  }
}

function mean(xs: number[]): number {
  if (xs.length === 0) return 0;
  let sum = 0;
  for (const x of xs) sum += x;
  return sum / xs.length;
}
