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
};

function hasMarketMetadata(customer: CustomerRecord): boolean {
  return typeof customer.metadata?.gp?.market_id === "string";
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
  const customerService = container.resolve(Modules.CUSTOMER) as {
    retrieveCustomer: (id: string) => Promise<CustomerRecord>;
    updateCustomers: (
      id: string,
      data: { metadata: Record<string, unknown> }
    ) => Promise<unknown>;
  };

  // Prefer ALS context; fall back to scoped email prefix when ALS is
  // unavailable (e.g. async/Redis event bus where ALS does not propagate).
  const alsContext = marketContextStorage.getStore();
  let marketId = alsContext?.market_id;

  try {
    if (!marketId) {
      const customer = await customerService.retrieveCustomer(event.data.id);
      marketId = parseScopedCustomerEmail(customer.email)?.marketId;

      if (!marketId) {
        // Admin-created customer without market scope — skip tagging.
        return;
      }

      if (hasMarketMetadata(customer)) {
        // Metadata already set by create middleware — nothing to do.
        return;
      }

      // Jawny kontekst systemowy dla ZAPISU: jeden wyliczony rynek,
      // ten sam nośnik izolacji co łańcuch `/store/*`.
      await runInSystemMarketContext(
        {
          markets: [marketId],
          origin: { surface: "subscriber", name: "customer-market-tagging" },
          logger: resolveLogger(container) as never,
        },
        async () =>
          customerService.updateCustomers(event.data.id, {
            metadata: mergeCustomerMarketMetadata(customer.metadata, marketId as string),
          }),
      );
      return;
    }

    const customer = await customerService.retrieveCustomer(event.data.id);

    if (hasMarketMetadata(customer)) {
      // Metadata already set by create middleware — skip redundant write.
      return;
    }

    await customerService.updateCustomers(event.data.id, {
      metadata: mergeCustomerMarketMetadata(customer.metadata, marketId),
    });
  } catch (error) {
    // Odmowa kontekstu MUSI zostać głośna. Zdegradowanie jej do `warn` byłoby
    // dokładnie tą ciszą, którą NFR-2 odrzuca — nośnik zaliczyłby odmowę,
    // a wywołujący dowiedziałby się, że „wszystko poszło dobrze".
    if (error instanceof SystemMarketContextError) {
      throw error;
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

export const config: SubscriberConfig = {
  event: "customer.created",
};