import {
  DefaultMessagingGateway,
  MessagingProviderError,
  MessagingValidationError,
  UnsupportedChannelError,
  UnsupportedProviderError,
} from "../index";
import type {
  CommunicationKpiSourceEvent,
  FlowKpiEmissionResult,
  FlowKpiTelemetryHook,
  IMessagingProvider,
  NotificationDeliveryEvent,
  NotificationIntent,
} from "../index";

const fixedNow = new Date("2026-05-26T12:00:00.000Z");

function makeIntent(
  overrides: Partial<NotificationIntent> = {},
): NotificationIntent {
  const base: NotificationIntent = {
    flow_id: "voucher_delivery_recipient",
    channel: "email",
    template_key: "voucher_delivery_recipient_email",
    recipient: {
      email: "buyer@example.com",
      market_id: "pl",
    },
    variables: {
      voucher_code: "ABC-123",
    },
    locale: "pl-PL",
    consent_basis: "transactional_critical",
    idempotency_key: "idem-1",
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

function makeUuid(values: string[]): () => string {
  let index = 0;
  return () => values[index++] ?? `uuid-${index}`;
}

function makeProvider(): IMessagingProvider {
  return {
    key: "brevo",
    send: jest.fn().mockResolvedValue({
      dispatch_id: "provider-dispatch-1",
      status: "queued",
      provider_message_id: "brevo-message-1",
      sent_at: fixedNow.toISOString(),
    }),
  };
}

function makeRecordingHook(sink: CommunicationKpiSourceEvent[]): FlowKpiTelemetryHook {
  return {
    emit: (event: CommunicationKpiSourceEvent): FlowKpiEmissionResult => {
      sink.push(event);
      return {
        emitted: [],
        skipped_duplicate: [],
        not_emitted: [],
        gated: false,
        flow_registry_status: "approved",
        missing_roles: [],
      };
    },
  };
}

describe("DefaultMessagingGateway", () => {
  it("deleguje send do domyślnego providera i zwraca audit envelope success", async () => {
    const provider = makeProvider();
    const gateway = new DefaultMessagingGateway(
      { brevo: provider },
      "brevo",
      () => fixedNow,
      makeUuid(["audit-1"]),
    );

    const dispatch = await gateway.send(makeIntent());

    expect(provider.send).toHaveBeenCalledTimes(1);
    expect(provider.send).toHaveBeenCalledWith(makeIntent());
    expect(dispatch).toMatchObject({
      dispatch_id: "provider-dispatch-1",
      provider: "brevo",
      status: "queued",
      provider_message_id: "brevo-message-1",
      sent_at: fixedNow.toISOString(),
      audit_event: {
        audit_id: "audit-1",
        event_type: "notification.dispatch",
        status: "queued",
        dispatch_id: "provider-dispatch-1",
        provider: "brevo",
        flow_id: "voucher_delivery_recipient",
        template_key: "voucher_delivery_recipient_email",
        market_id: "pl",
        locale: "pl-PL",
        consent_basis: "transactional_critical",
        idempotency_key: "idem-1",
        occurred_at: fixedNow.toISOString(),
      },
    });
    expect(dispatch.audit_event.hashed_recipient).toHaveLength(64);
    expect(dispatch.audit_event.hashed_recipient).not.toContain("buyer@example.com");
  });

  it("zwraca failed dispatch z audit envelope przy błędzie providera", async () => {
    const provider = makeProvider();
    const sendMock = provider.send as jest.MockedFunction<IMessagingProvider["send"]>;
    sendMock.mockRejectedValueOnce(
      new MessagingProviderError("Brevo rejected payload", {
        error_code: "invalid_parameter",
      }),
    );
    const gateway = new DefaultMessagingGateway(
      { brevo: provider },
      "brevo",
      () => fixedNow,
      // R2-M1: dispatch_id failed dispatchu jest deterministycznie wyprowadzony
      // z cache key (nie z sekwencji uuid); pierwszy uuid zasila audit_id.
      makeUuid(["audit-failed-1"]),
    );

    const dispatch = await gateway.send(makeIntent());

    expect(dispatch).toMatchObject({
      provider: "brevo",
      status: "failed",
      audit_event: {
        audit_id: "audit-failed-1",
        status: "failed",
        error_code: "invalid_parameter",
        error_message: "Brevo rejected payload",
      },
    });
    // R2-M1: dispatch_id jest stabilny (deterministyczny hash cache key), nie losowy.
    expect(dispatch.dispatch_id).toMatch(
      /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/,
    );
    expect(dispatch.dispatch_id).toBe(dispatch.audit_event.dispatch_id);
  });

  it("R2-M1: retry z tym samym idempotency_key po błędzie providera nie re-inwokuje providera", async () => {
    const provider = makeProvider();
    const sendMock = provider.send as jest.MockedFunction<IMessagingProvider["send"]>;
    // Provider zawodzi tylko raz; gdyby retry re-inwokował providera (np. po
    // timeout-after-send), drugie wywołanie mogłoby zdublować realną wysyłkę.
    sendMock.mockRejectedValueOnce(
      new MessagingProviderError("Brevo timeout", {
        error_code: "provider_timeout",
      }),
    );
    const gateway = new DefaultMessagingGateway(
      { brevo: provider },
      "brevo",
      () => fixedNow,
      makeUuid(["audit-failed-1", "audit-failed-2"]),
    );

    const first = await gateway.send(makeIntent());
    const second = await gateway.send(makeIntent());

    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(second).toEqual(first);
    expect(second.status).toBe("failed");
  });

  it("rzuca MessagingValidationError dla email channel bez recipient.email", async () => {
    const gateway = new DefaultMessagingGateway(
      { brevo: makeProvider() },
      "brevo",
      () => fixedNow,
      makeUuid(["validation-dispatch-1", "audit-validation-1"]),
    );

    await expect(
      gateway.send(makeIntent({ recipient: { email: "", market_id: "pl" } })),
    ).rejects.toBeInstanceOf(MessagingValidationError);

    try {
      await gateway.send(makeIntent({ recipient: { email: "", market_id: "pl" } }));
    } catch (error) {
      const typed = error as MessagingValidationError;
      expect(typed.error_code).toBe("MESSAGING_RECIPIENT_EMAIL_REQUIRED");
      expect(typed.audit_event).toMatchObject({
        status: "failed",
        error_code: "MESSAGING_RECIPIENT_EMAIL_REQUIRED",
      });
    }
  });

  it("rzuca MessagingValidationError dla brakującego market_id", async () => {
    const gateway = new DefaultMessagingGateway(
      { brevo: makeProvider() },
      "brevo",
      () => fixedNow,
      makeUuid(["validation-dispatch-1", "audit-validation-1"]),
    );

    await expect(
      gateway.send(makeIntent({ recipient: { email: "buyer@example.com", market_id: "" } })),
    ).rejects.toMatchObject({
      error_code: "MESSAGING_MARKET_ID_REQUIRED",
    });
  });

  it("rzuca MessagingValidationError dla pustego idempotency_key", async () => {
    const gateway = new DefaultMessagingGateway(
      { brevo: makeProvider() },
      "brevo",
      () => fixedNow,
      makeUuid(["validation-dispatch-1", "audit-validation-1"]),
    );

    await expect(
      gateway.send(makeIntent({ idempotency_key: "   " })),
    ).rejects.toMatchObject({
      error_code: "MESSAGING_IDEMPOTENCY_KEY_REQUIRED",
    });
  });

  it("rzuca MessagingValidationError dla nieznanej wartości channel (poza email|sms|push)", async () => {
    // F-04: Caller, który ominie TypeScript (np. JSON deserializacja z API), nie
    // może dostać "Unsupported v1.10.0" myląc validation z roadmap-deferral.
    const gateway = new DefaultMessagingGateway(
      { brevo: makeProvider() },
      "brevo",
      () => fixedNow,
      makeUuid(["invalid-dispatch-1", "audit-invalid-1"]),
    );

    await expect(
      gateway.send(makeIntent({ channel: "webhook" as never })),
    ).rejects.toMatchObject({
      error_code: "MESSAGING_CHANNEL_INVALID",
    });
  });

  it("hashRecipient jest deterministyczny i case-insensitive dla emaila", async () => {
    // F-10: invariant dla Path Y subscriber correlation (hash dispatch ↔ delivery event).
    const provider = makeProvider();
    const gateway = new DefaultMessagingGateway(
      { brevo: provider },
      "brevo",
      () => fixedNow,
      makeUuid(["a1", "a2", "a3", "a4"]),
    );

    const first = await gateway.send(
      makeIntent({
        recipient: { email: "Buyer@Example.com", market_id: "pl" },
        idempotency_key: "hash-1",
      }),
    );
    const second = await gateway.send(
      makeIntent({
        recipient: { email: "buyer@example.com", market_id: "pl" },
        idempotency_key: "hash-2",
      }),
    );
    const third = await gateway.send(
      makeIntent({
        recipient: { email: "buyer@example.com", market_id: "pl" },
        idempotency_key: "hash-3",
      }),
    );

    expect(first.audit_event.hashed_recipient).toBe(
      second.audit_event.hashed_recipient,
    );
    expect(second.audit_event.hashed_recipient).toBe(
      third.audit_event.hashed_recipient,
    );
  });

  it("v1.10.0: gateway NIE waliduje consent — marketing intent przechodzi do providera (boundary Story 5.4)", async () => {
    // F-11: consent gating per flow per market = scope Story 5.4 (FF runtime).
    // Gateway w v1.10.0 forwarduje wszystkie 4 consent_basis bez sprawdzenia consent record.
    const provider = makeProvider();
    const gateway = new DefaultMessagingGateway(
      { brevo: provider },
      "brevo",
      () => fixedNow,
      makeUuid(["marketing-audit-1"]),
    );

    const dispatch = await gateway.send(
      makeIntent({ consent_basis: "marketing" }),
    );

    expect(provider.send).toHaveBeenCalledTimes(1);
    expect(dispatch.audit_event.consent_basis).toBe("marketing");
    expect(dispatch.status).toBe("queued");
  });

  it("ewikuje najstarszy wpis z cache po przekroczeniu maxCacheSize i pruneuje wygasłe", async () => {
    // F-03: long-running worker memory bound — LRU eviction + sweep ekspiracji.
    let now = fixedNow;
    const provider = makeProvider();
    const sendMock = provider.send as jest.MockedFunction<IMessagingProvider["send"]>;
    sendMock.mockImplementation(async () => ({
      dispatch_id: `dispatch-${sendMock.mock.calls.length}`,
      status: "queued",
    }));
    const gateway = new DefaultMessagingGateway(
      { brevo: provider },
      "brevo",
      () => now,
      makeUuid([]),
      60_000,
      2, // maxCacheSize = 2 → trzeci wpis powinien ewikuować pierwszy.
    );

    await gateway.send(makeIntent({ idempotency_key: "k1" }));
    await gateway.send(makeIntent({ idempotency_key: "k2" }));
    await gateway.send(makeIntent({ idempotency_key: "k3" }));

    // k1 powinien być ewikuowany — kolejny send z k1 wywołuje providera ponownie.
    await gateway.send(makeIntent({ idempotency_key: "k1" }));
    expect(provider.send).toHaveBeenCalledTimes(4);

    // Test sweep: wygaszamy wszystkie po TTL — kolejny send z k3 też woła providera.
    now = new Date(fixedNow.getTime() + 120_000);
    await gateway.send(makeIntent({ idempotency_key: "k3" }));
    expect(provider.send).toHaveBeenCalledTimes(5);
  });

  it("composite cache key blokuje cross-market kolizję dla tego samego idempotency_key", async () => {
    // F-08: dwie intencje z różnym market_id ale samym idempotency_key dostają RÓŻNE dispatch_id.
    const provider = makeProvider();
    const sendMock = provider.send as jest.MockedFunction<IMessagingProvider["send"]>;
    sendMock
      .mockResolvedValueOnce({
        dispatch_id: "pl-dispatch",
        status: "queued",
      })
      .mockResolvedValueOnce({
        dispatch_id: "de-dispatch",
        status: "queued",
      });
    const gateway = new DefaultMessagingGateway(
      { brevo: provider },
      "brevo",
      () => fixedNow,
      makeUuid(["a1", "a2", "a3", "a4"]),
    );

    const plDispatch = await gateway.send(
      makeIntent({
        recipient: { email: "pl@example.com", market_id: "pl" },
        idempotency_key: "shared-key",
      }),
    );
    const deDispatch = await gateway.send(
      makeIntent({
        recipient: { email: "de@example.com", market_id: "de" },
        idempotency_key: "shared-key",
        locale: "de-DE",
      }),
    );

    expect(provider.send).toHaveBeenCalledTimes(2);
    expect(plDispatch.dispatch_id).toBe("pl-dispatch");
    expect(deDispatch.dispatch_id).toBe("de-dispatch");
    expect(plDispatch.dispatch_id).not.toBe(deDispatch.dispatch_id);
  });

  it("blokuje sms i push jako unsupported channel w v1.10.0", async () => {
    const gateway = new DefaultMessagingGateway(
      { brevo: makeProvider() },
      "brevo",
      () => fixedNow,
      makeUuid(["sms-dispatch", "sms-audit", "push-dispatch", "push-audit"]),
    );

    await expect(
      gateway.send(
        makeIntent({
          channel: "sms",
          recipient: { phone: "+48123456789", market_id: "pl" },
        }),
      ),
    ).rejects.toBeInstanceOf(UnsupportedChannelError);

    await expect(
      gateway.send(makeIntent({ channel: "push" })),
    ).rejects.toMatchObject({
      error_code: "MESSAGING_CHANNEL_UNSUPPORTED",
    });
  });

  it("deduplikuje po idempotency_key i nie woła providera drugi raz", async () => {
    const provider = makeProvider();
    const gateway = new DefaultMessagingGateway(
      { brevo: provider },
      "brevo",
      () => fixedNow,
      makeUuid(["audit-1"]),
    );

    const first = await gateway.send(makeIntent());
    const second = await gateway.send(makeIntent());

    expect(provider.send).toHaveBeenCalledTimes(1);
    expect(second).toBe(first);
    expect(second.dispatch_id).toBe("provider-dispatch-1");
  });

  it("odświeża provider call po wygaśnięciu cache idempotency", async () => {
    let now = fixedNow;
    const provider = makeProvider();
    const sendMock = provider.send as jest.MockedFunction<IMessagingProvider["send"]>;
    sendMock
      .mockResolvedValueOnce({
        dispatch_id: "provider-dispatch-1",
        status: "queued",
      })
      .mockResolvedValueOnce({
        dispatch_id: "provider-dispatch-2",
        status: "queued",
      });
    const gateway = new DefaultMessagingGateway(
      { brevo: provider },
      "brevo",
      () => now,
      makeUuid(["audit-1", "audit-2"]),
      1000,
    );

    const first = await gateway.send(makeIntent());
    now = new Date(fixedNow.getTime() + 1001);
    const second = await gateway.send(makeIntent());

    expect(provider.send).toHaveBeenCalledTimes(2);
    expect(first.dispatch_id).toBe("provider-dispatch-1");
    expect(second.dispatch_id).toBe("provider-dispatch-2");
  });

  it("przepuszcza nieoczekiwany błąd spoza portu providera", async () => {
    const provider = makeProvider();
    const sendMock = provider.send as jest.MockedFunction<IMessagingProvider["send"]>;
    sendMock.mockRejectedValueOnce(new Error("unexpected"));
    const gateway = new DefaultMessagingGateway(
      { brevo: provider },
      "brevo",
      () => fixedNow,
      makeUuid(["audit-1"]),
    );

    await expect(gateway.send(makeIntent())).rejects.toThrow("unexpected");
  });

  it("H1: emituje KPI source event (sent) w lifecycle send() przez wstrzyknięty hook", async () => {
    const emitted: CommunicationKpiSourceEvent[] = [];
    const hook = makeRecordingHook(emitted);
    const provider = makeProvider();
    const gateway = new DefaultMessagingGateway(
      { brevo: provider },
      "brevo",
      () => fixedNow,
      makeUuid(["audit-1"]),
      undefined,
      undefined,
      hook,
    );

    await gateway.send(makeIntent());

    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({
      source: "delivery_audit_envelope",
      event_type: "sent",
      flow_id: "voucher_delivery_recipient",
      market: "pl",
      locale: "pl-PL",
    });
  });

  it("H1: recordDeliveryEvent koreluje znormalizowane zdarzenie delivery → KPI", async () => {
    const emitted: CommunicationKpiSourceEvent[] = [];
    const hook = makeRecordingHook(emitted);
    const provider = makeProvider();
    const gateway = new DefaultMessagingGateway(
      { brevo: provider },
      "brevo",
      () => fixedNow,
      makeUuid(["audit-1"]),
      undefined,
      undefined,
      hook,
    );

    await gateway.send(makeIntent());
    const deliveryEvent: NotificationDeliveryEvent = {
      dispatch_id: "provider-dispatch-1",
      provider: "brevo",
      event_type: "delivered",
      occurred_at: fixedNow.toISOString(),
      provider_event_id: "brevo-event-1",
    };

    const result = gateway.recordDeliveryEvent(deliveryEvent);

    expect(result).not.toBeNull();
    expect(emitted).toHaveLength(2);
    expect(emitted[1]).toMatchObject({
      source: "normalized_event_store",
      event_type: "delivered",
      flow_id: "voucher_delivery_recipient",
      market: "pl",
    });
  });

  it("H1: recordDeliveryEvent degraduje kontrolowanie przy nieznanej korelacji (zwraca null)", () => {
    const emitted: CommunicationKpiSourceEvent[] = [];
    const hook = makeRecordingHook(emitted);
    const gateway = new DefaultMessagingGateway(
      { brevo: makeProvider() },
      "brevo",
      () => fixedNow,
      makeUuid(["audit-1"]),
      undefined,
      undefined,
      hook,
    );

    const result = gateway.recordDeliveryEvent({
      dispatch_id: "never-seen",
      provider: "brevo",
      event_type: "delivered",
      occurred_at: fixedNow.toISOString(),
      provider_event_id: "evt-x",
    });

    expect(result).toBeNull();
    expect(emitted).toHaveLength(0);
  });

  it("rzuca UnsupportedProviderError z audit envelope dla nieznanego providera", async () => {
    const gateway = new DefaultMessagingGateway(
      {},
      "resend",
      () => fixedNow,
      makeUuid(["unsupported-dispatch-1", "audit-unsupported-1"]),
    );

    await expect(gateway.send(makeIntent())).rejects.toBeInstanceOf(
      UnsupportedProviderError,
    );

    try {
      await gateway.send(makeIntent());
    } catch (error) {
      const typed = error as UnsupportedProviderError;
      expect(typed.error_code).toBe("MESSAGING_PROVIDER_UNSUPPORTED");
      expect(typed.audit_event).toMatchObject({
        audit_id: "uuid-4",
        provider: "resend",
        status: "failed",
        error_code: "MESSAGING_PROVIDER_UNSUPPORTED",
      });
    }
  });
});
