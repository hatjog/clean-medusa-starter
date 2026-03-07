import type { SubscriberArgs, SubscriberConfig } from "@medusajs/framework";
import { Modules } from "@medusajs/framework/utils";
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

function hasMarketMetadata(customer: CustomerRecord): boolean {
  return typeof customer.metadata?.gp?.market_id === "string";
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

  if (!marketId) {
    const customer = await customerService.retrieveCustomer(event.data.id);
    marketId = parseScopedCustomerEmail(customer.email)?.marketId ?? null;

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

  await customerService.updateCustomers(event.data.id, {
    metadata: mergeCustomerMarketMetadata(customer.metadata, marketId),
  });
}

export const config: SubscriberConfig = {
  event: "customer.created",
};