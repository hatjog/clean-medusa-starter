import {
  DefaultMessagingGateway,
  MessagingProviderError,
  MessagingValidationError,
  UnsupportedChannelError,
  UnsupportedProviderError,
} from "../index";
import type { IMessagingProvider, NotificationIntent } from "../index";

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
      makeUuid(["failed-dispatch-1", "audit-failed-1"]),
    );

    const dispatch = await gateway.send(makeIntent());

    expect(dispatch).toMatchObject({
      dispatch_id: "failed-dispatch-1",
      provider: "brevo",
      status: "failed",
      audit_event: {
        audit_id: "audit-failed-1",
        status: "failed",
        error_code: "invalid_parameter",
        error_message: "Brevo rejected payload",
      },
    });
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
