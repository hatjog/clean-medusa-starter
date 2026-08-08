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
  BrevoTransactionalMessage,
  BrevoTransactionalMessageQuery,
  IBrevoClient,
} from "./brevo-client";

export const BREVO_DEFAULT_ENDPOINT = "https://api.brevo.com/v3/smtp/email";
/**
 * Endpoint ODCZYTU (Story 4.5). Ta sama baza, inny zasób — `…/smtp/emails`
 * (liczba mnoga) zwraca wiadomości PRZYJĘTE przez dostawcę.
 */
export const BREVO_DEFAULT_MESSAGES_ENDPOINT =
  "https://api.brevo.com/v3/smtp/emails";
export const BREVO_DEFAULT_TIMEOUT_MS = 10_000;

/** Minimalny kontrakt `fetch` — wstrzykiwany w testach (zero ruchu sieciowego). */
export type BrevoFetch = (
  input: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body?: string;
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
  /** Patrz {@link BREVO_DEFAULT_MESSAGES_ENDPOINT}. */
  messagesEndpoint?: string;
  timeoutMs?: number;
  fetchImpl?: BrevoFetch;
}

export class BrevoHttpClient implements IBrevoClient {
  private readonly apiKey: string;
  private readonly endpoint: string;
  private readonly messagesEndpoint: string;
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
    this.messagesEndpoint =
      options.messagesEndpoint?.trim() || BREVO_DEFAULT_MESSAGES_ENDPOINT;
    this.timeoutMs = options.timeoutMs ?? BREVO_DEFAULT_TIMEOUT_MS;
    this.fetchImpl =
      options.fetchImpl ?? ((input, init) => globalThis.fetch(input, init as RequestInit));
  }

  /**
   * ODCZYT wiadomości przyjętych przez dostawcę (Story 4.5).
   *
   * ── Co jest zlecane serwerowi, a co NIE (i dlaczego) ──────────────────────
   * Serwerowi zlecamy WYŁĄCZNIE te predykaty, które są ZMIERZONE jako
   * działające: `email` (filtr obowiązkowy — bez niego `400 missing_parameter`),
   * `templateId` oraz okno `startDate`/`endDate` (zmierzone zawężenie 9 → 6
   * wierszy, a okno sprzed lat → 0).
   *
   * Serwerowego filtra `tags` NIE UŻYWAMY, i to jest rozstrzygnięcie oparte na
   * pomiarze, nie ostrożność: zapytanie z tagiem, KTÓREGO NIE MA, zwróciło
   * KOMPLET wierszy — filtr jest na tym endpoincie no-opem. Mechanizm, który by
   * mu zaufał, na każde pytanie odpowiadałby „ta wiadomość istnieje", blokował
   * WSZYSTKIE wysyłki i wyglądał przy tym na działający (żaden duplikat nigdy
   * nie powstaje). Dopasowanie tożsamości robi więc adapter, na zwróconych
   * wierszach.
   *
   * @throws MessagingProviderError przy każdej odpowiedzi innej niż 2xx oraz
   *         przy awarii transportu. Pusta lista jest zwracana WYŁĄCZNIE po
   *         udanym odczycie — inaczej „nie udało mi się zapytać" byłoby
   *         nieodróżnialne od „zapytałem i nie ma".
   */
  async findTransactionalMessages(
    query: BrevoTransactionalMessageQuery,
  ): Promise<BrevoTransactionalMessage[]> {
    const params = new URLSearchParams({
      email: query.email,
      startDate: toBrevoDate(query.startDate),
      endDate: toBrevoDate(query.endDate),
      limit: String(query.limit ?? 100),
    });
    if (typeof query.templateId === "number") {
      params.set("templateId", String(query.templateId));
    }

    const body = await this.request(
      `${this.messagesEndpoint}?${params.toString()}`,
      { method: "GET" },
      "BREVO_LOOKUP",
    );
    const rows = (body as { transactionalEmails?: unknown }).transactionalEmails;
    if (!Array.isArray(rows)) {
      // Brak klucza w odpowiedzi 200 to u tego dostawcy „zero trafień"
      // (zmierzone: `{}` dla okna sprzed lat), a nie awaria.
      return [];
    }
    return rows as BrevoTransactionalMessage[];
  }

  async sendTransacEmail(
    payload: BrevoTransactionalEmailPayload,
  ): Promise<BrevoSendResponse> {
    const body = await this.request(
      this.endpoint,
      { method: "POST", body: JSON.stringify(payload) },
      "BREVO",
    );
    return body as BrevoSendResponse;
  }

  /**
   * Wspólny transport dla wysyłki i odczytu.
   *
   * `errorPrefix` rozróżnia oba kierunki w kodzie błędu (`BREVO_REQUEST_TIMEOUT`
   * vs `BREVO_LOOKUP_REQUEST_TIMEOUT`) — bez tego awaria ODCZYTU byłaby
   * w telemetrii nieodróżnialna od awarii WYSYŁKI, a to są przeciwne
   * konsekwencje: pierwsza wstrzymuje maila, druga go nie dowozi.
   */
  private async request(
    url: string,
    init: { method: string; body?: string },
    errorPrefix: string,
  ): Promise<Record<string, unknown>> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    let response: Awaited<ReturnType<BrevoFetch>>;
    try {
      response = await this.fetchImpl(url, {
        method: init.method,
        headers: {
          "api-key": this.apiKey,
          "content-type": "application/json",
          accept: "application/json",
        },
        ...(init.body === undefined ? {} : { body: init.body }),
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
            ? `${errorPrefix}_REQUEST_TIMEOUT`
            : `${errorPrefix}_TRANSPORT_ERROR`,
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
      // Dotyczy TAKŻE `429`, które przy odczycie zmierzyliśmy jako realne
      // (seria zapytań w oknie pomiarowym) — rate limit MUSI dojechać jako
      // błąd, nigdy jako „zero trafień".
      throw Object.assign(new Error("Brevo API returned an error response"), {
        status: response.status,
        body,
      });
    }

    return body;
  }
}

/** Dostawca oczekuje `YYYY-MM-DD` w `startDate`/`endDate` (zmierzone). */
function toBrevoDate(value: Date): string {
  return value.toISOString().slice(0, 10);
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

  /**
   * RZUCA, a nie zwraca pustej listy (Story 4.5). Bez klucza nie zadaliśmy
   * dostawcy żadnego pytania, więc odpowiedź „w oknie nie ma tej wiadomości"
   * byłaby zmyślona — i zwolniłaby drogę do drugiego maila dokładnie w tym
   * przebiegu, który ta bariera ma zatrzymać.
   */
  async findTransactionalMessages(): Promise<never> {
    throw new MessagingProviderError(
      "Brevo API key is not configured — nie da się rozstrzygnąć, czy wiadomość " +
        "już poszła (set BREVO_API_KEY)",
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
