import type { SubscriberArgs, SubscriberConfig } from "@medusajs/framework";
import {
  ContainerRegistrationKeys,
  Modules,
} from "@medusajs/framework/utils";
import {
  type CustomerMetadata,
  mergeCustomerMarketMetadata,
  parseScopedCustomerEmail,
} from "../lib/customer-scoped-email";
import { marketContextStorage } from "../lib/market-context";
import {
  runInSystemMarketContext,
  SystemMarketContextError,
} from "../lib/system-market-context";

type CustomerRecord = {
  email?: string | null;
  metadata?: CustomerMetadata;
};

type LoggerLike = {
  warn?: (...args: unknown[]) => void;
  error?: (...args: unknown[]) => void;
};

type CustomerService = {
  retrieveCustomer: (id: string) => Promise<CustomerRecord>;
  updateCustomers: (
    id: string,
    data: { metadata: Record<string, unknown> }
  ) => Promise<unknown>;
};

function hasMarketMetadata(customer: CustomerRecord): boolean {
  return typeof customer.metadata?.gp?.market_id === "string";
}

/** Zapis tagowania się nie udał — klient zostałby niewidoczny pod RLS. */
export class CustomerMarketTaggingError extends Error {
  readonly error_code = "GP_CUSTOMER_MARKET_TAGGING_FAILED";

  constructor(message: string, readonly customerId: string) {
    super(message);
    this.name = "CustomerMarketTaggingError";
  }
}

/** MikroORM/Medusa sygnalizują niewidoczny wiersz jako `not_found`. */
function isNotFound(error: unknown): boolean {
  const typed = error as { type?: string; message?: string } | null;
  return (
    typed?.type === "not_found" ||
    /not found|nie znaleziono/i.test(typed?.message ?? "")
  );
}

/**
 * Wykonaj OPERACJĘ USTANAWIAJĄCĄ przynależność do rynku POZA kontekstem rynku.
 *
 * ── Dlaczego poza, skoro cała story wprowadza kontekst ──────────────────────
 * Polityka `market_isolation` na `customer` (infra/postgres/migrations/010,
 * wcześniej 005) ma `USING (metadata->'gp'->>'market_id' = gp_current_market_id())`.
 * Dla wiersza, który market_id JESZCZE nie ma, lewa strona jest `NULL`, więc
 * wiersz jest dla roli `medusa_store` NIEWIDOCZNY, a `UPDATE` trafia w ZERO
 * wierszy — trigger uzupełniający metadane nie ma czego uruchomić, bo `USING`
 * odrzuca wiersz PRZED nim. Zmierzone wykonaniem na realnej tabeli:
 * `GP/backend/scripts/story-2-1-customer-rls-probe.sql` (review-fix HIGH-1).
 *
 * To jest zapis USTANAWIAJĄCY rynek, nie zapis W OBRĘBIE rynku — jedyny,
 * któremu z definicji nie da się nadać kontekstu, który dopiero ustala.
 * Wyjście z kontekstu jest tu JAWNE i wąskie (jedna operacja, jeden wiersz,
 * rynek wyliczony ze scoped-emaila), a nie „no bo tak było wcześniej".
 * Kontrola dodatnia zaraz po nim sprawdza, że wiersz JEST już widoczny
 * w zadeklarowanym rynku — czyli że izolacja zaczęła obowiązywać.
 *
 * ── Dlaczego także ODCZYT ustalający ────────────────────────────────────────
 * Klauzula `USING` obowiązuje również dla `SELECT`, więc nieotagowany wiersz
 * jest niewidoczny nie tylko dla `UPDATE`, ale i dla `retrieveCustomer`.
 * Do weryfikacji B5 (correctness 1.3) pierwszy odczyt w gałęzi z ALS leciał
 * W KONTEKŚCIE: przy propagującym się ALS kończył się `not_found`, wyjątek
 * wpadał w ogólny `catch` i degradował się do `logger.warn`, handler kończył
 * się „sukcesem", a klient zostawał TRWALE nieotagowany. Cisza z HIGH-1 nie
 * została wtedy usunięta, tylko przeniesiona na drugą gałąź — dlatego odczyt
 * ustalający idzie tą samą drogą co zapis ustanawiający.
 */
function runOutsideMarketContext<T>(work: () => Promise<T>): Promise<T> {
  return marketContextStorage.exit(work);
}

function resolveLogger(container: { resolve: (key: string) => unknown }): LoggerLike | undefined {
  try {
    return container.resolve(ContainerRegistrationKeys.LOGGER) as LoggerLike | undefined;
  } catch {
    return undefined;
  }
}

/**
 * v1.15.0 Story 2.1 (AC1, FR-14d / AD-21) — REALNY konsument nośnika kontekstu
 * systemowego.
 *
 * Ten subscriber jest wzorcowym przypadkiem sprzeczności, którą nośnik
 * likwiduje: leci POZA żądaniem HTTP (`customer.created` na szynie zdarzeń,
 * gdzie ALS się nie propaguje), a mimo to ZAPISUJE wiersz klienta. Do tej pory
 * zapis szedł bez jakiegokolwiek kontekstu rynku, czyli bez izolacji.
 *
 * Rynek jest tu WYLICZONY i JAWNY — pochodzi ze scoped-emaila konkretnego
 * klienta, nie z globalnej konfiguracji („wszystkie rynki") i nie z wartości
 * domyślnej. To jest dokładnie kształt deklaracji, którego wymaga AD-21.
 */
export default async function customerMarketTaggingHandler({
  event,
  container,
}: SubscriberArgs<{ id: string }>) {
  const customerService = container.resolve(Modules.CUSTOMER) as CustomerService;

  // Prefer ALS context; fall back to scoped email prefix when ALS is
  // unavailable (e.g. async/Redis event bus where ALS does not propagate).
  const alsContext = marketContextStorage.getStore();
  let marketId = alsContext?.market_id;

  try {
    if (!marketId) {
      const customer = await runOutsideMarketContext(async () =>
        customerService.retrieveCustomer(event.data.id),
      );
      marketId = parseScopedCustomerEmail(customer.email)?.marketId;

      if (!marketId) {
        // Admin-created customer without market scope — skip tagging.
        return;
      }

      if (hasMarketMetadata(customer)) {
        // Metadata already set by create middleware — nothing to do.
        return;
      }

      await tagAndVerify(
        customerService,
        container,
        event.data.id,
        customer.metadata,
        marketId,
      );
      return;
    }

    // Odczyt USTALAJĄCY — poza kontekstem z tego samego powodu, co zapis
    // ustanawiający: `USING` polityki RLS ukrywa nieotagowany wiersz także
    // przed `SELECT`-em (weryfikacja B5, correctness 1.3).
    const customer = await runOutsideMarketContext(async () =>
      customerService.retrieveCustomer(event.data.id),
    );

    if (hasMarketMetadata(customer)) {
      // Metadata already set by create middleware — skip redundant write.
      return;
    }

    await tagAndVerify(
      customerService,
      container,
      event.data.id,
      customer.metadata,
      marketId,
    );
  } catch (error) {
    // Odmowa kontekstu MUSI zostać głośna. Zdegradowanie jej do `warn` byłoby
    // dokładnie tą ciszą, którą NFR-2 odrzuca — nośnik zaliczyłby odmowę,
    // a wywołujący dowiedziałby się, że „wszystko poszło dobrze".
    if (error instanceof SystemMarketContextError) {
      throw error;
    }
    // Nieudane tagowanie NIE jest kosmetyką: bez `metadata.gp.market_id` ten
    // klient jest niewidoczny dla KAŻDEGO zapytania pod RLS. Do review-fixu
    // HIGH-1 lądowało tu `warn` i handler kończył się „sukcesem".
    // Niewidoczny wiersz na ŚCIEŻCE TAGOWANIA jest tą samą klasą co wyżej,
    // niezależnie od tego, które ogniwo go zgłosiło: klient, którego nie widać,
    // nie zostanie otagowany, a bez `metadata.gp.market_id` jest niewidoczny
    // pod RLS dla KAŻDEGO zapytania. Do weryfikacji B5 `not_found` z pierwszego
    // odczytu wpadało niżej, w `warn`, i handler kończył się „sukcesem".
    const escalated =
      error instanceof CustomerMarketTaggingError
        ? error
        : isNotFound(error)
          ? new CustomerMarketTaggingError(
              `klient ${event.data.id} jest NIEWIDOCZNY podczas tagowania ` +
                "(wiersz odrzucony przez politykę RLS albo nie istnieje) — " +
                "tagowanie NIE zostało wykonane",
              event.data.id,
            )
          : null;
    if (escalated) {
      resolveLogger(container)?.error?.(
        "customerMarketTaggingHandler failed to establish market membership",
        {
          error_code: escalated.error_code,
          customer_id: escalated.customerId,
          error: escalated.message,
        },
      );
      throw escalated;
    }
    resolveLogger(container)?.warn?.(
      "customerMarketTaggingHandler failed",
      {
        customer_id: event.data.id,
        error: error instanceof Error ? error.message : String(error),
      }
    );
  }
}

/**
 * Zapis ustanawiający + kontrola dodatnia W KONTEKŚCIE zadeklarowanego rynku.
 *
 * Nośnik kontekstu systemowego jest tu KONSUMOWANY realnie: odczyt weryfikujący
 * leci przez `runInSystemMarketContext`, czyli przez tę samą ALS, ten sam hook
 * RLS i ten sam kształt `app.gp_market_id` co łańcuch `/store/*`. Jeśli wiersz
 * po zapisie nie jest widoczny w swoim rynku, tagowanie się NIE udało — i to
 * jest błąd, nie linia w logu.
 */
async function tagAndVerify(
  customerService: CustomerService,
  container: { resolve: (key: string) => unknown },
  customerId: string,
  metadata: CustomerMetadata | undefined,
  marketId: string,
): Promise<void> {
  const logger = resolveLogger(container);

  await runOutsideMarketContext(async () =>
    customerService.updateCustomers(customerId, {
      metadata: mergeCustomerMarketMetadata(metadata, marketId),
    }),
  );

  try {
    const [verified] = await runInSystemMarketContext(
      {
        markets: [marketId],
        origin: { surface: "subscriber", name: "customer-market-tagging" },
        logger: logger as never,
      },
      async () => customerService.retrieveCustomer(customerId),
    );

    if (!hasMarketMetadata(verified ?? {})) {
      throw new CustomerMarketTaggingError(
        `klient ${customerId} po zapisie nadal nie niesie metadata.gp.market_id`,
        customerId,
      );
    }
  } catch (error) {
    if (error instanceof SystemMarketContextError || error instanceof CustomerMarketTaggingError) {
      throw error;
    }
    if (isNotFound(error)) {
      throw new CustomerMarketTaggingError(
        `klient ${customerId} jest NIEWIDOCZNY w kontekście rynku ${marketId} ` +
          "po zapisie ustanawiającym — zapis nie zadziałał albo polityka RLS " +
          "wymaga innego kształtu metadanych",
        customerId,
      );
    }
    // Kontrola nie mogła się WYKONAĆ (np. instancja bez roli `medusa_store`
    // ani polityk RLS — dev bez migracji infra). To nie jest dowód poprawności
    // ani dowód defektu, więc mówimy o tym wprost zamiast milczeć.
    logger?.warn?.(
      "customerMarketTaggingHandler: kontrola widoczności NIEWYKONANA",
      {
        customer_id: customerId,
        market_id: marketId,
        error: error instanceof Error ? error.message : String(error),
      },
    );
  }
}

export const config: SubscriberConfig = {
  event: "customer.created",
};