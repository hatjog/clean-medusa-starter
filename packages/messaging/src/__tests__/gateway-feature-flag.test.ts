import {
  DefaultMessagingGateway,
  StaticCommunicationFlowFlagResolver,
} from "../index";
import type {
  IMessagingProvider,
  NotificationIntent,
  CommunicationDefaultsConfig,
  MarketFlowsConfig,
} from "../index";

const fixedNow = new Date("2026-05-27T10:00:00.000Z");

const defaults: CommunicationDefaultsConfig = {
  version: 1,
  flows: {
    voucher_delivery_recipient: {
      enabled: true,
      consent_basis: "transactional_critical",
    },
    voucher_reminder_t7: {
      enabled: false,
      consent_basis: "lifecycle_consented",
    },
  },
};

const bonbeauty: MarketFlowsConfig = {
  version: 1,
  market_id: "bonbeauty",
  overrides: {
    voucher_reminder_t7: {
      enabled: true,
    },
  },
};

function makeIntent(
  overrides: Partial<NotificationIntent> = {},
): NotificationIntent {
  const base: NotificationIntent = {
    flow_id: "voucher_delivery_recipient",
    channel: "email",
    template_key: "voucher_delivery_recipient_email",
    recipient: {
      email: "buyer@example.com",
      market_id: "bonevent",
    },
    variables: {},
    locale: "pl-PL",
    consent_basis: "transactional_critical",
    idempotency_key: "idem-flag-1",
  };

  return {
    ...base,
    ...overrides,
    recipient: {
      ...base.recipient,
      ...overrides.recipient,
    },
  };
}

function makeProvider(): IMessagingProvider {
  return {
    key: "brevo",
    send: jest.fn().mockResolvedValue({
      dispatch_id: "provider-dispatch-flag",
      status: "queued",
      sent_at: fixedNow.toISOString(),
    }),
  };
}

function makeUuid(values: string[]): () => string {
  let index = 0;
  return () => values[index++] ?? `uuid-${index}`;
}

describe("DefaultMessagingGateway feature flag gate", () => {
  it("deleguje do providera gdy flow jest enabled", async () => {
    const provider = makeProvider();
    const resolver = new StaticCommunicationFlowFlagResolver(defaults, new Map());
    const gateway = new DefaultMessagingGateway({ brevo: provider }, "brevo", {
      flagResolver: resolver,
      clock: () => fixedNow,
      uuid: makeUuid(["audit-1"]),
    });

    const dispatch = await gateway.send(makeIntent());

    expect(provider.send).toHaveBeenCalledTimes(1);
    expect(dispatch).toMatchObject({
      status: "queued",
      audit_event: {
        status: "queued",
        flow_id: "voucher_delivery_recipient",
        market_id: "bonevent",
      },
    });
  });

  it("nie woła providera i zwraca failed dispatch gdy flow jest disabled", async () => {
    const provider = makeProvider();
    const resolver = new StaticCommunicationFlowFlagResolver(defaults, new Map());
    const gateway = new DefaultMessagingGateway({ brevo: provider }, "brevo", {
      flagResolver: resolver,
      clock: () => fixedNow,
      uuid: makeUuid(["gated-dispatch-1", "audit-gated-1"]),
    });

    const dispatch = await gateway.send(
      makeIntent({
        flow_id: "voucher_reminder_t7",
        template_key: "voucher_reminder_t7_email",
        consent_basis: "lifecycle_consented",
      }),
    );

    expect(provider.send).not.toHaveBeenCalled();
    expect(dispatch).toMatchObject({
      dispatch_id: "gated-dispatch-1",
      provider: "brevo",
      status: "failed",
      audit_event: {
        audit_id: "audit-gated-1",
        status: "failed",
        error_code: "FLOW_DISABLED",
        gate_source: "feature_flag",
        flow_id: "voucher_reminder_t7",
        market_id: "bonevent",
      },
    });
  });

  it("różnicuje ten sam flow per market", async () => {
    const provider = makeProvider();
    const resolver = new StaticCommunicationFlowFlagResolver(
      defaults,
      new Map([["bonbeauty", bonbeauty]]),
    );
    const gateway = new DefaultMessagingGateway({ brevo: provider }, "brevo", {
      flagResolver: resolver,
      clock: () => fixedNow,
      uuid: makeUuid(["gated-dispatch", "audit-gated", "audit-provider"]),
    });

    const gated = await gateway.send(
      makeIntent({
        flow_id: "voucher_reminder_t7",
        recipient: { email: "buyer@example.com", market_id: "bonevent" },
        consent_basis: "lifecycle_consented",
        idempotency_key: "idem-disabled",
      }),
    );
    const delegated = await gateway.send(
      makeIntent({
        flow_id: "voucher_reminder_t7",
        recipient: { email: "buyer@example.com", market_id: "bonbeauty" },
        consent_basis: "lifecycle_consented",
        idempotency_key: "idem-enabled",
      }),
    );

    expect(gated.status).toBe("failed");
    expect(delegated.status).toBe("queued");
    expect(provider.send).toHaveBeenCalledTimes(1);
  });

  it("zachowuje kompatybilność gdy resolver nie jest injected", async () => {
    const provider = makeProvider();
    const gateway = new DefaultMessagingGateway({ brevo: provider }, "brevo", {
      clock: () => fixedNow,
      uuid: makeUuid(["audit-1"]),
    });

    const dispatch = await gateway.send(
      makeIntent({
        flow_id: "voucher_reminder_t7",
        consent_basis: "lifecycle_consented",
      }),
    );

    expect(provider.send).toHaveBeenCalledTimes(1);
    expect(dispatch.status).toBe("queued");
  });

  it("ponownie ewaluuje resolver przy kazdym send dla disabled flow (F-01 — operator flip OFF→ON natychmiastowy)", async () => {
    const provider = makeProvider();
    const resolver = {
      resolve: jest.fn().mockReturnValue({
        enabled: false,
        consent_basis: "lifecycle_consented",
        source: "default",
        flow_id: "voucher_reminder_t7",
        market_id: "bonevent",
      }),
    };
    const gateway = new DefaultMessagingGateway({ brevo: provider }, "brevo", {
      flagResolver: resolver,
      clock: () => fixedNow,
      uuid: makeUuid([
        "gated-dispatch-1",
        "audit-gated-1",
        "gated-dispatch-2",
        "audit-gated-2",
      ]),
    });

    const intent = makeIntent({
      flow_id: "voucher_reminder_t7",
      consent_basis: "lifecycle_consented",
    });
    const first = await gateway.send(intent);
    const second = await gateway.send(intent);

    expect(provider.send).not.toHaveBeenCalled();
    expect(resolver.resolve).toHaveBeenCalledTimes(2);
    expect(first.audit_event.error_code).toBe("FLOW_DISABLED");
    expect(second.audit_event.error_code).toBe("FLOW_DISABLED");
    expect(first.dispatch_id).not.toBe(second.dispatch_id);
  });

  it("po flip resolverze enabled→true kolejny send dla tego samego idempotency_key idzie do providera (gate NIE cachowany)", async () => {
    const provider = makeProvider();
    const resolveMock = jest
      .fn()
      .mockReturnValueOnce({
        enabled: false,
        consent_basis: "lifecycle_consented",
        source: "default",
        flow_id: "voucher_reminder_t7",
        market_id: "bonevent",
      })
      .mockReturnValue({
        enabled: true,
        consent_basis: "lifecycle_consented",
        source: "market_override",
        flow_id: "voucher_reminder_t7",
        market_id: "bonevent",
      });
    const gateway = new DefaultMessagingGateway({ brevo: provider }, "brevo", {
      flagResolver: { resolve: resolveMock },
      clock: () => fixedNow,
      uuid: makeUuid(["gated-dispatch", "audit-gated", "audit-provider"]),
    });

    const intent = makeIntent({
      flow_id: "voucher_reminder_t7",
      consent_basis: "lifecycle_consented",
    });
    const denied = await gateway.send(intent);
    const delivered = await gateway.send(intent);

    expect(denied.status).toBe("failed");
    expect(delivered.status).toBe("queued");
    expect(provider.send).toHaveBeenCalledTimes(1);
  });
});
