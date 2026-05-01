import {
  CANARY_METRIC_NAMES,
  CANARY_SUPPRESSION_THRESHOLD_N,
  emitCanaryAlert,
  emitCanaryMetric,
  emitForensicEvent,
  maskActorId,
  setPostHogCanaryClient,
  setSentryCanarySink,
  __resetCanaryClientForTests,
  type CanaryAlertEvent,
  type CanaryMetricEvent,
  type ForensicEvent,
  type PostHogCanaryClient,
  type SentryCanarySink,
} from "../lib/instrumentation/posthog-canary";
import {
  setSentryMirrorClient,
  wireSentryMirror,
  __resetSentryMirrorForTests,
  type SentryMirrorClient,
} from "../lib/instrumentation/sentry-mirror";
import {
  buildEnvelope,
  PII_FORBIDDEN_FIELDS,
  trackAlert,
  trackForensic,
  trackMetric,
} from "../lib/instrumentation/track";
import canaryBaselineRolling, {
  CURRENT_SLICE_EXCLUSION_SQL,
  SCHEDULE_CRON,
  SCHEDULE_NAME,
  WINDOW_24H_MINUS_5MIN_SQL,
  computeWindow,
} from "../jobs/canary-baseline-rolling";

/**
 * canary-instrumentation tests — Story 1.4 unit coverage.
 *
 * Maps to:
 *   - AC-CANARY-1.4-01 (7-metric emission contract + AR-25 envelope)
 *   - AC-CANARY-1.4-02 (24h baseline rolling computation)
 *   - AC-CANARY-1.4-03 (divergence alert + Sentry HIGH/CRITICAL mirror)
 *   - AC-CANARY-1.4-04 (alert fatigue suppression for n<100)
 *   - AC-CANARY-1.4-05 (3 NEW forensic events satisfy NFR-OBS-5)
 */

interface CapturedCall {
  distinctId: string;
  event: string;
  properties: Record<string, unknown>;
}

const _makePostHogStub = (): { client: PostHogCanaryClient; calls: CapturedCall[] } => {
  const calls: CapturedCall[] = [];
  return {
    calls,
    client: {
      capture: (input) => calls.push(input),
    },
  };
};

interface SentryCall {
  kind: "captureMessage" | "setTag" | "addBreadcrumb";
  args: unknown;
}

const _makeSentryStub = (): { client: SentryMirrorClient; calls: SentryCall[] } => {
  const calls: SentryCall[] = [];
  return {
    calls,
    client: {
      captureMessage: (message, level) => {
        calls.push({ kind: "captureMessage", args: { message, level } });
        return "evt-id";
      },
      setTag: (key, value) => calls.push({ kind: "setTag", args: { key, value } }),
      addBreadcrumb: (crumb) => calls.push({ kind: "addBreadcrumb", args: crumb }),
    },
  };
};

beforeEach(() => {
  __resetCanaryClientForTests();
  __resetSentryMirrorForTests();
});

describe("CANARY_METRIC_NAMES — 7 metrics declared", () => {
  test("exactly 7 canonical metrics", () => {
    expect(CANARY_METRIC_NAMES).toHaveLength(7);
  });

  test("includes all required metric names per Story 1.4 scope #2", () => {
    expect(CANARY_METRIC_NAMES).toEqual(
      expect.arrayContaining([
        "vendor_offer_capacity_utilization",
        "mor_policy_evaluation_latency_p95",
        "voucher_pii_consent_completion_rate",
        "flag_state_transition_counter",
        "voucher_dispatch_success_rate",
        "cart_settlement_rate",
        "audit_log_write_rate",
      ])
    );
  });
});

describe("maskActorId — Risk #3 mitigation", () => {
  test("produces stable 16-hex output", () => {
    const masked = maskActorId("user-123");
    expect(masked).toMatch(/^[0-9a-f]{16}$/);
  });

  test("never returns the raw input", () => {
    const raw = "user-with-pii-12345";
    expect(maskActorId(raw)).not.toContain(raw);
  });

  test("deterministic for same input under same salt", () => {
    expect(maskActorId("a")).toBe(maskActorId("a"));
  });

  test("different inputs yield different masks", () => {
    expect(maskActorId("a")).not.toBe(maskActorId("b"));
  });

  test("salt rotation changes output", () => {
    const original = process.env.CANARY_ACTOR_ID_SALT;
    process.env.CANARY_ACTOR_ID_SALT = "salt-A";
    const a = maskActorId("user-1");
    process.env.CANARY_ACTOR_ID_SALT = "salt-B";
    const b = maskActorId("user-1");
    expect(a).not.toBe(b);
    if (original === undefined) delete process.env.CANARY_ACTOR_ID_SALT;
    else process.env.CANARY_ACTOR_ID_SALT = original;
  });
});

describe("emitCanaryMetric — AR-25 envelope (AC-CANARY-1.4-01)", () => {
  test("captures with envelope fields", () => {
    const stub = _makePostHogStub();
    setPostHogCanaryClient(stub.client);
    emitCanaryMetric({
      request_id: "req-1",
      market_id: "bonbeauty",
      actor_id: maskActorId("user-1"),
      event_type: "canary.metric",
      outcome: "pass",
      metric_name: "voucher_dispatch_success_rate",
      metric_value: 0.985,
    });
    expect(stub.calls).toHaveLength(1);
    expect(stub.calls[0].event).toBe("canary.metric.voucher_dispatch_success_rate");
    expect(stub.calls[0].properties).toMatchObject({
      request_id: "req-1",
      market_id: "bonbeauty",
      event_type: "canary.metric",
      outcome: "pass",
      metric_name: "voucher_dispatch_success_rate",
      metric_value: 0.985,
    });
  });

  test("no-op when client is not wired", () => {
    expect(() =>
      emitCanaryMetric({
        request_id: "req-1",
        market_id: "bonbeauty",
        actor_id: "abc",
        event_type: "canary.metric",
        outcome: "pass",
        metric_name: "cart_settlement_rate",
        metric_value: 0.99,
      })
    ).not.toThrow();
  });
});

describe("emitCanaryAlert — Sentry mirror + suppression (AC-CANARY-1.4-03 + 04)", () => {
  test("HIGH severity alert mirrors to Sentry", () => {
    const ph = _makePostHogStub();
    setPostHogCanaryClient(ph.client);

    const sentryStub = _makeSentryStub();
    setSentryMirrorClient(sentryStub.client);
    wireSentryMirror();

    const alert: CanaryAlertEvent = {
      request_id: "req-2",
      market_id: "bonbeauty",
      actor_id: "abc",
      event_type: "canary.alert",
      outcome: "fail",
      metric_name: "mor_policy_evaluation_latency_p95",
      metric_value: 1500,
      baseline_p50: 600,
      baseline_p95: 800,
      baseline_p99: 1000,
      divergence_sigma: 3.5,
      severity: "high",
      sample_n: 500,
      runbook_path: "gp-ops/runbooks/canary-alert-response.md",
    };
    const result = emitCanaryAlert(alert);
    expect(result).toBe("fired");
    const captureCalls = sentryStub.calls.filter((c) => c.kind === "captureMessage");
    expect(captureCalls).toHaveLength(1);
    const capArgs = captureCalls[0].args as { message: string; level: string };
    expect(capArgs.message).toContain("canary.divergence");
    expect(capArgs.level).toBe("error");
  });

  test("CRITICAL severity uses fatal level", () => {
    const ph = _makePostHogStub();
    setPostHogCanaryClient(ph.client);
    const sentryStub = _makeSentryStub();
    setSentryMirrorClient(sentryStub.client);
    wireSentryMirror();
    emitCanaryAlert({
      request_id: "req-3",
      market_id: "bonbeauty",
      actor_id: "abc",
      event_type: "canary.alert",
      outcome: "fail",
      metric_name: "audit_log_write_rate",
      metric_value: 0,
      baseline_p50: 100,
      baseline_p95: 150,
      baseline_p99: 200,
      divergence_sigma: 10,
      severity: "critical",
      sample_n: 1000,
      runbook_path: "gp-ops/runbooks/canary-alert-response.md",
    });
    const captureCalls = sentryStub.calls.filter((c) => c.kind === "captureMessage");
    expect((captureCalls[0].args as { level: string }).level).toBe("fatal");
  });

  test("WARNING severity does NOT mirror to Sentry (D-68 mirror policy)", () => {
    const ph = _makePostHogStub();
    setPostHogCanaryClient(ph.client);
    const sentryStub = _makeSentryStub();
    setSentryMirrorClient(sentryStub.client);
    wireSentryMirror();
    emitCanaryAlert({
      request_id: "req-4",
      market_id: "bonbeauty",
      actor_id: "abc",
      event_type: "canary.alert",
      outcome: "fail",
      metric_name: "cart_settlement_rate",
      metric_value: 0.9,
      baseline_p50: 0.95,
      baseline_p95: 0.97,
      baseline_p99: 0.98,
      divergence_sigma: 2.1,
      severity: "warning",
      sample_n: 500,
      runbook_path: "gp-ops/runbooks/canary-alert-response.md",
    });
    expect(sentryStub.calls.filter((c) => c.kind === "captureMessage")).toHaveLength(0);
  });

  test("suppresses alert when sample n<100 (FM-71-9 / AC-CANARY-1.4-04)", () => {
    const ph = _makePostHogStub();
    setPostHogCanaryClient(ph.client);
    const sentryStub = _makeSentryStub();
    setSentryMirrorClient(sentryStub.client);
    wireSentryMirror();

    const result = emitCanaryAlert({
      request_id: "req-5",
      market_id: "bonbeauty",
      actor_id: "abc",
      event_type: "canary.alert",
      outcome: "fail",
      metric_name: "voucher_dispatch_success_rate",
      metric_value: 0.5,
      baseline_p50: 0.95,
      baseline_p95: 0.97,
      baseline_p99: 0.98,
      divergence_sigma: 5,
      severity: "high",
      sample_n: 42, // below threshold of 100
      runbook_path: "gp-ops/runbooks/canary-alert-response.md",
    });
    expect(result).toBe("suppressed");
    expect(ph.calls).toHaveLength(1);
    expect(ph.calls[0].event).toBe("canary.alert.suppressed_low_sample");
    // Sentry MUST NOT be paged on suppression.
    expect(sentryStub.calls.filter((c) => c.kind === "captureMessage")).toHaveLength(0);
  });

  test("suppression threshold is exactly 100", () => {
    expect(CANARY_SUPPRESSION_THRESHOLD_N).toBe(100);
  });
});

describe("emitForensicEvent — 3 NEW events (AC-CANARY-1.4-05)", () => {
  const baseEnvelope = {
    request_id: "req-f-1",
    market_id: "bonbeauty",
    actor_id: maskActorId("user-z"),
    event_type: "forensic.replay",
    outcome: "pass" as const,
  };

  test("consent.audit.replay_attempted carries full envelope + payload", () => {
    const stub = _makePostHogStub();
    setPostHogCanaryClient(stub.client);
    const event: ForensicEvent = {
      ...baseEnvelope,
      event_name: "consent.audit.replay_attempted",
      payload: {
        recipient_id: "rec-123",
        original_audit_id: "aud-1",
        replay_outcome: "match",
      },
    };
    emitForensicEvent(event);
    expect(stub.calls[0].event).toBe("consent.audit.replay_attempted");
    expect(stub.calls[0].properties).toMatchObject({
      request_id: "req-f-1",
      market_id: "bonbeauty",
      event_type: "forensic.replay",
      outcome: "pass",
      recipient_id: "rec-123",
      original_audit_id: "aud-1",
      replay_outcome: "match",
    });
  });

  test("mor.policy.replay_outcome carries divergence_detected", () => {
    const stub = _makePostHogStub();
    setPostHogCanaryClient(stub.client);
    emitForensicEvent({
      ...baseEnvelope,
      event_name: "mor.policy.replay_outcome",
      payload: {
        order_id: "ord-1",
        evaluation_request_id: "eval-1",
        original_decision_path: ["a", "b"],
        replay_decision_path: ["a", "c"],
        divergence_detected: true,
      },
    });
    expect(stub.calls[0].properties).toMatchObject({
      divergence_detected: true,
    });
  });

  test("voucher.delivery.retry_decision carries decision + reason_code", () => {
    const stub = _makePostHogStub();
    setPostHogCanaryClient(stub.client);
    emitForensicEvent({
      ...baseEnvelope,
      event_name: "voucher.delivery.retry_decision",
      payload: {
        order_id: "ord-2",
        attempt_number: 3,
        decision: "dlq",
        reason_code: "PROVIDER_TIMEOUT",
      },
    });
    expect(stub.calls[0].properties).toMatchObject({
      decision: "dlq",
      reason_code: "PROVIDER_TIMEOUT",
    });
  });
});

describe("track() — PII refusal at runtime (Risk #3)", () => {
  beforeEach(() => {
    const stub = _makePostHogStub();
    setPostHogCanaryClient(stub.client);
  });

  test("trackMetric throws on `email` field", () => {
    expect(() =>
      trackMetric({
        request_id: "req-1",
        market_id: "bonbeauty",
        actor_id: "abc",
        event_type: "canary.metric",
        outcome: "pass",
        metric_name: "voucher_dispatch_success_rate",
        metric_value: 0.99,
        // @ts-expect-error — intentional: type system should refuse this at compile-time too.
        email: "foo@bar.com",
      })
    ).toThrow(/PII-redaction-FORBIDDEN/);
  });

  test("trackMetric throws on `phone_number` field (substring match)", () => {
    expect(() =>
      trackMetric({
        request_id: "req-1",
        market_id: "bonbeauty",
        actor_id: "abc",
        event_type: "canary.metric",
        outcome: "pass",
        metric_name: "voucher_dispatch_success_rate",
        metric_value: 0.99,
        // @ts-expect-error — intentional.
        phone_number: "555-0001",
      })
    ).toThrow(/phone/);
  });

  test("trackMetric throws on PII inside dimensions", () => {
    expect(() =>
      trackMetric({
        request_id: "req-1",
        market_id: "bonbeauty",
        actor_id: "abc",
        event_type: "canary.metric",
        outcome: "pass",
        metric_name: "voucher_dispatch_success_rate",
        metric_value: 0.99,
        dimensions: { user_email: "x@y" },
      })
    ).toThrow(/dimensions/);
  });

  test("trackMetric throws on missing AR-25 envelope field", () => {
    expect(() =>
      // @ts-expect-error — intentional: missing actor_id
      trackMetric({
        request_id: "req-1",
        market_id: "bonbeauty",
        event_type: "canary.metric",
        outcome: "pass",
        metric_name: "voucher_dispatch_success_rate",
        metric_value: 0.99,
      })
    ).toThrow(/AR-25 envelope/);
  });

  test("trackForensic throws on PII in nested payload", () => {
    expect(() =>
      trackForensic({
        request_id: "req-1",
        market_id: "bonbeauty",
        actor_id: "abc",
        event_type: "forensic.replay",
        outcome: "pass",
        event_name: "consent.audit.replay_attempted",
        payload: { recipient_email: "leak@example.com" },
      })
    ).toThrow(/nested payload/);
  });

  test("trackMetric passes when all envelope + non-PII fields present", () => {
    expect(() =>
      trackMetric({
        request_id: "req-1",
        market_id: "bonbeauty",
        actor_id: maskActorId("u-1"),
        event_type: "canary.metric",
        outcome: "pass",
        metric_name: "voucher_dispatch_success_rate",
        metric_value: 0.99,
      })
    ).not.toThrow();
  });

  test("PII_FORBIDDEN_FIELDS contains all 9 required patterns", () => {
    expect(PII_FORBIDDEN_FIELDS).toEqual(
      expect.arrayContaining([
        "email",
        "phone",
        "stripe_payment_intent",
        "session_token",
        "password",
        "card_number",
        "national_id",
        "address",
        "full_name",
      ])
    );
  });
});

describe("trackAlert returns suppressed for low sample", () => {
  test("returns suppressed when sample_n < 100", () => {
    const stub = _makePostHogStub();
    setPostHogCanaryClient(stub.client);
    const result = trackAlert({
      request_id: "req-1",
      market_id: "bonbeauty",
      actor_id: "abc",
      event_type: "canary.alert",
      outcome: "fail",
      metric_name: "audit_log_write_rate",
      metric_value: 0,
      baseline_p50: 100,
      baseline_p95: 150,
      baseline_p99: 200,
      divergence_sigma: 10,
      severity: "high",
      sample_n: 5,
      runbook_path: "gp-ops/runbooks/canary-alert-response.md",
    });
    expect(result).toBe("suppressed");
  });
});

describe("buildEnvelope helper", () => {
  test("masks actor_id automatically", () => {
    const env = buildEnvelope({
      request_id: "req-1",
      market_id: "bonbeauty",
      raw_actor_id: "user-12345",
      event_type: "canary.metric",
      outcome: "pass",
    });
    expect(env.actor_id).toMatch(/^[0-9a-f]{16}$/);
    expect(env.actor_id).not.toBe("user-12345");
  });
});

describe("canary-baseline-rolling job (AC-CANARY-1.4-02)", () => {
  test("schedule cron is every 5min", () => {
    expect(SCHEDULE_CRON).toBe("*/5 * * * *");
    expect(SCHEDULE_NAME).toBe("canary-baseline-rolling");
  });

  test("window SQL uses 24h trailing minus 5min slice (FM-71-2 clock-skew safe)", () => {
    expect(WINDOW_24H_MINUS_5MIN_SQL).toContain("24 hours");
    expect(CURRENT_SLICE_EXCLUSION_SQL).toContain("5 minutes");
  });

  test("computeWindow uses warehouse now() not app clock", async () => {
    const calls: Array<{ sql: string; params?: unknown[] }> = [];
    const queryStub = {
      query: async (sql: string, params?: unknown[]) => {
        calls.push({ sql, params });
        return {
          rows: [
            {
              window_start: "2026-04-29T00:00:00.000Z",
              window_end: "2026-04-29T23:55:00.000Z",
              current_slice_start: "2026-04-29T23:55:00.000Z",
            },
          ],
        };
      },
    };
    const result = await computeWindow(queryStub);
    expect(calls[0].sql).toContain("now()");
    expect(calls[0].sql).toContain("interval '24 hours'");
    expect(calls[0].sql).toContain("interval '5 minutes'");
    expect(result.window_end_utc).toContain("2026-04-29");
  });

  test("job exits cleanly when DB is not wired (test/no-DB env)", async () => {
    const fakeContainer = {
      resolve: () => {
        throw new Error("not registered");
      },
    } as unknown as Parameters<typeof canaryBaselineRolling>[0];
    await expect(canaryBaselineRolling(fakeContainer)).resolves.toBeUndefined();
  });
});

describe("integration: full alert flow with Sentry sink wired", () => {
  test("HIGH alert flows from PostHog client → Sentry mirror end-to-end", () => {
    const ph = _makePostHogStub();
    setPostHogCanaryClient(ph.client);
    const sentryStub = _makeSentryStub();
    setSentryMirrorClient(sentryStub.client);
    const sink = wireSentryMirror();
    expect(sink.mirrorAlert).toBeDefined();

    emitCanaryAlert({
      request_id: "req-int-1",
      market_id: "bonbeauty",
      actor_id: maskActorId("user-1"),
      event_type: "canary.alert",
      outcome: "fail",
      metric_name: "voucher_pii_consent_completion_rate",
      metric_value: 0.6,
      baseline_p50: 0.95,
      baseline_p95: 0.97,
      baseline_p99: 0.98,
      divergence_sigma: 4.2,
      severity: "high",
      sample_n: 250,
      runbook_path: "gp-ops/runbooks/canary-alert-response.md",
    });

    // PostHog received the alert
    expect(ph.calls.some((c) => c.event.startsWith("canary.alert"))).toBe(true);
    // Sentry mirror was invoked
    expect(sentryStub.calls.some((c) => c.kind === "captureMessage")).toBe(true);
    // Runbook path tagged
    expect(
      sentryStub.calls.some(
        (c) =>
          c.kind === "setTag" &&
          (c.args as { key: string }).key === "canary.runbook"
      )
    ).toBe(true);
  });

  test("setSentryCanarySink null disables mirror (idempotent reset)", () => {
    const sink: SentryCanarySink = { mirrorAlert: jest.fn() };
    setSentryCanarySink(sink);
    setSentryCanarySink(null);
    const ph = _makePostHogStub();
    setPostHogCanaryClient(ph.client);
    emitCanaryAlert({
      request_id: "req-1",
      market_id: "bonbeauty",
      actor_id: "abc",
      event_type: "canary.alert",
      outcome: "fail",
      metric_name: "audit_log_write_rate",
      metric_value: 0,
      baseline_p50: 100,
      baseline_p95: 150,
      baseline_p99: 200,
      divergence_sigma: 10,
      severity: "critical",
      sample_n: 1000,
      runbook_path: "gp-ops/runbooks/canary-alert-response.md",
    });
    expect(sink.mirrorAlert).not.toHaveBeenCalled();
  });
});
