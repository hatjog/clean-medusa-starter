import type { SubscriberArgs, SubscriberConfig } from "@medusajs/framework";
import { marketContextCache } from "../loaders/market-context-cache";

export default async function marketContextCacheInvalidateHandler(
  _event: SubscriberArgs
) {
  marketContextCache.invalidate();
}

export const config: SubscriberConfig = {
  event: ["sales-channel.created", "sales-channel.updated"],
};
