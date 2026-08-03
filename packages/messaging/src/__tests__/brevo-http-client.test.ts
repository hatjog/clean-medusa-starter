/**
 * BrevoHttpClient (Story 2.2, AD-5) — transport bez sieci.
 *
 * Każdy test wstrzykuje `fetchImpl`; ŻADEN test nie uderza w api.brevo.com.
 */

import { MessagingProviderError } from "../errors";
import {
  BREVO_DEFAULT_ENDPOINT,
  BrevoHttpClient,
  NotConfiguredBrevoClient,
} from "../providers/brevo-http-client";
import type { BrevoTransactionalEmailPayload } from "../providers/brevo-client";

const PAYLOAD: BrevoTransactionalEmailPayload = {
  templateId: 42,
  to: [{ email: "buyer@example.test" }],
  sender: { email: "no-reply@example.test", name: "GP" },
  params: { locale: "pl-PL" },
  headers: { "X-Mailin-Tag": "bonbeauty:flow:key" },
};

function okFetch(body: unknown, captured?: { init?: unknown; url?: string }) {
  return async (url: string, init: unknown) => {
    if (captured) {
      captured.url = url;
      captured.init = init;
    }
    return {
      ok: true,
      status: 201,
      text: async () => JSON.stringify(body),
    };
  };
}

describe("BrevoHttpClient", () => {
  it("POST-uje payload na endpoint Brevo z nagłówkiem api-key", async () => {
    const captured: { init?: any; url?: string } = {};
    const client = new BrevoHttpClient({
      apiKey: "test-key",
      fetchImpl: okFetch({ messageId: "msg-1" }, captured),
    });

    const response = await client.sendTransacEmail(PAYLOAD);

    expect(response.messageId).toBe("msg-1");
    expect(captured.url).toBe(BREVO_DEFAULT_ENDPOINT);
    expect(captured.init.method).toBe("POST");
    expect(captured.init.headers["api-key"]).toBe("test-key");
    expect(JSON.parse(captured.init.body)).toEqual(PAYLOAD);
  });

  it("odpowiedź 4xx → błąd o kształcie rozkładanym przez BrevoAdapter (status + body.code)", async () => {
    const client = new BrevoHttpClient({
      apiKey: "test-key",
      fetchImpl: async () => ({
        ok: false,
        status: 400,
        text: async () => JSON.stringify({ code: "invalid_parameter", message: "bad template" }),
      }),
    });

    await expect(client.sendTransacEmail(PAYLOAD)).rejects.toMatchObject({
      status: 400,
      body: { code: "invalid_parameter", message: "bad template" },
    });
  });

  it("timeout transportu → MessagingProviderError BREVO_REQUEST_TIMEOUT (bez wycieku nagłówków)", async () => {
    const client = new BrevoHttpClient({
      apiKey: "test-key",
      timeoutMs: 5,
      fetchImpl: (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    });

    const error = await client.sendTransacEmail(PAYLOAD).catch((e) => e);
    expect(error).toBeInstanceOf(MessagingProviderError);
    expect(error.error_code).toBe("BREVO_REQUEST_TIMEOUT");
    expect(JSON.stringify(error)).not.toContain("test-key");
  });

  it("pusty apiKey → fail-loud już w konstruktorze", () => {
    expect(() => new BrevoHttpClient({ apiKey: "   " })).toThrow(MessagingProviderError);
  });
});

describe("NotConfiguredBrevoClient", () => {
  it("nie wysyła nic i failuje głośno kodem BREVO_API_KEY_NOT_CONFIGURED", async () => {
    const error = await new NotConfiguredBrevoClient()
      .sendTransacEmail()
      .catch((e) => e);

    expect(error).toBeInstanceOf(MessagingProviderError);
    expect(error.error_code).toBe("BREVO_API_KEY_NOT_CONFIGURED");
  });
});
