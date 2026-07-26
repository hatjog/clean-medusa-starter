/**
 * RegistryBackedBrevoProvider (Story 2.2, AC2) — allowlista w praktyce.
 *
 * Klient jest zamockowany; asercja `sendTransacEmail` = 0 wywołań na każdej
 * ścieżce fail-loud dowodzi „zero wysyłki spoza rejestru".
 */

import { MessagingProviderError, MessagingValidationError } from "../errors";
import { RegistryBackedBrevoProvider } from "../providers/registry-backed-brevo-provider";
import { NOTIFICATION_TEMPLATE_KEYS } from "../notification-template-registry";
import type { NotificationIntent } from "../types";

function intent(overrides: Partial<NotificationIntent> = {}): NotificationIntent {
  return {
    flow_id: "voucher_delivery",
    channel: "email",
    template_key: NOTIFICATION_TEMPLATE_KEYS.VOUCHER_PURCHASE_CONFIRMATION,
    recipient: { email: "buyer@example.test", market_id: "bonbeauty" },
    variables: { voucher_code: "ABC" },
    locale: "pl-PL",
    consent_basis: "transactional_critical",
    idempotency_key: "idem-1",
    ...overrides,
  };
}

function makeProvider(senders: Record<string, { email: string }> = { bonbeauty: { email: "no-reply@example.test" } }) {
  const sendTransacEmail = jest.fn();
  const provider = new RegistryBackedBrevoProvider({ sendTransacEmail }, { senders });
  return { provider, sendTransacEmail };
}

describe("RegistryBackedBrevoProvider", () => {
  it("ma kanoniczny klucz providera 'brevo'", () => {
    expect(makeProvider().provider.key).toBe("brevo");
  });

  it("klucz spoza rejestru → BREVO_TEMPLATE_NOT_CONFIGURED, zero wysyłki", async () => {
    const { provider, sendTransacEmail } = makeProvider();

    const error = await provider
      .send(intent({ template_key: "klucz_spoza_rejestru" }))
      .catch((e) => e);

    expect(error).toBeInstanceOf(MessagingProviderError);
    expect(error.error_code).toBe("BREVO_TEMPLATE_NOT_CONFIGURED");
    expect(sendTransacEmail).not.toHaveBeenCalled();
  });

  it("klucz Z rejestru, ale brevo: not_configured → ten sam fail-loud, zero wysyłki", async () => {
    // Regresja-guard: gdyby ktoś dodał fallback na „domyślny szablon", ten test
    // zacznie failować (mock zostałby wywołany).
    const { provider, sendTransacEmail } = makeProvider();

    const error = await provider.send(intent()).catch((e) => e);

    expect(error.error_code).toBe("BREVO_TEMPLATE_NOT_CONFIGURED");
    expect(sendTransacEmail).not.toHaveBeenCalled();
  });

  it("brak sendera dla marketu → BREVO_SENDER_NOT_CONFIGURED, zero wysyłki", async () => {
    const { provider, sendTransacEmail } = makeProvider({});

    const error = await provider.send(intent()).catch((e) => e);

    expect(error.error_code).toBe("BREVO_SENDER_NOT_CONFIGURED");
    expect(sendTransacEmail).not.toHaveBeenCalled();
  });

  it("brak adresu odbiorcy → BREVO_RECIPIENT_EMAIL_REQUIRED, zero wysyłki", async () => {
    const { provider, sendTransacEmail } = makeProvider();

    const error = await provider
      .send(intent({ recipient: { market_id: "bonbeauty" } }))
      .catch((e) => e);

    expect(error).toBeInstanceOf(MessagingValidationError);
    expect(error.error_code).toBe("BREVO_RECIPIENT_EMAIL_REQUIRED");
    expect(sendTransacEmail).not.toHaveBeenCalled();
  });

  it("skonfigurowane ID (locale-aware) → payload zbudowany przez BrevoAdapter", async () => {
    // Stan „operator uzupełnił ID w rejestrze" odgrywamy przez seam
    // `templateMapFor` — story NIE zgaduje ID szablonów Brevo w rejestrze YAML.
    const sendTransacEmail = jest.fn().mockResolvedValue({ messageId: "msg-9" });
    const providerWithMap = new RegistryBackedBrevoProvider(
      { sendTransacEmail },
      {
        senders: { bonbeauty: { email: "no-reply@example.test" } },
        templateMapFor: (locale): Record<string, number> =>
          locale === "pl-PL"
            ? { [NOTIFICATION_TEMPLATE_KEYS.VOUCHER_PURCHASE_CONFIRMATION]: 77 }
            : {},
      },
    );

    const response = await providerWithMap.send(intent());

    expect(response.status).toBe("queued");
    expect(response.provider_message_id).toBe("msg-9");
    expect(sendTransacEmail).toHaveBeenCalledTimes(1);
    expect(sendTransacEmail.mock.calls[0][0]).toMatchObject({
      templateId: 77,
      to: [{ email: "buyer@example.test" }],
      sender: { email: "no-reply@example.test" },
    });
  });

  it("locale bez skonfigurowanego ID nie dziedziczy mapy innego locale", async () => {
    const sendTransacEmail = jest.fn().mockResolvedValue({ messageId: "msg-9" });
    const providerWithMap = new RegistryBackedBrevoProvider(
      { sendTransacEmail },
      {
        senders: { bonbeauty: { email: "no-reply@example.test" } },
        templateMapFor: (locale): Record<string, number> =>
          locale === "pl-PL"
            ? { [NOTIFICATION_TEMPLATE_KEYS.VOUCHER_PURCHASE_CONFIRMATION]: 77 }
            : {},
      },
    );

    await providerWithMap.send(intent());
    const error = await providerWithMap.send(intent({ locale: "de-DE" })).catch((e) => e);

    expect(error.error_code).toBe("BREVO_TEMPLATE_NOT_CONFIGURED");
    expect(sendTransacEmail).toHaveBeenCalledTimes(1);
  });
});
