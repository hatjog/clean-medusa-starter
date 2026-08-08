import { randomUUID } from "node:crypto";

import { MessagingProviderError, MessagingValidationError } from "../errors";
// `buildBarrierKey` mieszka przy gatewayu i jest JEDYNYM źródłem klucza bariery.
// Powtórzenie jego składni tutaj dałoby drugą definicję tożsamości, która
// rozjechałaby się z pierwszą przy pierwszej zmianie — i to po cichu, bo obie
// dawałyby poprawnie wyglądające stringi. `gateway.ts` nie importuje adapterów,
// więc cykl nie powstaje.
import { buildBarrierKey } from "../gateway";
import {
  buildDispatchIdentityTag,
  type IProviderDispatchResolver,
  type ProviderDispatchLookup,
  type ProviderDispatchResolution,
} from "../provider-dispatch-resolution";
import {
  formatProviderResponseMarkers,
  normalizeProviderErrorCode,
  sanitizeProviderDetail,
} from "../provider-detail";
import type { IMessagingProvider, MessagingProviderResponse } from "../provider";
import type { NotificationIntent } from "../types";
import type {
  BrevoEmailAddress,
  BrevoSendResponse,
  BrevoTransactionalEmailPayload,
  IBrevoClient,
} from "./brevo-client";

export interface BrevoAdapterOptions {
  senders: Record<string, BrevoEmailAddress>;
  templates: Record<string, number>;
  clock?: () => Date;
  uuid?: () => string;
}

export class BrevoAdapter
  implements IMessagingProvider, IProviderDispatchResolver
{
  readonly key = "brevo" as const;

  private readonly clock: () => Date;
  private readonly uuid: () => string;

  constructor(
    private readonly client: IBrevoClient,
    private readonly options: BrevoAdapterOptions,
  ) {
    this.clock = options.clock ?? (() => new Date());
    this.uuid = options.uuid ?? (() => randomUUID());
  }

  async send(intent: NotificationIntent): Promise<MessagingProviderResponse> {
    const payload = this.toBrevoPayload(intent);

    try {
      const response = await this.client.sendTransacEmail(payload);
      return {
        dispatch_id: this.uuid(),
        status: "queued",
        provider_message_id: extractProviderMessageId(response),
        sent_at: this.clock().toISOString(),
      };
    } catch (error) {
      throw toMessagingProviderError(error);
    }
  }

  /**
   * ROZSTRZYGANIE PO STRONIE DOSTAWCY (Story 4.5, FR-9f, AD-23).
   *
   * Odpowiada na pytanie, na które bariera po naszej stronie strukturalnie nie
   * umie odpowiedzieć: „zająłem klucz, zawołałem providera — i nie wiem, czy
   * mail poszedł, bo zginąłem, zanim przeczytałem odpowiedź".
   *
   * ── Dlaczego dopasowanie tożsamości jest TUTAJ, a nie w zapytaniu ─────────
   * Bo serwerowy filtr `tags` na `GET /v3/smtp/emails` jest NO-OPEM — zmierzone
   * 2026-08-08: zapytanie o tag, KTÓREGO NIE MA, zwróciło komplet wierszy.
   * Zaufanie mu dałoby mechanizm, który na każde pytanie odpowiada „ta
   * wiadomość istnieje", blokuje wszystkie wysyłki i wygląda przy tym na
   * działający, bo żaden duplikat nigdy nie powstaje. Serwerowi zlecamy więc
   * tylko predykaty ZMIERZONE jako działające (`email`, `templateId`, okno dat),
   * a tożsamość dopasowujemy na zwróconych wierszach.
   *
   * ── Trzy werdykty i dlaczego trzeci nie może zniknąć ─────────────────────
   * `confirmed_sent` / `not_found` / `unknown`. Sklejenie `unknown` z
   * `not_found` — czyli potraktowanie awarii odczytu jak nieobecności — jest
   * dokładnie tą klasą cichej awarii, którą ta story zamyka: prowadzi do
   * wysyłki w ciemno po przebiegu, który MÓGŁ już wysłać.
   */
  async resolveDispatched(
    lookup: ProviderDispatchLookup,
  ): Promise<ProviderDispatchResolution> {
    if (typeof this.client.findTransactionalMessages !== "function") {
      return {
        outcome: "unknown",
        reason:
          "klient Brevo nie ma zdolności odczytu (findTransactionalMessages)",
      };
    }

    const templateId = this.options.templates[lookup.template_key];

    let messages;
    try {
      messages = await this.client.findTransactionalMessages({
        email: lookup.recipient_email,
        ...(typeof templateId === "number" ? { templateId } : {}),
        startDate: lookup.sent_after,
        endDate: lookup.now,
      });
    } catch (error) {
      const wrapped = toMessagingProviderError(error);
      return { outcome: "unknown", reason: wrapped.message };
    }

    const hit = messages.find((message) =>
      (message.tags ?? []).includes(lookup.dispatch_identity),
    );

    if (!hit) {
      return { outcome: "not_found" };
    }

    return {
      outcome: "confirmed_sent",
      provider_message_id:
        typeof hit.messageId === "string" && hit.messageId.trim()
          ? hit.messageId
          : undefined,
      sent_at:
        typeof hit.date === "string" && hit.date.trim() ? hit.date : undefined,
    };
  }

  /**
   * F-06: publiczna metoda WYŁĄCZNIE dla testów jednostkowych mapowania payloadu.
   * Produkcyjne callsite MUSZĄ wywoływać przez `MessagingGateway.send` — bezpośrednie
   * użycie pomija invariant `audit_event` (gateway wzbogaca każdy throw o audit envelope).
   */
  toBrevoPayload(intent: NotificationIntent): BrevoTransactionalEmailPayload {
    const recipientEmail = intent.recipient.email?.trim();
    if (!recipientEmail) {
      throw new MessagingValidationError("Email recipient is required for Brevo", {
        error_code: "BREVO_RECIPIENT_EMAIL_REQUIRED",
        preflight: true,
      });
    }

    const sender = this.options.senders[intent.recipient.market_id];
    if (!sender) {
      throw new MessagingProviderError(
        `Brevo sender is not configured for market '${intent.recipient.market_id}'`,
        {
          error_code: "BREVO_SENDER_NOT_CONFIGURED",
          // R-2.2-M2: błąd konfiguracji — nic nie poszło do Brevo, więc gateway
          // NIE MOŻE go zacache'ować (inaczej retry po naprawie configu przez
          // 24 h nie dotknąłby providera).
          preflight: true,
        },
      );
    }

    const templateId = this.options.templates[intent.template_key];
    if (typeof templateId !== "number") {
      throw new MessagingProviderError(
        `Brevo template is not configured for '${intent.template_key}'`,
        {
          error_code: "BREVO_TEMPLATE_NOT_CONFIGURED",
          preflight: true,
        },
      );
    }

    return {
      templateId,
      to: [{ email: recipientEmail }],
      sender,
      params: {
        ...intent.variables,
        locale: intent.locale,
        flow_id: intent.flow_id,
        market_id: intent.recipient.market_id,
      },
      // TOŻSAMOŚĆ POJEDYNCZEJ WYSYŁKI (Story 4.5, FR-9f). Wyprowadzona z klucza
      // bariery, więc ZNANA PRZED wysyłką i odtwarzalna przez ponowienie, które
      // nie ma dostępu do niczego, co poprzedni (martwy) przebieg zapisał.
      // To jest jedyny nośnik pozwalający zapytać dostawcę „czy TA konkretna
      // wiadomość już u ciebie jest" — patrz `resolveDispatched` niżej.
      // R-4.5-M1: adres jest CZĘŚCIĄ tożsamości, bo odczyt u dostawcy filtruje
      // po adresie obowiązkowo. Ta sama funkcja normalizuje go po obu stronach,
      // więc wysyłka i późniejszy odczyt wyprowadzają identyczną wartość.
      tags: [buildDispatchIdentityTag(buildBarrierKey(intent), recipientEmail)],
      // F-09: `headers` w Brevo TransactionalEmailsApi to message headers (widoczne w `view source`
      // wiadomości po stronie odbiorcy). Usunęliśmy X-GP-Flow-Id / X-GP-Template-Key / X-GP-Locale
      // (PII/routing leak ryzyko).
      //
      // ── Story 4.5: dwa zdania, które tu wcześniej stały, były NIEPRAWDZIWE ──
      // 1. „propagujemy idempotency_key w `params`" — NIE propagowaliśmy.
      //    `CONTROL_KEYS` w `modules/notification-brevo/intent.ts` wycinał ten
      //    klucz przy budowie `variables`, więc do dostawcy nie jechało NIC, co
      //    identyfikowałoby pojedynczą wysyłkę. Komentarz opisywał mechanizm,
      //    którego nie było.
      // 2. „X-Mailin-Tag = tag wymagany dla downstream correlation" — dla
      //    wysyłek przez `templateId` ten nagłówek W OGÓLE NIE DOJEŻDŻA.
      //    Zmierzone 2026-08-08 na realnym koncie: odczyt `GET /v3/smtp/emails`
      //    oddaje tag skonfigurowany NA SZABLONIE, a nagłówkowy znika bez śladu.
      //    Nośnikiem, który dojeżdża, jest pole `tags` w body (wyżej).
      //    Nagłówek zostaje wyłącznie jako etykieta ruchu w panelu dostawcy —
      //    i nie jest podstawą żadnej decyzji w kodzie.
      //
      // Zdanie „API-level idempotency hint nie jest wspierany" ZOSTAJE, ale
      // dopiero teraz ma pomiar: trzy wysyłki z identycznym kluczem (nagłówek
      // `Idempotency-Key`, `idempotency-key`, pole `idempotencyKey` w body) dały
      // HTTP 201 i TRZY różne `messageId`. Dostawca tych nośników nie odrzuca —
      // ignoruje je. Pełny zapis: `evidence/4-5/pomiar-zdolnosci-dostawcy.md`,
      // decyzja: ADR wskazany w `Dev Agent Record` story 4.5.
      headers: {
        "X-Mailin-Tag": `${intent.recipient.market_id}:${intent.flow_id}:${intent.template_key}`,
      },
      // R-2.2-M1: załączniki jadą do Brevo jako `attachment: [{content(base64), name}]`.
      // Pole jest pomijane, gdy intent ich nie niesie (Brevo odrzuca pustą tablicę).
      ...(intent.attachments?.length
        ? {
            attachment: intent.attachments.map((attachment) => ({
              content: attachment.content_base64,
              name: attachment.name,
            })),
          }
        : {}),
    };
  }
}

function extractProviderMessageId(response: BrevoSendResponse): string | undefined {
  return (
    readString(response, "messageId") ??
    readString(response, "message-id") ??
    readString(response, "message_id") ??
    readString(response, "provider_message_id")
  );
}

function toMessagingProviderError(error: unknown): MessagingProviderError {
  if (error instanceof MessagingProviderError) {
    return error;
  }

  const statusCode = extractStatusCode(error);
  // Kod providera jest NORMALIZOWANY do postaci marker-safe (`[A-Z0-9_]+`).
  // Brevo zwraca `body.code` małymi literami (`unauthorized`,
  // `invalid_parameter`, …), a marker `[gp_error_code=…]` takiego kodu NIE
  // parsuje — bez normalizacji KAŻDY kod realnie podany przez providera ginął
  // i subscriber zapisywał generyczne `VOUCHER_DELIVERY_DISPATCH_FAILED`
  // (żywy zakup 2026-08-01: HTTP 401 `unauthorized` = autoryzacja IP w Brevo,
  // objawowo nieodróżnialna od błędu kodu).
  const rawErrorCode =
    extractNestedString(error, ["response", "body", "code"]) ??
    extractNestedString(error, ["body", "code"]) ??
    extractNestedString(error, ["code"]);
  const errorCode = rawErrorCode
    ? normalizeProviderErrorCode(rawErrorCode, "BREVO_PROVIDER_ERROR")
    : statusCode
      ? `BREVO_HTTP_${statusCode}`
      : "BREVO_PROVIDER_ERROR";

  // R-2.2-M5 (D-70) NADAL OBOWIĄZUJE: surowa treść odpowiedzi Brevo rutynowo
  // cytuje odrzucony adres, więc do komunikatu NIE trafia nic surowego. Zmienia
  // się jedno: zamiast wyrzucać treść w całości, przepuszczamy ją przez
  // `sanitizeProviderDetail` (adresy, IP, sekrety i długie tokeny → placeholdery)
  // i doklejamy jako MARKERY. Bez tego przyczyna dawała się ustalić wyłącznie
  // ręcznym odpytaniem API providera — a `cause` nie przeżywa przepakowania
  // wyjątku przez moduł Notification Medusy.
  const providerDetail = sanitizeProviderDetail(
    extractNestedRecord(error, ["response", "body"]) ??
      extractNestedRecord(error, ["body"]) ??
      error,
  );
  const message =
    (statusCode
      ? `Brevo provider request failed (${errorCode}, HTTP ${statusCode})`
      : `Brevo provider request failed (${errorCode})`) +
    formatProviderResponseMarkers({
      status_code: statusCode,
      detail: providerDetail,
    });

  return new MessagingProviderError(message, {
    error_code: errorCode,
    cause: error,
    status_code: statusCode,
    provider_detail: providerDetail ?? undefined,
  });
}

/** Zagnieżdżony obiekt spod ścieżki kluczy — nośnik `body` odpowiedzi HTTP. */
function extractNestedRecord(
  error: unknown,
  path: readonly string[],
): Record<string, unknown> | null {
  let current: unknown = error;
  for (const key of path) {
    if (!current || typeof current !== "object") return null;
    current = (current as Record<string, unknown>)[key];
  }
  return current && typeof current === "object"
    ? (current as Record<string, unknown>)
    : null;
}

function extractStatusCode(error: unknown): number | undefined {
  const status =
    extractNestedNumber(error, ["status"]) ??
    extractNestedNumber(error, ["statusCode"]) ??
    extractNestedNumber(error, ["response", "status"]) ??
    extractNestedNumber(error, ["response", "statusCode"]);

  return status;
}

function readString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function extractNestedString(
  value: unknown,
  path: readonly string[],
): string | undefined {
  const nested = readNested(value, path);
  return typeof nested === "string" && nested.trim() ? nested : undefined;
}

function extractNestedNumber(
  value: unknown,
  path: readonly string[],
): number | undefined {
  const nested = readNested(value, path);
  return typeof nested === "number" ? nested : undefined;
}

function readNested(value: unknown, path: readonly string[]): unknown {
  let cursor = value;
  for (const key of path) {
    if (!isRecord(cursor)) {
      return undefined;
    }
    cursor = cursor[key];
  }
  return cursor;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
