import { AsyncLocalStorage } from "node:async_hooks";

export interface MarketContext {
  market_id: string;
  sales_channel_id: string;
}

export const marketContextStorage = new AsyncLocalStorage<MarketContext>();
