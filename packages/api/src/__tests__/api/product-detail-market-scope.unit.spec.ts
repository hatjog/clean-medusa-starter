/**
 * v1.15.0 Story 2.4 — ochrona rynkowa na trasie szczegolu produktu (FR-14b, NFR-5, NFR-1, ADR-109).
 *
 * DLACZEGO TEN TEST WYGLADA TAK, A NIE INACZEJ:
 *
 * Galaz detalu w `productListMarketScopeMiddleware` byla napisana, otypowana
 * i wygladala na kompletna — a nie wykonywala sie ANI RAZU, bo middleware nie byl
 * zarejestrowany na trasie serwujacej `body.product`. Test wolajacy
 * `productListMarketScopeMiddleware(req, res, next)` wprost przechodzi ZAROWNO przed,
 * jak i po zmianie — bo sama funkcja zawsze dzialala. Taki test nie odroznia stanu
 * przed od stanu po i powiela dokladnie ten defekt, ktory story naprawia.
 *
 * Dlatego kazdy przypadek ponizej przechodzi przez LANCUCH Z REJESTRACJI:
 * odczytuje eksport `defineMiddlewares` z `../../api/middlewares`, znajduje wpis po
 * matcherze, wykonuje jego middleware'y PO KOLEI, a dopiero potem symuluje rdzen
 * Medusy wolajacy `res.json(...)`.
 */

const mockInstallRlsPoolHook = jest.fn();
const mockEnsureLoaded = jest.fn();
const mockGet = jest.fn();
const mockFilterProductIdsByFilters = jest.fn();
const mockListProductIdsForSalesChannel = jest.fn();
const mockGetFlagState = jest.fn();
const mockAugmentProductsWithVendorMeta = jest.fn();

jest.mock("@medusajs/framework/http", () => ({
  defineMiddlewares: (config: unknown) => config,
  authenticate: () => jest.fn(),
}));

jest.mock("@medusajs/framework/utils", () => ({
  ContainerRegistrationKeys: {
    PG_CONNECTION: "__pg_connection__",
    QUERY: "__query__",
    LOGGER: "logger",
  },
  Modules: { PRODUCT: "product" },
}));

jest.mock("../../lib/rls-pool-hook", () => ({
  installRlsPoolHook: (...args: unknown[]) => mockInstallRlsPoolHook(...args),
}));

jest.mock("../../loaders/market-context-cache", () => ({
  marketContextCache: {
    ensureLoaded: (...args: unknown[]) => mockEnsureLoaded(...args),
    get: (...args: unknown[]) => mockGet(...args),
  },
}));

jest.mock("../../lib/product-market-scope", () => ({
  filterProductIdsByFilters: (...args: unknown[]) => mockFilterProductIdsByFilters(...args),
  listProductIdsForSalesChannel: (...args: unknown[]) =>
    mockListProductIdsForSalesChannel(...args),
}));

jest.mock("../../lib/feature-flag-tri-state", () => ({
  getFlagState: (...args: unknown[]) => mockGetFlagState(...args),
}));

jest.mock("../../lib/multi-vendor-resolver", () => ({
  augmentProductsWithVendorMeta: (...args: unknown[]) =>
    mockAugmentProductsWithVendorMeta(...args),
}));

import middlewaresConfig, {
  CROSS_MARKET_PRODUCT_STATUS,
  productListMarketScopeMiddleware,
} from "../../api/middlewares";
import { vendorMetaMiddleware } from "../../api/store/products/vendor-meta-middleware";
import { marketContextStorage } from "../../lib/market-context";

type RouteEntry = {
  method?: unknown;
  matcher: string;
  middlewares?: unknown[];
};

const OWN_MARKET = "bonbeauty";
const OWN_CHANNEL = "sc_bonbeauty";
const FOREIGN_MARKET = "bonevent";

const LIST_MATCHER = "/store/products";
const DETAIL_MATCHER = "/store/products/:id";

function routes(): RouteEntry[] {
  return (middlewaresConfig as unknown as { routes: RouteEntry[] }).routes;
}

function routeFor(matcher: string): RouteEntry {
  const entry = routes().find((route) => route.matcher === matcher);
  if (!entry) {
    throw new Error(`no route registered for matcher ${matcher}`);
  }
  return entry;
}

function product(marketId: string, overrides: Record<string, unknown> = {}) {
  return {
    id: "prod_target",
    handle: "krem-do-rak",
    metadata: { gp: { market_id: marketId } },
    variants: [{ id: "variant_1", calculated_price: { calculated_amount: 4900 } }],
    ...overrides,
  };
}

type Captured = { status: number; body: unknown };

function makeReq(params: Record<string, unknown>, query: Record<string, unknown>) {
  return {
    params,
    query,
    filterableFields: { ...query },
    url: "/store/products",
    scope: {
      resolve: (key: string) => {
        if (key === "__pg_connection__") return { client: {} };
        if (key === "logger") return { warn: jest.fn(), info: jest.fn() };
        return undefined;
      },
    },
  } as any;
}

function makeRes(captured: Captured) {
  const res: any = {
    status(code: number) {
      captured.status = code;
      return res;
    },
    json(body: unknown) {
      captured.body = body;
      return Promise.resolve();
    },
  };
  return res;
}

/**
 * Wykonuje LANCUCH middleware'ow tak, jak zrobi to Medusa dla danej trasy,
 * a nastepnie symuluje rdzeniowy handler wolajacy `res.json(coreBody)`.
 */
async function runRegisteredChain(
  matcher: string,
  req: any,
  coreBody: unknown
): Promise<Captured> {
  const chain = (routeFor(matcher).middlewares ?? []) as Array<
    (req: any, res: any, next: () => void) => unknown
  >;
  const captured: Captured = { status: 200, body: undefined };
  const res = makeRes(captured);

  for (const middleware of chain) {
    let advanced = false;
    await middleware(req, res, () => {
      advanced = true;
    });
    if (!advanced) {
      // Middleware zakonczyl request (fail-closed) — rdzen nigdy nie wystartuje.
      return captured;
    }
  }

  await res.json(coreBody);
  return captured;
}

function withMarketContext<T>(fn: () => Promise<T>): Promise<T> {
  return marketContextStorage.run(
    { market_id: OWN_MARKET, sales_channel_id: OWN_CHANNEL } as any,
    fn
  );
}

describe("Story 2.4 — ochrona rynkowa na trasie szczegolu produktu", () => {
  beforeEach(() => {
    mockListProductIdsForSalesChannel.mockReset();
    mockListProductIdsForSalesChannel.mockResolvedValue(["prod_target"]);
    mockGetFlagState.mockReset();
    mockGetFlagState.mockResolvedValue("off");
    mockAugmentProductsWithVendorMeta.mockReset();
    mockAugmentProductsWithVendorMeta.mockImplementation(async (products: any[]) => {
      for (const item of products) {
        item.vendor_count = 2;
        item.lowest_price_pln = 49;
        item.vendor_offers = [{ seller_id: "sel_1" }];
      }
    });
  });

  /**
   * AC1 + AC2 — jedna tabela przypadkow wykonywana dla OBU powierzchni.
   * Dwie niezaleznie napisane asercje SA mechanizmem rozjazdu, ktoremu ta story
   * ma zapobiec, wiec parytet dowodzimy parametryzacja, nie kopiowaniem testu.
   */
  const SURFACES = [
    {
      name: "detal (/store/products/:id)",
      matcher: DETAIL_MATCHER,
      req: () => makeReq({ id: "prod_target" }, {}),
      coreBody: (marketId: string) => ({ product: product(marketId) }),
      readProduct: (body: any) => body?.product,
    },
    {
      name: "lista celowana (/store/products?handle=...)",
      matcher: LIST_MATCHER,
      req: () => makeReq({}, { handle: "krem-do-rak" }),
      coreBody: (marketId: string) => ({
        products: [product(marketId)],
        count: 1,
        offset: 0,
        limit: 20,
      }),
      readProduct: (body: any) => body?.products?.[0],
    },
  ];

  describe.each(SURFACES)("parytet powierzchni: $name", (surface) => {
    it("produkt obcego rynku NIE jest zwracany i niesie status ADR-109 (403)", async () => {
      const captured = await withMarketContext(() =>
        runRegisteredChain(surface.matcher, surface.req(), surface.coreBody(FOREIGN_MARKET))
      );

      // Najpierw skutek, potem status: przy MARTWYM mechanizmie to wlasnie ta
      // asercja pokazuje wyciek (produkt obcego rynku w odpowiedzi).
      expect(surface.readProduct(captured.body)).toBeUndefined();
      expect(JSON.stringify(captured.body)).not.toContain(FOREIGN_MARKET);
      expect(captured.status).toBe(403);
    });

    it("kontrola dodatnia: produkt wlasnego rynku wraca 200 z niezerowa cena", async () => {
      const captured = await withMarketContext(() =>
        runRegisteredChain(surface.matcher, surface.req(), surface.coreBody(OWN_MARKET))
      );

      expect(captured.status).toBe(200);
      const returned = surface.readProduct(captured.body);
      expect(returned?.id).toBe("prod_target");
      expect(returned?.variants?.[0]?.calculated_price?.calculated_amount).toBe(4900);
    });
  });

  /**
   * AC3 — kontrola dodatnia dla OBU stanow flagi `multi_vendor_pdp`.
   * Przy "off" `vendorMetaMiddleware` robi `return next()` PRZED podpieciem
   * interceptora. Gdyby ochrona rynkowa wisiala na tym interceptorze, przy "off"
   * zniknelaby bez sladu — ten przypadek to wykrywa.
   */
  describe.each(["on", "off"])("flaga multi_vendor_pdp = %s", (flagState) => {
    beforeEach(() => {
      mockGetFlagState.mockResolvedValue(flagState);
    });

    it("obcy rynek na detalu nadal jest odrzucany", async () => {
      const captured = await withMarketContext(() =>
        runRegisteredChain(DETAIL_MATCHER, makeReq({ id: "prod_target" }, {}), {
          product: product(FOREIGN_MARKET),
        })
      );

      expect((captured.body as any)?.product).toBeUndefined();
      expect(captured.status).toBe(403);
    });

    it("wlasny rynek na detalu wraca 200, z cena i z wzbogaceniem gdy flaga on", async () => {
      const captured = await withMarketContext(() =>
        runRegisteredChain(DETAIL_MATCHER, makeReq({ id: "prod_target" }, {}), {
          product: product(OWN_MARKET),
        })
      );

      expect(captured.status).toBe(200);
      const returned = (captured.body as any)?.product;
      expect(returned?.id).toBe("prod_target");
      expect(returned?.variants?.[0]?.calculated_price?.calculated_amount).toBe(4900);

      if (flagState === "on") {
        expect(returned?.vendor_count).toBe(2);
        expect(returned?.lowest_price_pln).toBe(49);
        expect(returned?.vendor_offers).toEqual([{ seller_id: "sel_1" }]);
      } else {
        expect(returned?.vendor_count).toBeUndefined();
      }
    });
  });

  it("AC2 — status cross-market ma JEDNO zrodlo prawdy i wynosi 403 (ADR-109 :44)", () => {
    expect(CROSS_MARKET_PRODUCT_STATUS).toBe(403);
  });

  it("AC3 — na trasie detalu NIE dochodzi do re-fetcha produktu (regresja calculated_price)", async () => {
    await withMarketContext(() =>
      runRegisteredChain(DETAIL_MATCHER, makeReq({ id: "prod_target" }, {}), {
        product: product(OWN_MARKET),
      })
    );

    // `filterProductIdsByFilters` + `query.graph` to dokladnie ta sciezka, ktora
    // gubila filtry zadania i kontekst cenowy (middlewares.ts — opis regresji).
    expect(mockFilterProductIdsByFilters).not.toHaveBeenCalled();
    // Zawezanie wejsciowe po kanale sprzedazy nalezy do powierzchni listingowej.
    expect(mockListProductIdsForSalesChannel).not.toHaveBeenCalled();
  });

  /**
   * AC4 — BRAMKA ROZJAZDU. Czyta rzeczywisty eksport `defineMiddlewares`
   * i asertuje KOMPLET powierzchni katalogu, a nie "co najmniej jedna".
   * Test-the-test: usuniecie ochrony z ktorejkolwiek trasy czyni ja czerwona.
   */
  describe("AC4 — bramka rozjazdu miedzy powierzchniami katalogu", () => {
    const CATALOG_SURFACES = [LIST_MATCHER, DETAIL_MATCHER];

    it("KAZDA powierzchnia katalogu /store/products* jest objeta ochrona rynkowa", () => {
      const registered = routes()
        .filter((route) => route.matcher.startsWith("/store/products"))
        .map((route) => route.matcher);

      // Komplet, nie podzbior: nowa trasa katalogu bez ochrony zerwie te asercje.
      expect([...registered].sort()).toEqual([...CATALOG_SURFACES].sort());

      const unguarded = CATALOG_SURFACES.filter(
        (matcher) => !(routeFor(matcher).middlewares ?? []).includes(productListMarketScopeMiddleware)
      );
      expect(unguarded).toEqual([]);
    });

    it("kolejnosc middleware'ow jest identyczna na obu powierzchniach (ochrona PRZED vendorMeta)", () => {
      for (const matcher of CATALOG_SURFACES) {
        const chain = (routeFor(matcher).middlewares ?? []) as unknown[];
        const guardAt = chain.indexOf(productListMarketScopeMiddleware);
        const vendorAt = chain.indexOf(vendorMetaMiddleware);

        expect(guardAt).toBeGreaterThanOrEqual(0);
        expect(vendorAt).toBeGreaterThanOrEqual(0);
        expect(guardAt).toBeLessThan(vendorAt);
      }
    });
  });
});
