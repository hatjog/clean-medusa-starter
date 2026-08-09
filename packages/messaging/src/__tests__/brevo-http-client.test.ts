/**
 * BrevoHttpClient (Story 2.2, AD-5) — transport bez sieci.
 *
 * Każdy test wstrzykuje `fetchImpl`; ŻADEN test nie uderza w api.brevo.com.
 */

import { MessagingProviderError } from "../errors";
import {
  BREVO_DEFAULT_ENDPOINT,
  BREVO_LOOKUP_MAX_ROWS,
  BREVO_LOOKUP_PAGE_SIZE,
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

/**
 * ODCZYT u dostawcy — R-4.5-M2 (stronicowanie) i R-4.5-L2 (górny brzeg okna).
 *
 * Obie kontrole PĘKAJĄ na kodzie sprzed poprawki: pierwsza dostawała jedną
 * stronę i milcząco uznawała okno za przejrzane, druga wysyłała `endDate`
 * obcięty do bieżącej doby UTC.
 */
describe("BrevoHttpClient.findTransactionalMessages — kompletność okna", () => {
  const WINDOW = {
    email: "buyer@example.test",
    startDate: new Date("2026-08-01T00:00:00.000Z"),
    endDate: new Date("2026-08-08T23:30:00.000Z"),
  };

  /** Strona `n` pełna, ostatnia niepełna — jak realny `limit`/`offset`. */
  function pagingFetch(totalRows: number, urls: string[]) {
    return async (url: string) => {
      urls.push(url);
      const offset = Number(new URL(url).searchParams.get("offset"));
      const limit = Number(new URL(url).searchParams.get("limit"));
      const rows = Array.from(
        { length: Math.max(0, Math.min(limit, totalRows - offset)) },
        (_unused, index) => ({ messageId: `<msg-${offset + index}>` }),
      );
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ transactionalEmails: rows }),
      };
    };
  }

  it("STRONICUJE do wyczerpania okna — jedna strona nie jest dowodem nieobecności", async () => {
    const urls: string[] = [];
    const client = new BrevoHttpClient({
      apiKey: "k",
      fetchImpl: pagingFetch(BREVO_LOOKUP_PAGE_SIZE * 2 + 7, urls),
    });

    const rows = await client.findTransactionalMessages(WINDOW);

    expect(rows).toHaveLength(BREVO_LOOKUP_PAGE_SIZE * 2 + 7);
    expect(urls).toHaveLength(3);
    expect(new URL(urls[1]).searchParams.get("offset")).toBe(
      String(BREVO_LOOKUP_PAGE_SIZE),
    );
  });

  it("okno NIEWYCZERPANE ⇒ RZUCA, a nie oddaje niepełnej listy (zgoda na wysyłkę)", async () => {
    const urls: string[] = [];
    const client = new BrevoHttpClient({
      apiKey: "k",
      // Adres wysokoobrotowy: w oknie 8 dni jest więcej wierszy, niż sufit.
      fetchImpl: pagingFetch(BREVO_LOOKUP_MAX_ROWS * 3, urls),
    });

    await expect(client.findTransactionalMessages(WINDOW)).rejects.toMatchObject({
      error_code: "BREVO_LOOKUP_WINDOW_TRUNCATED",
    });
  });

  it("wysyła endDate bieżącej doby: provider wymaga brzegu, ale odrzuca datę z przyszłości", async () => {
    const urls: string[] = [];
    const client = new BrevoHttpClient({ apiKey: "k", fetchImpl: pagingFetch(0, urls) });

    await client.findTransactionalMessages(WINDOW);

    const params = new URL(urls[0]).searchParams;
    expect(params.get("startDate")).toBe("2026-08-01");
    // Obcięcie do „2026-08-08" ukryłoby wiadomość wysłaną przed chwilą, gdyby
    // konto dostawcy liczyło doby w strefie za UTC — a `not_found` z tego
    // powodu jest zgodą na wysyłkę.
    expect(params.get("endDate")).toBe("2026-08-08");
  });
});
