/**
 * promotion-workflow.test — STORY-2-3 unit coverage for the state machine
 * + canary-rollback wiring.
 *
 * Maps to:
 *   - AC-VTEMP-RUNTIME-2.3-01 (per-market flag flip + atomic audit + canary
 *     auto-rollback within 60min on > 2σ divergence)
 *   - AC-VTEMP-RUNTIME-2.3-04 (flag-off snapshot preservation — promote
 *     rejects when flag = OFF; runtime preserves prior behaviour)
 */

import {
  RuntimeFlagResolver,
  type FlagWritePort,
  type LegalSignoffPort,
  type LegalSignoffStatus,
  type RuntimeEventEmitterPort,
  type RuntimeFlagState,
  LegalSignoffMissingError,
  DualKeyOverrideMissingError,
  GlobalFlipForbiddenError,
} from "../runtime-flag-resolver";
import {
  PromotionWorkflow,
  PromotionPathInvalidError,
  RuntimeDisabledError,
  isLegalEdge,
  type PromotionAuditPort,
  type PromotionEventEmitterPort,
  type TemplateStatus,
  type TemplateStatusPort,
} from "../promotion-workflow";
import {
  CanaryRollback,
  TRACKED_METRICS,
  type BaselineLoaderPort,
  type CanaryEscalationPort,
  type CanaryMetricKey,
  type MetricBaseline,
  type MetricSample,
  type MetricSamplerPort,
} from "../canary-rollback";

// ──────────────────────────────────────────────────────────────────────────────
// Helpers — in-memory ports.
// ──────────────────────────────────────────────────────────────────────────────

function makeFlagPort(initial: Record<string, RuntimeFlagState> = {}): FlagWritePort & {
  state: Record<string, RuntimeFlagState>;
  transitions: Array<{ market_id: string; new_state: RuntimeFlagState; actor_id: string; reason: string }>;
} {
  const state: Record<string, RuntimeFlagState> = { ...initial };
  const transitions: Array<{
    market_id: string;
    new_state: RuntimeFlagState;
    actor_id: string;
    reason: string;
  }> = [];
  let auditCounter = 0;
  return {
    state,
    transitions,
    async transition(input) {
      const prior = state[input.market_id] ?? "off";
      state[input.market_id] = input.new_state;
      transitions.push({
        market_id: input.market_id,
        new_state: input.new_state,
        actor_id: input.actor_id,
        reason: input.reason,
      });
      return { prior_state: prior, audit_row_id: `audit-${++auditCounter}` };
    },
    async read(input) {
      return {
        state: state[input.market_id] ?? "off",
        last_transition_at: null,
      };
    },
  };
}

function makeLegalPort(byMarket: Record<string, LegalSignoffStatus>): LegalSignoffPort {
  return {
    async readSignoff(marketId) {
      return (
        byMarket[marketId] ?? {
          signoff_status: "pending",
          signed_at: null,
          pdf_hash: null,
          last_hash_verified_at: null,
        }
      );
    },
  };
}

function makeRuntimeEmitter(): RuntimeEventEmitterPort & {
  emitted: Array<{ market_id: string; new_state: RuntimeFlagState; actor_id: string }>;
} {
  const emitted: Array<{ market_id: string; new_state: RuntimeFlagState; actor_id: string }> = [];
  let evCounter = 0;
  return {
    emitted,
    async emitActivated(input) {
      emitted.push({
        market_id: input.market_id,
        new_state: input.new_state,
        actor_id: input.actor_id,
      });
      return { event_id: `ev-${++evCounter}` };
    },
  };
}

const APPROVED: LegalSignoffStatus = {
  signoff_status: "approved",
  signed_at: "2026-04-29T12:00:00.000Z",
  pdf_hash: "deadbeef".repeat(8),
  last_hash_verified_at: "2026-04-29T12:00:00.000Z",
};

// ──────────────────────────────────────────────────────────────────────────────
// RuntimeFlagResolver — D-59 gate + per-market scope.
// ──────────────────────────────────────────────────────────────────────────────

describe("RuntimeFlagResolver — D-59 hard gate", () => {
  test("OFF→ON for approved market succeeds and emits activated event", async () => {
    const flag = makeFlagPort({ pl: "off" });
    const legal = makeLegalPort({ pl: APPROVED });
    const events = makeRuntimeEmitter();
    const r = new RuntimeFlagResolver(flag, legal, events, () => new Date("2026-05-01T00:00:00Z"));

    const res = await r.flip({
      market_id: "pl",
      new_state: "on",
      reason: "v1.5.0_runtime_activation",
      actor_id: "ops:robert",
    });

    expect(res.prior_state).toBe("off");
    expect(res.new_state).toBe("on");
    expect(flag.state.pl).toBe("on");
    expect(events.emitted).toHaveLength(1);
    expect(events.emitted[0]).toMatchObject({ market_id: "pl", new_state: "on" });
    expect(res.legal_signoff.signoff_status).toBe("approved");
    expect(res.override_used).toBe(false);
  });

  test("OFF→ON without approved signoff throws LegalSignoffMissingError", async () => {
    const flag = makeFlagPort({ pl: "off" });
    const legal = makeLegalPort({ pl: { ...APPROVED, signoff_status: "pending" } });
    const events = makeRuntimeEmitter();
    const r = new RuntimeFlagResolver(flag, legal, events);

    await expect(
      r.flip({
        market_id: "pl",
        new_state: "on",
        reason: "test",
        actor_id: "ops:robert",
      })
    ).rejects.toBeInstanceOf(LegalSignoffMissingError);

    // Flag MUST stay OFF; no event MUST have been emitted.
    expect(flag.state.pl).toBe("off");
    expect(events.emitted).toHaveLength(0);
  });

  test("OFF→ON for forged signoff throws and records nothing", async () => {
    const flag = makeFlagPort({ pl: "off" });
    const legal = makeLegalPort({ pl: { ...APPROVED, signoff_status: "forged" } });
    const events = makeRuntimeEmitter();
    const r = new RuntimeFlagResolver(flag, legal, events);

    await expect(
      r.flip({
        market_id: "pl",
        new_state: "on",
        reason: "test",
        actor_id: "ops:robert",
      })
    ).rejects.toBeInstanceOf(LegalSignoffMissingError);
    expect(flag.transitions).toHaveLength(0);
  });

  test("ON→OFF (rollback) does not require legal signoff", async () => {
    const flag = makeFlagPort({ pl: "on" });
    const legal = makeLegalPort({ pl: { ...APPROVED, signoff_status: "revoked" } });
    const events = makeRuntimeEmitter();
    const r = new RuntimeFlagResolver(flag, legal, events);

    const res = await r.flip({
      market_id: "pl",
      new_state: "off",
      reason: "canary_auto_rollback",
      actor_id: "system:canary",
    });

    expect(res.new_state).toBe("off");
    expect(flag.state.pl).toBe("off");
    expect(events.emitted).toHaveLength(1);
  });

  test("dual-key override allows bypass; single-key override rejected", async () => {
    const flag = makeFlagPort({ pl: "off" });
    const legal = makeLegalPort({ pl: { ...APPROVED, signoff_status: "pending" } });
    const events = makeRuntimeEmitter();
    const r = new RuntimeFlagResolver(flag, legal, events);

    await expect(
      r.flip({
        market_id: "pl",
        new_state: "on",
        reason: "emergency_override",
        actor_id: "ops:robert",
        override: {
          architect_actor_id: "arch:winston",
          compliance_actor_id: "",
          justification: "incident-1234",
        },
      })
    ).rejects.toBeInstanceOf(DualKeyOverrideMissingError);

    const res = await r.flip({
      market_id: "pl",
      new_state: "on",
      reason: "emergency_override",
      actor_id: "ops:robert",
      override: {
        architect_actor_id: "arch:winston",
        compliance_actor_id: "comp:officer",
        justification: "incident-1234",
      },
    });
    expect(res.override_used).toBe(true);
    expect(flag.state.pl).toBe("on");
    expect(events.emitted[0].actor_id).toContain("override:arch:winston+comp:officer");
  });

  test("rejects global flip via market_id='*' or 'all'", async () => {
    const r = new RuntimeFlagResolver(makeFlagPort(), makeLegalPort({}), makeRuntimeEmitter());
    await expect(
      r.flip({ market_id: "*", new_state: "on", reason: "x", actor_id: "ops" })
    ).rejects.toBeInstanceOf(GlobalFlipForbiddenError);
    await expect(
      r.flip({ market_id: "all", new_state: "on", reason: "x", actor_id: "ops" })
    ).rejects.toBeInstanceOf(GlobalFlipForbiddenError);
  });

  test("idempotent same-state flip returns noop event_id", async () => {
    const flag = makeFlagPort({ pl: "on" });
    const legal = makeLegalPort({ pl: APPROVED });
    const events = makeRuntimeEmitter();
    const r = new RuntimeFlagResolver(flag, legal, events);

    const res = await r.flip({
      market_id: "pl",
      new_state: "on",
      reason: "noop",
      actor_id: "ops:robert",
    });
    expect(res.event_id).toBe("noop");
    expect(events.emitted).toHaveLength(0);
  });

  test("getRuntimeStatus exposes flag + signoff snapshot read-only", async () => {
    const flag = makeFlagPort({ pl: "on" });
    const legal = makeLegalPort({ pl: APPROVED });
    const r = new RuntimeFlagResolver(flag, legal, makeRuntimeEmitter());
    const s = await r.getRuntimeStatus({ market_id: "pl" });
    expect(s.flag_state).toBe("on");
    expect(s.legal_signoff.signoff_status).toBe("approved");
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// PromotionWorkflow — state machine + audit-first contract.
// ──────────────────────────────────────────────────────────────────────────────

describe("PromotionWorkflow — DRAFT → REVIEW → APPROVED → PUBLISHED", () => {
  function setupResolver(state: RuntimeFlagState = "on"): RuntimeFlagResolver {
    const flag = makeFlagPort({ pl: state });
    const legal = makeLegalPort({ pl: APPROVED });
    return new RuntimeFlagResolver(flag, legal, makeRuntimeEmitter());
  }

  function makeAuditPort(): PromotionAuditPort & {
    rows: Array<{ template_id: string; from_status: TemplateStatus; to_status: TemplateStatus }>;
  } {
    const rows: Array<{ template_id: string; from_status: TemplateStatus; to_status: TemplateStatus }> = [];
    let i = 0;
    return {
      rows,
      async appendPromotionAuditRow(input) {
        rows.push({
          template_id: input.template_id,
          from_status: input.from_status,
          to_status: input.to_status,
        });
        return { audit_row_id: `audit-${++i}` };
      },
    };
  }

  function makeTemplatePort(initial: TemplateStatus | null): TemplateStatusPort & {
    status: TemplateStatus | null;
  } {
    const port: any = { status: initial };
    port.readStatus = async () => port.status;
    port.updateStatus = async (input: any) => {
      if (port.status !== input.expected_from) {
        return { rows_affected: 0 };
      }
      port.status = input.new_status;
      return { rows_affected: 1 };
    };
    return port;
  }

  function makeEventPort(): PromotionEventEmitterPort & {
    log: Array<{ kind: string; template_id: string }>;
  } {
    const log: Array<{ kind: string; template_id: string }> = [];
    return {
      log,
      async emitSubmittedForApproval(i) {
        log.push({ kind: "submitted_for_approval", template_id: i.template_id });
      },
      async emitApproved(i) {
        log.push({ kind: "approved", template_id: i.template_id });
      },
      async emitRejected(i) {
        log.push({ kind: "rejected", template_id: i.template_id });
      },
    };
  }

  test("isLegalEdge — happy paths + reject paths", () => {
    expect(isLegalEdge("DRAFT", "REVIEW")).toBe(true);
    expect(isLegalEdge("REVIEW", "APPROVED")).toBe(true);
    expect(isLegalEdge("APPROVED", "PUBLISHED")).toBe(true);
    expect(isLegalEdge("REVIEW", "REJECTED")).toBe(true);
    expect(isLegalEdge("APPROVED", "REJECTED")).toBe(true);
    // illegal edges
    expect(isLegalEdge("DRAFT", "APPROVED")).toBe(false);
    expect(isLegalEdge("DRAFT", "PUBLISHED")).toBe(false);
    expect(isLegalEdge("PUBLISHED", "DRAFT")).toBe(false);
    expect(isLegalEdge("DRAFT", "REJECTED")).toBe(false); // DRAFT is reject-immune
    expect(isLegalEdge("REJECTED", "DRAFT")).toBe(false);
  });

  test("flag OFF rejects every promotion with RuntimeDisabledError", async () => {
    const wf = new PromotionWorkflow(
      setupResolver("off"),
      makeAuditPort(),
      makeTemplatePort("DRAFT"),
      makeEventPort()
    );
    await expect(
      wf.promote({
        template_id: "tpl-1",
        market_id: "pl",
        from_status: "DRAFT",
        to_status: "REVIEW",
        actor_id: "vendor:bonbeauty",
      })
    ).rejects.toBeInstanceOf(RuntimeDisabledError);
  });

  test("DRAFT → REVIEW writes audit row before status update + emits submitted event", async () => {
    const audit = makeAuditPort();
    const tpl = makeTemplatePort("DRAFT");
    const events = makeEventPort();
    const wf = new PromotionWorkflow(setupResolver("on"), audit, tpl, events);

    const r = await wf.promote({
      template_id: "tpl-1",
      market_id: "pl",
      from_status: "DRAFT",
      to_status: "REVIEW",
      actor_id: "vendor:bonbeauty",
    });

    expect(r.from_status).toBe("DRAFT");
    expect(r.to_status).toBe("REVIEW");
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]).toMatchObject({ from_status: "DRAFT", to_status: "REVIEW" });
    expect(tpl.status).toBe("REVIEW");
    expect(events.log).toEqual([{ kind: "submitted_for_approval", template_id: "tpl-1" }]);
  });

  test("REVIEW → APPROVED → PUBLISHED full forward chain", async () => {
    const audit = makeAuditPort();
    const tpl = makeTemplatePort("REVIEW");
    const events = makeEventPort();
    const wf = new PromotionWorkflow(setupResolver("on"), audit, tpl, events);

    await wf.promote({
      template_id: "tpl-2",
      market_id: "pl",
      from_status: "REVIEW",
      to_status: "APPROVED",
      actor_id: "ops:moderator",
    });
    expect(tpl.status).toBe("APPROVED");
    await wf.promote({
      template_id: "tpl-2",
      market_id: "pl",
      from_status: "APPROVED",
      to_status: "PUBLISHED",
      actor_id: "ops:moderator",
    });
    expect(tpl.status).toBe("PUBLISHED");
    expect(audit.rows).toHaveLength(2);
    expect(events.log.map((e) => e.kind)).toEqual(["approved", "approved"]);
  });

  test("illegal edge DRAFT → APPROVED throws PromotionPathInvalidError", async () => {
    const wf = new PromotionWorkflow(
      setupResolver("on"),
      makeAuditPort(),
      makeTemplatePort("DRAFT"),
      makeEventPort()
    );
    await expect(
      wf.promote({
        template_id: "tpl-x",
        market_id: "pl",
        from_status: "DRAFT",
        to_status: "APPROVED",
        actor_id: "vendor:bad",
      })
    ).rejects.toBeInstanceOf(PromotionPathInvalidError);
  });

  test("REVIEW → REJECTED requires reject_reason", async () => {
    const wf = new PromotionWorkflow(
      setupResolver("on"),
      makeAuditPort(),
      makeTemplatePort("REVIEW"),
      makeEventPort()
    );
    await expect(
      wf.promote({
        template_id: "tpl-3",
        market_id: "pl",
        from_status: "REVIEW",
        to_status: "REJECTED",
        actor_id: "ops:moderator",
      })
    ).rejects.toThrow(/reject_reason is required/);
  });

  test("REVIEW → REJECTED with reason emits rejected event", async () => {
    const audit = makeAuditPort();
    const tpl = makeTemplatePort("REVIEW");
    const events = makeEventPort();
    const wf = new PromotionWorkflow(setupResolver("on"), audit, tpl, events);

    await wf.promote({
      template_id: "tpl-4",
      market_id: "pl",
      from_status: "REVIEW",
      to_status: "REJECTED",
      actor_id: "ops:moderator",
      reject_reason: "missing-disclaimer",
    });
    expect(tpl.status).toBe("REJECTED");
    expect(events.log).toEqual([{ kind: "rejected", template_id: "tpl-4" }]);
  });

  test("stale from_status throws and does NOT mutate template", async () => {
    const audit = makeAuditPort();
    const tpl = makeTemplatePort("APPROVED");
    const events = makeEventPort();
    const wf = new PromotionWorkflow(setupResolver("on"), audit, tpl, events);

    await expect(
      wf.promote({
        template_id: "tpl-5",
        market_id: "pl",
        from_status: "DRAFT",
        to_status: "REVIEW",
        actor_id: "vendor:bonbeauty",
      })
    ).rejects.toThrow(/stale from_status/);
    expect(tpl.status).toBe("APPROVED");
  });

  test("template not found throws", async () => {
    const wf = new PromotionWorkflow(
      setupResolver("on"),
      makeAuditPort(),
      makeTemplatePort(null),
      makeEventPort()
    );
    await expect(
      wf.promote({
        template_id: "tpl-missing",
        market_id: "pl",
        from_status: "DRAFT",
        to_status: "REVIEW",
        actor_id: "vendor:x",
      })
    ).rejects.toThrow(/not found/);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// CanaryRollback — > 2σ divergence within 60min triggers auto-rollback.
// ──────────────────────────────────────────────────────────────────────────────

describe("CanaryRollback — auto-rollback wiring", () => {
  function makeBaselineLoader(map: Record<string, Record<CanaryMetricKey, MetricBaseline | null>>): BaselineLoaderPort {
    return {
      async loadBaseline({ market_id, metric }) {
        return map[market_id]?.[metric] ?? null;
      },
    };
  }
  function makeSampler(by: Record<string, Record<CanaryMetricKey, MetricSample[]>>): MetricSamplerPort {
    return {
      async sample({ market_id, metric }) {
        return by[market_id]?.[metric] ?? [];
      },
    };
  }
  function makeEscalation(): CanaryEscalationPort & { paged: Array<{ market_id: string; reason: string }> } {
    const paged: Array<{ market_id: string; reason: string }> = [];
    return {
      paged,
      async pageOnCallCritical(input) {
        paged.push({ market_id: input.market_id, reason: input.reason });
      },
    };
  }
  function bigSamples(metric: CanaryMetricKey, value: number, n = 200): MetricSample[] {
    return Array.from({ length: n }, (_, i) => ({
      metric,
      value,
      timestamp_ms: i * 1000,
    }));
  }

  function setup(flagState: RuntimeFlagState = "on") {
    const flag = makeFlagPort({ pl: flagState });
    const legal = makeLegalPort({ pl: APPROVED });
    const events = makeRuntimeEmitter();
    const resolver = new RuntimeFlagResolver(flag, legal, events);
    return { flag, events, resolver };
  }

  const baseline: MetricBaseline = {
    metric: "voucher.recipient.consent.completion_rate",
    mean: 0.9,
    stddev: 0.02,
    sample_n: 5000,
  };

  test("no divergence → does not roll back", async () => {
    const { flag, resolver } = setup("on");
    const loader = makeBaselineLoader({
      pl: {
        "voucher.recipient.consent.completion_rate": baseline,
        "voucher.delivery.dispatch.latency_p95": null,
        "voucher.template.runtime.error_rate": null,
      },
    });
    const sampler = makeSampler({
      pl: {
        "voucher.recipient.consent.completion_rate": bigSamples(
          "voucher.recipient.consent.completion_rate",
          0.91
        ),
        "voucher.delivery.dispatch.latency_p95": [],
        "voucher.template.runtime.error_rate": [],
      },
    });
    const cr = new CanaryRollback(resolver, loader, sampler, makeEscalation());
    const decision = await cr.evaluateAndMaybeRollback({
      market_id: "pl",
      flip_timestamp_ms: 0,
    });
    expect(decision.rolled_back).toBe(false);
    expect(decision.reason).toBe("divergence_within_threshold");
    expect(flag.state.pl).toBe("on");
  });

  test(">2σ divergence with sufficient samples → auto-rollback flips OFF + emits event", async () => {
    const { flag, events, resolver } = setup("on");
    const loader = makeBaselineLoader({
      pl: {
        "voucher.recipient.consent.completion_rate": baseline,
        "voucher.delivery.dispatch.latency_p95": null,
        "voucher.template.runtime.error_rate": null,
      },
    });
    // mean shifts by 0.1 (5σ from baseline of mean=0.9 stddev=0.02) → divergent.
    const sampler = makeSampler({
      pl: {
        "voucher.recipient.consent.completion_rate": bigSamples(
          "voucher.recipient.consent.completion_rate",
          0.8
        ),
        "voucher.delivery.dispatch.latency_p95": [],
        "voucher.template.runtime.error_rate": [],
      },
    });
    const cr = new CanaryRollback(resolver, loader, sampler, makeEscalation());
    const decision = await cr.evaluateAndMaybeRollback({
      market_id: "pl",
      flip_timestamp_ms: 0,
    });
    expect(decision.rolled_back).toBe(true);
    expect(decision.reason).toBe("auto_rollback_executed");
    expect(flag.state.pl).toBe("off");
    expect(events.emitted.some((e) => e.actor_id === "system:canary" && e.new_state === "off")).toBe(true);
  });

  test(">2σ divergence with low sample (<100) → suppressed, no rollback", async () => {
    const { flag, resolver } = setup("on");
    const loader = makeBaselineLoader({
      pl: {
        "voucher.recipient.consent.completion_rate": baseline,
        "voucher.delivery.dispatch.latency_p95": null,
        "voucher.template.runtime.error_rate": null,
      },
    });
    const sampler = makeSampler({
      pl: {
        "voucher.recipient.consent.completion_rate": bigSamples(
          "voucher.recipient.consent.completion_rate",
          0.8,
          50
        ),
        "voucher.delivery.dispatch.latency_p95": [],
        "voucher.template.runtime.error_rate": [],
      },
    });
    const cr = new CanaryRollback(resolver, loader, sampler, makeEscalation());
    const decision = await cr.evaluateAndMaybeRollback({
      market_id: "pl",
      flip_timestamp_ms: 0,
    });
    expect(decision.rolled_back).toBe(false);
    expect(decision.reason).toBe("auto_rollback_skipped_low_sample");
    expect(flag.state.pl).toBe("on");
  });

  test("post-rollback verification — divergence persists → page Sentry CRITICAL", async () => {
    const { resolver } = setup("off");
    const loader = makeBaselineLoader({
      pl: {
        "voucher.recipient.consent.completion_rate": baseline,
        "voucher.delivery.dispatch.latency_p95": null,
        "voucher.template.runtime.error_rate": null,
      },
    });
    const sampler = makeSampler({
      pl: {
        "voucher.recipient.consent.completion_rate": bigSamples(
          "voucher.recipient.consent.completion_rate",
          0.5
        ),
        "voucher.delivery.dispatch.latency_p95": [],
        "voucher.template.runtime.error_rate": [],
      },
    });
    const escalation = makeEscalation();
    const cr = new CanaryRollback(resolver, loader, sampler, escalation);
    const decision = await cr.verifyPostRollback({
      market_id: "pl",
      rollback_timestamp_ms: 0,
    });
    expect(decision.reason).toBe("post_rollback_persists_paged");
    expect(escalation.paged).toHaveLength(1);
    expect(escalation.paged[0].reason).toBe("post_rollback_divergence_persists");
  });

  test("TRACKED_METRICS contains the three AC-VTEMP-RUNTIME-2.3-01 metrics", () => {
    expect(TRACKED_METRICS).toEqual([
      "voucher.recipient.consent.completion_rate",
      "voucher.delivery.dispatch.latency_p95",
      "voucher.template.runtime.error_rate",
    ]);
  });
});
