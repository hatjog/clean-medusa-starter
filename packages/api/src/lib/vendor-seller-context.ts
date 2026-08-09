/**
 * vendor-seller-context — tożsamość sprzedawcy dla tras `/vendor/*`
 * uwierzytelnianych TRANSPORTEM PRZEGLĄDARKOWYM (v1.15.0 Story 5.8, AC1/AC2).
 *
 * == Po co to istnieje ==
 * Story 5.4 uczyniła `lib/vendor-auth-matcher.ts` JEDYNYM nośnikiem prawdy o
 * tym, co uwierzytelnia trasę `/vendor/*`: domyślnie bramka HMAC (S2S), a
 * wyjątkiem jest NAZWANY wpis w `VENDOR_HMAC_EXEMPT_ROUTES` z jawnym
 * `transport`. Panel sprzedawcy nie może podpisać żądania S2S — przeglądarka
 * nie ma prawa trzymać materiału podpisującego — więc trasy realizacji stoją
 * na transporcie `mercur-seller-context`.
 *
 * Ten transport NIE JEST wymyślony na potrzeby tej story: Mercur montuje na
 * `/vendor/*` własny łańcuch (`authenticate("member", ["session","bearer"])`
 * + `ensureSellerMiddleware`), który wypełnia `req.seller_context.seller_id`
 * albo odrzuca żądanie ZANIM dotrze ono do handlera. Ta sama droga
 * uwierzytelnia od dawna `/vendor/competitive-insights`.
 *
 * == Dlaczego DOKŁADNIE JEDEN punkt uwierzytelnienia ==
 * Trasa na tym transporcie jest ZWOLNIONA z bramki HMAC. Gdyby przeszła OBOMA
 * ścieżkami, `resolveSellerFromRequest` (Story 5.3) zgłosiłby roszczenie do
 * klucza anty-replay DWA RAZY na jedno żądanie i KAŻDE legalne żądanie
 * kończyłoby się `401 VENDOR_AUTH_REPLAY_DETECTED`. Dlatego handler czyta
 * tożsamość STĄD, a nie z `req.vendorAuth`, i nie wolno go opakować w żaden
 * HOF uwierzytelniający (pilnuje tego `assert_auth_transport.py`,
 * finding `DOUBLE_AUTH_PATH`).
 */
import type { MedusaRequest } from "@medusajs/framework/http"

import { VendorNotMappedError } from "../modules/gp-core/service"

export type RequestWithSellerContext = MedusaRequest & {
  seller_context?: { seller_id?: string }
}

export type VendorSellerIdentity = {
  vendor_id: string
  seller_id: string
}

/** Odmowa rozpoznawalna dla trasy — z gotowym statusem i kodem maszynowym. */
export class VendorSellerContextError extends Error {
  readonly status: number
  readonly code: string

  constructor(status: number, code: string, message: string) {
    super(message)
    this.name = "VendorSellerContextError"
    this.status = status
    this.code = code
  }
}

type GpCoreLike = {
  resolveVendorId: (sellerId: string) => Promise<string>
}

function resolveGpCore(scope: MedusaRequest["scope"]): GpCoreLike | null {
  try {
    const service = scope.resolve("gp_core") as GpCoreLike | undefined
    return service && typeof service.resolveVendorId === "function" ? service : null
  } catch {
    return null
  }
}

/**
 * `seller_id` (odczytany przez trasę z `req.seller_context`) → `{ vendor_id, seller_id }`.
 *
 * == Dlaczego trasa czyta `req.seller_context` U SIEBIE, a nie tutaj ==
 * Bramka `assert_auth_transport.py` klasyfikuje trasę zwolnioną z HMAC jako
 * `mercur-seller-context` tylko wtedy, gdy MODUŁ TRASY dowodzi tego
 * transportu — czyli gdy sam sięga po `req.seller_context`. Gdyby odczyt
 * schował się w tym helperze, klasyfikator widziałby w trasie wyłącznie
 * wywołanie funkcji i musiałby uwierzyć na słowo. Dowód ma być w miejscu,
 * w którym bramka go szuka.
 *
 * Rzuca {@link VendorSellerContextError}:
 *   - `401 UNAUTHORIZED`      — brak kontekstu sprzedawcy. W praktyce łańcuch
 *     Mercura odrzuca takie żądanie wcześniej; ta gałąź jest bezpiecznikiem
 *     fail-closed na wypadek rozmontowania łańcucha, a NIE ozdobnikiem —
 *     bez niej handler czytałby `undefined` jako tożsamość.
 *   - `503 VENDOR_AUTH_SERVICE_UNAVAILABLE` — brak modułu `gp_core`.
 *   - `403 VENDOR_NOT_MAPPED` — sprzedawca bez mapowania na vendora GP (AC1).
 */
export async function resolveVendorForSeller(
  scope: MedusaRequest["scope"],
  sellerId: string | undefined
): Promise<VendorSellerIdentity> {
  if (typeof sellerId !== "string" || sellerId.trim().length === 0) {
    throw new VendorSellerContextError(
      401,
      "UNAUTHORIZED",
      "brak kontekstu sprzedawcy — zaloguj się w panelu ponownie"
    )
  }

  const gpCore = resolveGpCore(scope)
  if (!gpCore) {
    throw new VendorSellerContextError(
      503,
      "VENDOR_AUTH_SERVICE_UNAVAILABLE",
      "usługa rozpoznawania salonu jest chwilowo niedostępna"
    )
  }

  try {
    const vendorId = await gpCore.resolveVendorId(sellerId.trim())
    return { vendor_id: vendorId, seller_id: sellerId.trim() }
  } catch (error) {
    if (error instanceof VendorNotMappedError) {
      throw new VendorSellerContextError(
        403,
        error.code,
        "to konto sprzedawcy nie jest powiązane z żadnym salonem GP — " +
          "skontaktuj się ze wsparciem, żeby dokończyć podłączenie"
      )
    }
    throw error
  }
}
