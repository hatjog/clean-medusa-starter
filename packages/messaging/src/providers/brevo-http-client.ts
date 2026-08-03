/**
 * brevo-http-client.ts — konkretna implementacja `IBrevoClient` (Story 2.2, AD-5).
 *
 * Do 2.2 w repo istniał WYŁĄCZNIE interfejs `IBrevoClient` (+ mocki testowe),
 * więc rejestracja modułu Notification wymagała dostarczenia klienta. Klient jest
 * cienki celowo: mapowanie payloadu żyje w `BrevoAdapter`, tutaj zostaje wyłącznie
 * transport (HTTP + timeout + mapowanie błędu na kształt, który
 * `toMessagingProviderError` potrafi rozłożyć na `status_code`/`error_code`).
 *
 * Sekret: `BREVO_API_KEY` przychodzi WYŁĄCZNIE z env/secret adaptera przez
 * konstruktor. Zero klucza w kodzie, w configu i w logach.
 */

import { MessagingProviderError } from "../errors";
import type {
  BrevoSendResponse,
  BrevoTransactionalEmailPayload,
  IBrevoClient,
} from "./brevo-client";

export const BREVO_DEFAULT_ENDPOINT = "https://api.brevo.com/v3/smtp/email";
export const BREVO_DEFAULT_TIMEOUT_MS = 10_000;

/** Minimalny kontrakt `fetch` — wstrzykiwany w testach (zero ruchu sieciowego). */
export type BrevoFetch = (
  input: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
    signal?: AbortSignal;
  },
) => Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
}>;

export interface BrevoHttpClientOptions {
  apiKey: string;
  endpoint?: string;
  timeoutMs?: number;
  fetchImpl?: BrevoFetch;
}

export class BrevoHttpClient implements IBrevoClient {
  private readonly apiKey: string;
  private readonly endpoint: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: BrevoFetch;

  constructor(options: BrevoHttpClientOptions) {
    if (!options.apiKey?.trim()) {
      throw new MessagingProviderError("Brevo API key is required", {
        error_code: "BREVO_API_KEY_NOT_CONFIGURED",
      });
    }
    this.apiKey = options.apiKey.trim();
    this.endpoint = options.endpoint?.trim() || BREVO_DEFAULT_ENDPOINT;
    this.timeoutMs = options.timeoutMs ?? BREVO_DEFAULT_TIMEOUT_MS;
    this.fetchImpl =
      options.fetchImpl ?? ((input, init) => globalThis.fetch(input, init as RequestInit));
  }

  async sendTransacEmail(
    payload: BrevoTransactionalEmailPayload,
  ): Promise<BrevoSendResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    let response: Awaited<ReturnType<BrevoFetch>>;
    try {
      response = await this.fetchImpl(this.endpoint, {
        method: "POST",
        headers: {
          "api-key": this.apiKey,
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
    } catch (error) {
      // Timeout/DNS/socket — nigdy nie propagujemy surowego błędu (mógłby nieść
      // nagłówek z kluczem w `cause`); zawijamy w kontrolowaną klasę.
      throw new MessagingProviderError(
        controller.signal.aborted
          ? `Brevo request timed out after ${this.timeoutMs}ms`
          : "Brevo request failed before receiving a response",
        {
          error_code: controller.signal.aborted
            ? "BREVO_REQUEST_TIMEOUT"
            : "BREVO_TRANSPORT_ERROR",
        },
      );
    } finally {
      clearTimeout(timer);
    }

    const rawBody = await response.text().catch(() => "");
    const body = parseJsonObject(rawBody);

    if (!response.ok) {
      // Kształt zgodny z tym, co `toBrevoPayload`/`toMessagingProviderError`
      // w BrevoAdapter potrafi rozłożyć (status + body.code + body.message).
      throw Object.assign(new Error("Brevo API returned an error response"), {
        status: response.status,
        body,
      });
    }

    return body as BrevoSendResponse;
  }
}

/**
 * Klient używany, gdy `BREVO_API_KEY` nie jest ustawiony.
 *
 * Rejestracja modułu Notification NIE MOŻE wywrócić bootu przy braku sekretu
 * (AC1), a jednocześnie nie wolno jej zamienić w cichy no-op (AC2/NFR8) —
 * dlatego brak klucza degraduje się do fail-loud dopiero przy próbie wysyłki.
 */
export class NotConfiguredBrevoClient implements IBrevoClient {
  async sendTransacEmail(): Promise<BrevoSendResponse> {
    throw new MessagingProviderError(
      "Brevo API key is not configured — refusing to dispatch (set BREVO_API_KEY)",
      // R-2.2-M2: nic nie poszło do Brevo → gateway nie cache'uje tego failu,
      // więc retry po ustawieniu sekretu realnie dotknie providera.
      { error_code: "BREVO_API_KEY_NOT_CONFIGURED", preflight: true },
    );
  }
}

function parseJsonObject(raw: string): Record<string, unknown> {
  if (!raw.trim()) {
    return {};
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return { message: raw.slice(0, 512) };
  }
}
