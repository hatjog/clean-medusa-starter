export interface BrevoEmailAddress {
  email: string;
  name?: string;
}

/** Załącznik w kontrakcie Brevo `sendTransacEmail` (`content` = base64). */
export interface BrevoAttachment {
  content: string;
  name: string;
}

export interface BrevoTransactionalEmailPayload {
  templateId: number;
  to: BrevoEmailAddress[];
  sender: BrevoEmailAddress;
  params: Record<string, unknown>;
  headers: Record<string, string>;
  /**
   * Tagi wysyłki — Story 4.5, JEDYNY zmierzony nośnik tożsamości, który
   * dojeżdża do dostawcy i wraca w odczycie.
   *
   * Pomiar 2026-08-08 (evidence `evidence/4-5/pomiar-zdolnosci-dostawcy.md`):
   * dla wysyłek przez `templateId` nagłówek `X-Mailin-Tag` NIE dojeżdża —
   * odczyt oddaje tag skonfigurowany na szablonie, a nagłówkowy znika bez
   * śladu. Pole `tags` w body dojeżdża i wraca w `GET /v3/smtp/emails`.
   *
   * Wartości NIE MOGĄ zawierać przecinka: po stronie dostawcy tag bywa po nim
   * rozbijany (zmierzone na `/v3/smtp/statistics/events`).
   */
  tags?: string[];
  /** Obecne tylko gdy intent niesie załączniki (R-2.2-M1). */
  attachment?: BrevoAttachment[];
}

/**
 * Wiersz z `GET /v3/smtp/emails` — kształt ZMIERZONY, nie przepisany z docsów.
 *
 * Pola potwierdzone odpowiedzią realnego konta: `email`, `subject`,
 * `messageId`, `uuid`, `date`, `templateId`, `from`, `tags`.
 */
export interface BrevoTransactionalMessage {
  email?: string;
  messageId?: string;
  uuid?: string;
  date?: string;
  templateId?: number;
  tags?: string[];
  [key: string]: unknown;
}

/**
 * Zapytanie odczytowe do dostawcy.
 *
 * `email` jest OBOWIĄZKOWY, i to nie jest nasz wybór: zmierzone, że
 * `GET /v3/smtp/emails` bez jednego z `email` / `messageId` / `templateId`
 * zwraca `400 missing_parameter`. `messageId` nadaje dostawca, więc w scenariuszu
 * „proces zginął przed odczytem odpowiedzi" go nie mamy — zostają `email`
 * i `templateId`, oba znane PRZED wysyłką.
 */
export interface BrevoTransactionalMessageQuery {
  email: string;
  templateId?: number;
  /**
   * Dolny brzeg okna ważności — patrz `DISPATCH_RESOLUTION_LOOKBACK_MS`.
   *
   * Para dat jest OPCJONALNA i musi być podana w całości albo wcale (Brevo odrzuca
   * `startDate` bez `endDate` komunikatem `End date is mandatory with start date`).
   *
   * Kiedy WOLNO pominąć okno — i dlaczego czasem TRZEBA (zmierzone 2026-08-10):
   * Brevo waliduje `endDate` względem daty **UTC** (`Start/End date should not be greater
   * than current date`), ale daty wiadomości zwraca w strefie **konta**. Dla konta na
   * `+02:00` wiadomość wysłana o 22:22 UTC ma datę konta o dobę późniejszą, a takiego
   * `endDate` API nie przyjmie. Powstaje codzienne, dwugodzinne okno, w którym świeża
   * wiadomość jest NIEOSIĄGALNA żadnym zapytaniem z filtrem dat. Pominięcie pary dat jest
   * jedynym sposobem, żeby ją zobaczyć; filtr `email` + `templateId` pozostaje wymagany
   * przez API, a dopasowanie po tagu jest i tak dokładne.
   */
  startDate?: Date;
  endDate?: Date;
  /**
   * Rozmiar STRONY, nie sufit wyniku (R-4.5-M2). Implementacja stronicuje do
   * wyczerpania okna; jedna strona nie jest dowodem nieobecności wiadomości.
   */
  limit?: number;
}

export interface BrevoSendResponse {
  messageId?: string;
  "message-id"?: string;
  message_id?: string;
  provider_message_id?: string;
  [key: string]: unknown;
}

export interface IBrevoClient {
  sendTransacEmail(
    payload: BrevoTransactionalEmailPayload,
  ): Promise<BrevoSendResponse>;

  /**
   * ODCZYT po stronie dostawcy (Story 4.5). Opcjonalny w kontrakcie, bo do
   * v1.15.0 `IBrevoClient` deklarował WYŁĄCZNIE wysyłkę i istniejące atrapy
   * testowe tej metody nie mają.
   *
   * Brak implementacji NIE degraduje się do „nie znalazłem" — adapter zamienia
   * go na werdykt `unknown`, czyli odmowę wysyłki po przejęciu zajęcia.
   *
   * Rzuca przy awarii odczytu. NIE WOLNO zwracać pustej listy zamiast błędu:
   * „nie udało mi się zapytać" i „zapytałem i nie ma" prowadzą do przeciwnych
   * decyzji o wysłaniu maila.
   */
  findTransactionalMessages?(
    query: BrevoTransactionalMessageQuery,
  ): Promise<BrevoTransactionalMessage[]>;
}
