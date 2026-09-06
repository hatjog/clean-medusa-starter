import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Pochodzenie wykonania systemowego (v1.15.0 Story 2.1 / AD-21).
 *
 * Ustawiane WYŁĄCZNIE przez `runInSystemMarketContext` dla wykonania poza
 * żądaniem HTTP (subscriber / workflow / job). Obecność tego pola odróżnia
 * kontekst systemowy od kontekstu requestu `/store/*` bez tworzenia drugiego
 * kształtu kontekstu — nośnik pozostaje JEDEN.
 */
export interface SystemExecutionOriginTag {
  surface: "subscriber" | "workflow" | "job";
  name: string;
}

export interface MarketContext {
  market_id: string;
  /**
   * Kanoniczna instancja runtime z konfiguracji środowiska/routingu albo
   * tokenu serwisowego. Brak wartości nie może zostać zastąpiony domyślną
   * instancją na granicy RLS.
   */
  instance_id?: string;
  /**
   * Ustawiany przez łańcuch `/store/*` z publishable key. Wykonanie
   * asynchroniczne zwykle go nie ma — `undefined` jest tu uczciwsze niż
   * podstawiony pusty string, który wyglądałby jak realny kanał sprzedaży.
   */
  sales_channel_id?: string;
  system?: SystemExecutionOriginTag;
}

export const marketContextStorage = new AsyncLocalStorage<MarketContext>();

const SAFE_RUNTIME_SCOPE_ID = /^[a-zA-Z0-9_-]+$/

/**
 * Odczytuje instancję wyłącznie z jawnego nośnika runtime. Nie ma domyślki:
 * `gp-dev` byłoby zgadywaniem scopu i mogłoby skleić niezależne instancje.
 */
export function resolveRuntimeInstanceId(raw = process.env.GP_INSTANCE_ID): string | null {
  const instanceId = typeof raw === "string" ? raw.trim() : ""
  return SAFE_RUNTIME_SCOPE_ID.test(instanceId) ? instanceId : null
}
