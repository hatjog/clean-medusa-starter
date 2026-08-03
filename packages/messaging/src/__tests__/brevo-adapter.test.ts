import {
  BrevoAdapter,
  MessagingProviderError,
  MessagingValidationError,
} from "../index";
import type {
  BrevoTransactionalEmailPayload,
  IBrevoClient,
  NotificationIntent,
} from "../index";

const fixedNow = new Date("2026-05-26T12:00:00.000Z");

function makeIntent(overrides: Partial<NotificationIntent> = {}): NotificationIntent {
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
      buyer_name: "Ada",
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

function makeAdapter(client: IBrevoClient): BrevoAdapter {
  return new BrevoAdapter(client, {
    senders: {
      pl: {
        email: "notifications@example.pl",
        name: "GP PL",
      },
      de: {
        email: "notifications@example.de",
        name: "GP DE",
      },
    },
    templates: {
      voucher_delivery_recipient_email: 101,
      lifecycle_email: 202,
    },
    clock: () => fixedNow,
    uuid: () => "dispatch-1",
  });
}

describe("BrevoAdapter", () => {
  it("mapuje NotificationIntent na payload Brevo TransactionalEmailsApi", async () => {
    let capturedPayload: BrevoTransactionalEmailPayload | undefined;
    const client: IBrevoClient = {
      sendTransacEmail: jest.fn(async (payload) => {
        capturedPayload = payload;
        return { messageId: "brevo-message-1" };
      }),
    };
    const adapter = makeAdapter(client);

    const response = await adapter.send(makeIntent());

    expect(response).toEqual({
      dispatch_id: "dispatch-1",
      status: "queued",
      provider_message_id: "brevo-message-1",
      sent_at: fixedNow.toISOString(),
    });
    expect(capturedPayload).toBeDefined();
    const payload = capturedPayload as BrevoTransactionalEmailPayload;
    expect(payload).toMatchObject({
      templateId: 101,
      to: [{ email: "buyer@example.com" }],
      sender: {
        email: "notifications@example.pl",
        name: "GP PL",
      },
      params: {
        voucher_code: "ABC-123",
        buyer_name: "Ada",
        locale: "pl-PL",
        flow_id: "voucher_delivery_recipient",
        market_id: "pl",
      },
    });
  });

  it("przenosi idempotency_key i routing marketu do headerów Brevo", () => {
    const client: IBrevoClient = {
      sendTransacEmail: jest.fn(),
    };
    const adapter = makeAdapter(client);

    const payload = adapter.toBrevoPayload(makeIntent());

    // F-09: tylko X-Mailin-Tag (Brevo's documented tag); X-GP-* / Idempotency-Key
    // usunięte, żeby nie leakować routing/PII do message headers widzialnych w `view source`.
    expect(payload.headers).toEqual({
      "X-Mailin-Tag": "pl:voucher_delivery_recipient:voucher_delivery_recipient_email",
    });
    expect(payload.headers).not.toHaveProperty("X-GP-Flow-Id");
    expect(payload.headers).not.toHaveProperty("X-GP-Template-Key");
    expect(payload.headers).not.toHaveProperty("X-GP-Locale");
    expect(payload.headers).not.toHaveProperty("Idempotency-Key");
  });

  it("obsługuje alternatywne pole message-id z odpowiedzi Brevo", async () => {
    const client: IBrevoClient = {
      sendTransacEmail: jest.fn(async () => ({ "message-id": "legacy-message-id" })),
    };
    const adapter = makeAdapter(client);

    await expect(adapter.send(makeIntent())).resolves.toMatchObject({
      dispatch_id: "dispatch-1",
      status: "queued",
      provider_message_id: "legacy-message-id",
    });
  });

  it("obsługuje response message_id, provider_message_id oraz brak provider id", async () => {
    const messageIdClient: IBrevoClient = {
      sendTransacEmail: jest.fn(async () => ({ message_id: "snake-message-id" })),
    };
    const providerIdClient: IBrevoClient = {
      sendTransacEmail: jest.fn(async () => ({
        provider_message_id: "provider-message-id",
      })),
    };
    const emptyClient: IBrevoClient = {
      sendTransacEmail: jest.fn(async () => ({})),
    };

    await expect(makeAdapter(messageIdClient).send(makeIntent())).resolves.toMatchObject({
      provider_message_id: "snake-message-id",
    });
    await expect(makeAdapter(providerIdClient).send(makeIntent())).resolves.toMatchObject({
      provider_message_id: "provider-message-id",
    });
    await expect(makeAdapter(emptyClient).send(makeIntent())).resolves.toMatchObject({
      dispatch_id: "dispatch-1",
      status: "queued",
    });
  });

  it("opakowuje błąd Brevo 4xx jako MessagingProviderError z kodem z body", async () => {
    const client: IBrevoClient = {
      sendTransacEmail: jest.fn(async () => {
        throw {
          status: 400,
          response: {
            body: {
              code: "invalid_parameter",
              message: "Invalid template id",
            },
          },
        };
      }),
    };
    const adapter = makeAdapter(client);

    await expect(adapter.send(makeIntent())).rejects.toBeInstanceOf(
      MessagingProviderError,
    );
    // R-2.2-M5 NADAL OBOWIĄZUJE: `message` nie cytuje SUROWEJ treści z odpowiedzi
    // Brevo (komunikaty walidacyjne rutynowo zawierają odrzucony adres).
    //
    // ZMIANA (2026-08-02): kod jest NORMALIZOWANY do postaci marker-safe, a
    // przyczyna przenoszona w markerach PO REDAKCJI. `invalid_parameter` małymi
    // literami nie przechodził przez `[gp_error_code=…]` (`[A-Z0-9_]+`), więc
    // klasa błędu ginęła i ledger zapisywał generyczny fallback.
    await expect(adapter.send(makeIntent())).rejects.toMatchObject({
      error_code: "BREVO_INVALID_PARAMETER",
      status_code: 400,
      message: expect.stringContaining(
        "Brevo provider request failed (BREVO_INVALID_PARAMETER, HTTP 400)",
      ),
    });
    await expect(adapter.send(makeIntent())).rejects.toMatchObject({
      message: expect.stringContaining("[gp_provider_status=400]"),
      provider_detail: "Invalid template id",
    });
  });

  it("przepuszcza gotowy MessagingProviderError bez remapowania", async () => {
    const providerError = new MessagingProviderError("mapped upstream", {
      error_code: "BREVO_ALREADY_MAPPED",
      status_code: 429,
    });
    const client: IBrevoClient = {
      sendTransacEmail: jest.fn(async () => {
        throw providerError;
      }),
    };
    const adapter = makeAdapter(client);

    await expect(adapter.send(makeIntent())).rejects.toBe(providerError);
  });

  it("czyta kod błędu z body albo code i używa fallback message", async () => {
    const bodyCodeClient: IBrevoClient = {
      sendTransacEmail: jest.fn(async () => {
        throw {
          statusCode: 422,
          body: {
            code: "body_code",
          },
        };
      }),
    };
    const rootCodeClient: IBrevoClient = {
      sendTransacEmail: jest.fn(async () => {
        throw {
          code: "root_code",
        };
      }),
    };
    const fallbackClient: IBrevoClient = {
      sendTransacEmail: jest.fn(async () => {
        throw {};
      }),
    };

    // Kody providera są normalizowane do postaci marker-safe — bez tego marker
    // `[gp_error_code=…]` ich nie przenosi (patrz `normalizeProviderErrorCode`).
    await expect(makeAdapter(bodyCodeClient).send(makeIntent())).rejects.toMatchObject({
      error_code: "BREVO_BODY_CODE",
      message: expect.stringContaining(
        "Brevo provider request failed (BREVO_BODY_CODE, HTTP 422)",
      ),
      status_code: 422,
    });
    await expect(makeAdapter(rootCodeClient).send(makeIntent())).rejects.toMatchObject({
      error_code: "BREVO_ROOT_CODE",
      // Bez statusu HTTP nie ma markera statusu — nie zmyślamy go.
      message: "Brevo provider request failed (BREVO_ROOT_CODE)",
    });
    await expect(makeAdapter(fallbackClient).send(makeIntent())).rejects.toMatchObject({
      error_code: "BREVO_PROVIDER_ERROR",
      message: "Brevo provider request failed (BREVO_PROVIDER_ERROR)",
    });
  });

  it("opakowuje błąd Brevo 5xx jako MessagingProviderError z fallback code", async () => {
    const client: IBrevoClient = {
      sendTransacEmail: jest.fn(async () => {
        throw {
          response: {
            status: 503,
          },
          message: "Service unavailable",
        };
      }),
    };
    const adapter = makeAdapter(client);

    await expect(adapter.send(makeIntent())).rejects.toMatchObject({
      error_code: "BREVO_HTTP_503",
      status_code: 503,
      message: expect.stringContaining(
        "Brevo provider request failed (BREVO_HTTP_503, HTTP 503)",
      ),
    });
    // Odpowiedź providera jest przenoszona — bez niej `BREVO_HTTP_503` nie mówi
    // operatorowi nic ponad "coś padło".
    await expect(adapter.send(makeIntent())).rejects.toMatchObject({
      message: expect.stringContaining("[gp_provider_status=503]"),
      provider_detail: "Service unavailable",
    });
  });

  it("forwarduje locale jako params dla template i18n", () => {
    const client: IBrevoClient = {
      sendTransacEmail: jest.fn(),
    };
    const adapter = makeAdapter(client);

    const plPayload = adapter.toBrevoPayload(makeIntent({ locale: "pl-PL" }));
    const dePayload = adapter.toBrevoPayload(
      makeIntent({ locale: "de-DE", recipient: { email: "kunde@example.de", market_id: "de" } }),
    );

    expect(plPayload.params.locale).toBe("pl-PL");
    expect(dePayload.params.locale).toBe("de-DE");
    expect(dePayload.sender.email).toBe("notifications@example.de");
  });

  it("rzuca MessagingValidationError dla brakującego emaila", () => {
    const client: IBrevoClient = {
      sendTransacEmail: jest.fn(),
    };
    const adapter = makeAdapter(client);

    expect(() =>
      adapter.toBrevoPayload(
        makeIntent({ recipient: { email: "", market_id: "pl" } }),
      ),
    ).toThrow(MessagingValidationError);
  });

  it("rzuca MessagingProviderError dla brakującego sendera albo template mapping", () => {
    const client: IBrevoClient = {
      sendTransacEmail: jest.fn(),
    };
    const adapter = makeAdapter(client);

    expect(() =>
      adapter.toBrevoPayload(
        makeIntent({ recipient: { email: "buyer@example.com", market_id: "uk" } }),
      ),
    ).toThrow(MessagingProviderError);
    expect(() =>
      adapter.toBrevoPayload(makeIntent({ template_key: "unknown_template" })),
    ).toThrow(MessagingProviderError);
  });
});

// ---------------------------------------------------------------------------
// Story 2.2 review — załączniki (R-2.2-M1) i higiena PII w błędach (R-2.2-M5)
// ---------------------------------------------------------------------------

describe("załączniki i higiena błędów (review 2.2)", () => {
  it("mapuje intent.attachments na kontrakt Brevo `attachment[{content,name}]`", () => {
    const client: IBrevoClient = { sendTransacEmail: jest.fn() };
    const payload = makeAdapter(client).toBrevoPayload(
      makeIntent({
        attachments: [{ name: "wizyta.ics", content_base64: "QkVHSU46VkNBTEVOREFS" }],
      }),
    );

    expect(payload.attachment).toEqual([
      { content: "QkVHSU46VkNBTEVOREFS", name: "wizyta.ics" },
    ]);
  });

  it("bez załączników pole `attachment` w ogóle nie powstaje", () => {
    const client: IBrevoClient = { sendTransacEmail: jest.fn() };
    const payload = makeAdapter(client).toBrevoPayload(makeIntent());

    expect("attachment" in payload).toBe(false);
  });

  it("adres odbiorcy z komunikatu Brevo NIE wycieka do message błędu", async () => {
    const client: IBrevoClient = {
      sendTransacEmail: jest.fn(async () => {
        throw {
          status: 400,
          body: {
            code: "invalid_parameter",
            message: "Invalid email address: buyer@example.com",
          },
        };
      }),
    };

    await expect(makeAdapter(client).send(makeIntent())).rejects.toMatchObject({
      error_code: "BREVO_INVALID_PARAMETER",
    });
    await expect(makeAdapter(client).send(makeIntent())).rejects.not.toMatchObject({
      message: expect.stringContaining("buyer@example.com"),
    });
    // Przenoszenie przyczyny NIE osłabia tej gwarancji: treść idzie przez
    // redaktor, więc adres jest zastąpiony placeholderem, a diagnostyka zostaje.
    await expect(makeAdapter(client).send(makeIntent())).rejects.toMatchObject({
      provider_detail: "Invalid email address: <redacted:email>",
    });
  });

  it("błędy konfiguracji są oznaczone jako pre-flight (nic nie wysłano)", async () => {
    const client: IBrevoClient = { sendTransacEmail: jest.fn() };

    await expect(
      makeAdapter(client).send(makeIntent({ template_key: "spoza_rejestru" })),
    ).rejects.toMatchObject({
      error_code: "BREVO_TEMPLATE_NOT_CONFIGURED",
      preflight: true,
    });
    await expect(
      makeAdapter(client).send(makeIntent({ recipient: { email: "x@y.z", market_id: "xx" } })),
    ).rejects.toMatchObject({
      error_code: "BREVO_SENDER_NOT_CONFIGURED",
      preflight: true,
    });
    expect(client.sendTransacEmail).not.toHaveBeenCalled();
  });
});
