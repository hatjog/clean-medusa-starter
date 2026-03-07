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

      await customerService.updateCustomers(event.data.id, {
        metadata: mergeCustomerMarketMetadata(customer.metadata, marketId),
      });
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