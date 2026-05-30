import {
  FLOW_KPI_EVENT_NAMES,
  FLOW_KPI_GATED_EVENT_NAME,
  FLOW_KPI_NFR20_ALERT_EVENT_NAME,
  __resetFlowKpiTelemetryForTests,
  classifyFlowApproval,
  emitFlowKpiTelemetry,
  emitNfr20GuardResult,
  evaluateNfr20Guard,
  type CommunicationKpiSourceEvent,
  type FlowApprovalEntry,
  type PostHogCaptureClient,
} from "../flow-kpi-telemetry";

interface CapturedCall {
  distinctId: string;
  event: string;
  properties: Record<string, unknown>;
}

const approvedEntry: FlowApprovalEntry = {
  roles: {
    business: { status: "green", approver: "robert", approved_at: "2026-05-27" },
    copy: { status: "green", approver: "robert", approved_at: "2026-05-27" },
    platform: { status: "green", approver: "robert", approved_at: "2026-05-27" },
    compliance: { status: "green", approver: "robert", approved_at: "2026-05-27" },
    market: { status: "green", approver: "robert", approved_at: "2026-05-27" },
  },
};

function makePostHogStub(): { client: PostHogCaptureClient; calls: CapturedCall[] } {
  const calls: CapturedCall[] = [];
  return {
    calls,
    client: {
      capture: (input) => calls.push(input),
    },
  };
}

function sourceEvent(
  overrides: Partial<CommunicationKpiSourceEvent> = {},
): CommunicationKpiSourceEvent {
  return {
    source: "normalized_event_store",
    event_id: "evt-1",
    event_type: "delivered",
    occurred_at: "2026-05-30T10:00:04.000Z",
    dispatch_time: "2026-05-30T10:00:00.000Z",
    provider_timestamp: "2026-05-30T10:00:04.000Z",
    flow_id: "voucher_delivery_recipient",
    market: "bonbeauty",
    locale: "pl-PL",
    recipient_hash:
      "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    provider: "brevo",
    idempotency_key: "comm-state:evt-1",
    ...overrides,
  };
}

describe("flow KPI approval gate", () => {
  beforeEach(() => {
    __resetFlowKpiTelemetryForTests();
  });

  it("klasyfikuje flow jako approved tylko przy kompletnym 5-role green contract", () => {
    expect(
      classifyFlowApproval("bonbeauty", "voucher_delivery_recipient", () => approvedEntry),
    ).toMatchObject({
      status: "approved",
      telemetry_excluded: false,
      missing_roles: [],
    });
  });

  it("flagiuje unknown/unapproved zamiast cicho pomijać zdarzenie", () => {
    const stub = makePostHogStub();
    const result = emitFlowKpiTelemetry(sourceEvent(), {
      client: stub.client,
      approvalLookup: () => null,
      now: () => new Date("2026-05-30T10:00:05.000Z"),
    });

    expect(result).toMatchObject({
      gated: true,
      flow_registry_status: "unknown",
      emitted: expect.any(Array),
    });
    expect(stub.calls).toHaveLength(1);
    expect(stub.calls[0].event).toBe(FLOW_KPI_GATED_EVENT_NAME);
    expect(stub.calls[0].properties).toMatchObject({
      flow_id: "voucher_delivery_recipient",
      market: "bonbeauty",
      locale: "pl-PL",
      flow_registry_status: "unknown",
      telemetry_excluded: true,
      outcome: "delivered",
    });
  });

  it("degraduje kontrolowanie przy braku Flow Registry contract", () => {
    const stub = makePostHogStub();
    const result = emitFlowKpiTelemetry(sourceEvent(), { client: stub.client });

    expect(result.gated).toBe(true);
    expect(result.flow_registry_status).toBe("contract_missing");
    expect(stub.calls[0].properties.telemetry_excluded).toBe(true);
  });
});

describe("flow KPI PostHog emission", () => {
  beforeEach(() => {
    __resetFlowKpiTelemetryForTests();
  });

  it("emituje delivered_rate, opt_out denominator i time_to_delivery z wymaganymi properties", () => {
    const stub = makePostHogStub();
    const result = emitFlowKpiTelemetry(sourceEvent(), {
      client: stub.client,
      approvalLookup: () => approvedEntry,
    });

    expect(result.gated).toBe(false);
    expect(stub.calls.map((call) => call.event)).toEqual([
      FLOW_KPI_EVENT_NAMES.delivered_rate,
      FLOW_KPI_EVENT_NAMES.opt_out,
      FLOW_KPI_EVENT_NAMES.time_to_delivery,
    ]);
    for (const call of stub.calls) {
      expect(call.properties).toMatchObject({
        flow_id: "voucher_delivery_recipient",
        market: "bonbeauty",
        locale: "pl-PL",
        source: "normalized_event_store",
        source_event_id: "evt-1",
      });
      expect(call.properties).toHaveProperty("outcome");
      expect(JSON.stringify(call.properties)).not.toContain("buyer@example.com");
    }
    expect(stub.calls[2].properties).toMatchObject({
      outcome: "delivered",
      duration_ms: 4000,
    });
  });

  it("mapuje click_to_claim, opt_out i support_contact na deterministyczne namespace KPI", () => {
    const stub = makePostHogStub();
    const options = {
      client: stub.client,
      approvalLookup: () => approvedEntry,
      dedupeStore: new Set<string>(),
    };

    emitFlowKpiTelemetry(sourceEvent({ event_id: "evt-click", event_type: "clicked" }), options);
    emitFlowKpiTelemetry(sourceEvent({ event_id: "evt-claim", event_type: "claim" }), options);
    emitFlowKpiTelemetry(
      sourceEvent({ event_id: "evt-unsub", event_type: "unsubscribed" }),
      options,
    );
    emitFlowKpiTelemetry(
      sourceEvent({ event_id: "evt-support", event_type: "support_contact" }),
      options,
    );

    expect(stub.calls.map((call) => [call.event, call.properties.outcome])).toEqual([
      [FLOW_KPI_EVENT_NAMES.click_to_claim, "click"],
      [FLOW_KPI_EVENT_NAMES.click_to_claim, "claim"],
      [FLOW_KPI_EVENT_NAMES.opt_out, "unsubscribe"],
      [FLOW_KPI_EVENT_NAMES.support_contact, "support_contact"],
    ]);
  });

  it("deduplikuje re-emisję po idempotentnym kluczu KPI", () => {
    const stub = makePostHogStub();
    const dedupeStore = new Set<string>();
    const options = {
      client: stub.client,
      approvalLookup: () => approvedEntry,
      dedupeStore,
    };

    const first = emitFlowKpiTelemetry(sourceEvent(), options);
    const second = emitFlowKpiTelemetry(sourceEvent(), options);

    expect(first.emitted).toHaveLength(3);
    expect(second.emitted).toHaveLength(0);
    expect(second.skipped_duplicate).toHaveLength(3);
    expect(stub.calls).toHaveLength(3);
  });

  it("odrzuca raw PII w dodatkowych properties", () => {
    expect(() =>
      emitFlowKpiTelemetry(
        sourceEvent({
          properties: {
            email: "buyer@example.com",
          },
        }),
        {
          client: makePostHogStub().client,
          approvalLookup: () => approvedEntry,
        },
      ),
    ).toThrow("raw PII");
  });

  it("odrzuca źródło inne niż znormalizowany event store lub delivery audit envelope", () => {
    expect(() =>
      emitFlowKpiTelemetry(
        sourceEvent({ source: "raw_brevo_callback" as never }),
        {
          client: makePostHogStub().client,
          approvalLookup: () => approvedEntry,
        },
      ),
    ).toThrow("normalized event-store");
  });
});

describe("NFR20 delivery-rate guard", () => {
  beforeEach(() => {
    __resetFlowKpiTelemetryForTests();
  });

  it("wyzwala alert dla rolling 7d regresji >5pp po korekcie control delta", () => {
    const result = evaluateNfr20Guard(
      {
        market: "bonbeauty",
        sent: 1200,
        delivered: 1176,
        delivery_rate: 0.98,
        window_days: 7,
        sample_floor: 200,
        provider: "brevo",
      },
      {
        market: "bonbeauty",
        sent: 500,
        delivered: 440,
        window_days: 7,
        window_started_at: "2026-05-23T00:00:00.000Z",
        window_ended_at: "2026-05-30T00:00:00.000Z",
      },
      [
        {
          market: "bonevent",
          baseline_delivery_rate: 0.97,
          rolling_delivery_rate: 0.965,
        },
        {
          market: "bongarden",
          baseline_delivery_rate: 0.974,
          rolling_delivery_rate: 0.972,
        },
      ],
    );

    expect(result).toMatchObject({
      status: "alert",
      outcome: "fail",
      sample_n: 500,
      threshold_pct: 5,
    });
    expect(result.adjusted_regression_pct).toBeGreaterThan(5);
  });

  it("supresuje alert przy sample floor <200", () => {
    const result = evaluateNfr20Guard(
      {
        market: "bonbeauty",
        sent: 1200,
        delivered: 1176,
        delivery_rate: 0.98,
        window_days: 7,
        sample_floor: 200,
        provider: "brevo",
      },
      {
        market: "bonbeauty",
        sent: 199,
        delivered: 100,
        window_days: 7,
        window_started_at: "2026-05-23T00:00:00.000Z",
        window_ended_at: "2026-05-30T00:00:00.000Z",
      },
    );

    expect(result.status).toBe("insufficient_sample");
    expect(result.outcome).toBe("suppressed");
  });

  it("emituje PostHog alert event tylko przy status=alert", () => {
    const stub = makePostHogStub();
    const alert = evaluateNfr20Guard(
      {
        market: "bonbeauty",
        sent: 1200,
        delivered: 1176,
        delivery_rate: 0.98,
        window_days: 7,
        sample_floor: 200,
        provider: "brevo",
      },
      {
        market: "bonbeauty",
        sent: 500,
        delivered: 430,
        window_days: 7,
        window_started_at: "2026-05-23T00:00:00.000Z",
        window_ended_at: "2026-05-30T00:00:00.000Z",
      },
    );

    expect(emitNfr20GuardResult(alert, stub.client)).toBe(true);
    expect(stub.calls).toHaveLength(1);
    expect(stub.calls[0].event).toBe(FLOW_KPI_NFR20_ALERT_EVENT_NAME);
    expect(stub.calls[0].properties).toMatchObject({
      market: "bonbeauty",
      flow_id: "__all_flows__",
      locale: "__all__",
      outcome: "fail",
      threshold_pct: 5,
      sample_floor: 200,
    });
  });
});
