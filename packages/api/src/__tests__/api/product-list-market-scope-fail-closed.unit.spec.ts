/**
 * Story 2.3 (FR-14a, NFR-1, NFR-2, NFR-5, AD-19) —
 * `productListMarketScopeMiddleware` odmawia przy kontekscie niepelnym.
 *
 * Middleware ma DWIE niezalezne bramy permisywne i kazda z osobna wystarczy,
 * zeby odpowiedz wyszla niezawezona:
 *
 *   - brama WEJSCIOWA  — scoping po `sales_channel_id` byl wykonywany tylko
 *     `if (context?.sales_channel_id)`, wiec kontekst bez kanalu POMIJAL
 *     zawezenie `request.query.id` i core Medusy paginowal po pelnym zbiorze;
 *   - brama WYJSCIOWA  — nadpisany `res.json` zaczynal sie od
 *     `if (!context?.market_id || !context.sales_channel_id) return originalJson(body)`,
 *     wiec ten sam brak kontekstu wylaczal rowniez filtr po `gp.market_id`.
 *
 * Kazda brama ma tu OSOBNY test odmowy. Jedna asercja na "koncowy wynik" nie
 * odroznia, ktora brama zadzialala — naprawa jednej przy pozostawieniu drugiej
 * przeszlaby niezauwazona.
 *
 * Rozstrzygniecie AC2 (kod odmowy): `401` z `failWithMarketContext` ZOSTAJE dla
 * brakujacego/niewaznego klucza publishable (kontrakt Story 4.4 F7 nienaruszony).
 * Tu zapada `403`, bo kontekst JEST — jest tylko niepelny/nierozstrzygalny,
 * wiec wolajacy jest uwierzytelniony, ale scoping nie moze zostac zastosowany
 * (RFC 7235: 401 = brak uwierzytelnienia, 403 = uwierzytelniony, nieuprawniony).
 */

const mockInstallRlsPoolHook = jest.fn();
const mockEnsureLoaded = jest.fn();
const mockGet = jest.fn();
const mockFilterProductIdsByFilters = jest.fn();
const mockListProductIdsForSalesChannel = jest.fn();

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
  filterProductIdsByFilters: (...args: unknown[]) =>
    mockFilterProductIdsByFilters(...args),
  listProductIdsForSalesChannel: (...args: unknown[]) =>
    mockListProductIdsForSalesChannel(...args),
}));

import { readFileSync } from "fs";
import { join } from "path";

import {
  MARKET_SCOPE_DENIED_COHORT,
  MARKET_SCOPE_UNRESOLVABLE_MESSAGE,
  productListMarketScopeMiddleware,
} from "../../api/middlewares";
import { marketContextStorage } from "../../lib/market-context";
import {
  _resetForTest,
  computeRangeStats,
} from "../../lib/request-log-aggregator";

type FakeRes = {
  statusCode: number;
  body: unknown;
  status(code: number): FakeRes;
  json(data: unknown): unknown;
};

function makeRes(): FakeRes {
  return {
    statusCode: 0,
    body: null,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(data: unknown) {
      this.body = data;
      return data;
    },
  };
}

function makeReq(logger: { warn: jest.Mock }, query: Record<string, unknown> = {}) {
  return {
    path: "/store/products",
    method: "GET",
    query,
    scope: {
      resolve: jest.fn((key: string) => {
        if (key === "__pg_connection__") return "db";
        if (key === "logger") return logger;
        return undefined;
      }),
    },
  } as any;
}

/** Kontekst czesciowy dokladnie tego ksztaltu, ktory produkuje
 *  `system-market-context.ts:238` (opcjonalny `sales_channel_id`). */
const PARTIAL_CONTEXT = {
  market_id: "bonbeauty",
  sales_channel_id: undefined,
} as any;

const FULL_CONTEXT = { market_id: "bonbeauty", sales_channel_id: "sc_bb" };

describe("Story 2.3 — productListMarketScopeMiddleware fail-closed", () => {
  let logger: { warn: jest.Mock };

  beforeEach(() => {
    mockInstallRlsPoolHook.mockReset();
    mockEnsureLoaded.mockReset();
    mockEnsureLoaded.mockResolvedValue(undefined);
    mockGet.mockReset();
    mockFilterProductIdsByFilters.mockReset();
    mockListProductIdsForSalesChannel.mockReset();
    mockListProductIdsForSalesChannel.mockResolvedValue(["prod_bb"]);
    logger = { warn: jest.fn() };
    _resetForTest();
  });

  /**
   * AC3 — BRAMA WEJSCIOWA (`:651`).
   * Na obecnej implementacji ten test jest CZERWONY: middleware wola `next()`
   * z pominietym scopingiem zamiast odmowic.
   */
  it("AC3/brama-wejsciowa: kontekst bez sales_channel_id ⇒ ODMOWA, nie pominiety scoping", async () => {
    const req = makeReq(logger);
    const res = makeRes();
    const next = jest.fn();

    await marketContextStorage.run(PARTIAL_CONTEXT, async () => {
      await productListMarketScopeMiddleware(req, res as any, next);
    });

    // Odmowa, a nie przejscie dalej z pominietym zawezeniem.
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
    // Scoping nie mogl zostac zastosowany — wiec nie wolno bylo go pominac.
    expect(mockListProductIdsForSalesChannel).not.toHaveBeenCalled();
    expect(req.query.id).toBeUndefined();
  });

  /**
   * AC3 — BRAMA WYJSCIOWA (`:681-689`).
   * Brama badana NIEZALEZNIE od wejsciowej: middleware wpuszczamy z kontekstem
   * PELNYM (instaluje nadpisany `res.json` i wola `next()`), a samo `res.json`
   * wolamy juz z kontekstem CZESCIOWYM — czyli tak, jak wyglada utrata/niepelnosc
   * kontekstu w chwili serializacji odpowiedzi.
   *
   * Na obecnej implementacji CZERWONY: `originalJson(body)` przepuszcza produkt
   * obcego rynku bez filtrowania.
   */
  it("AC3/brama-wyjsciowa: kontekst czesciowy przy res.json ⇒ ciało NIE przepuszczone", async () => {
    const req = makeReq(logger);
    const res = makeRes();
    const next = jest.fn();

    await marketContextStorage.run(FULL_CONTEXT, async () => {
      await productListMarketScopeMiddleware(req, res as any, next);
    });
    expect(next).toHaveBeenCalled();

    const leakyBody = {
      products: [
        { id: "prod_evt", metadata: { gp: { market_id: "bonevent" } } },
      ],
      count: 1,
    };

    await marketContextStorage.run(PARTIAL_CONTEXT, async () => {
      await (res as any).json(leakyBody);
    });

    expect(res.statusCode).toBe(403);
    expect(res.body).not.toEqual(leakyBody);
    expect(JSON.stringify(res.body)).not.toContain("prod_evt");
  });

  /**
   * Regresja zmierzona przy implementacji tej story: odmowa bramy WYJŚCIOWEJ
   * wołana przez `res.json` (już nadpisany przez ten sam middleware) wpada
   * w nieskończoną rekurencję. `RangeError` ginie wtedy jako unhandled
   * rejection, a asercje na `res.statusCode` NADAL świecą na zielono — czyli
   * dokładnie „zielony test na zepsutym kodzie”.
   *
   * Ten test liczy wejścia w `json` i pęka na rekurencji, zamiast ją połknąć.
   */
  it("AC3/brama-wyjsciowa: odmowa NIE rekurencyjnie przez nadpisany res.json", async () => {
    const req = makeReq(logger);
    let jsonCalls = 0;
    const res = makeRes();
    const originalJson = res.json.bind(res);
    res.json = (data: unknown) => {
      jsonCalls += 1;
      if (jsonCalls > 10) {
        throw new Error(
          "rekurencja: odmowa bramy wyjsciowej wola nadpisany res.json"
        );
      }
      return originalJson(data);
    };

    await marketContextStorage.run(FULL_CONTEXT, async () => {
      await productListMarketScopeMiddleware(req, res as any, jest.fn());
    });

    await marketContextStorage.run(PARTIAL_CONTEXT, async () => {
      await (res as any).json({ products: [], count: 0 });
    });

    // Dokładnie jedno wyjście: odmowa, bez ponownego wejścia w opakowanie.
    expect(jsonCalls).toBe(1);
    expect(res.statusCode).toBe(403);
  });

  /**
   * AC5 kontrola DODATNIA na poziomie jednostki — ten test jest ZIELONY na
   * obecnej implementacji i zaciśniecie NIE MOZE go zlamac. Ryzykiem tej story
   * jest wygaszenie katalogu, nie brak zabezpieczenia.
   */
  it("AC5/dodatnia: pelny kontekst ⇒ listing dziala i jest zawezony do rynku", async () => {
    const req = makeReq(logger);
    const res = makeRes();
    const next = jest.fn();

    await marketContextStorage.run(FULL_CONTEXT, async () => {
      await productListMarketScopeMiddleware(req, res as any, next);
      await (res as any).json({
        products: [
          { id: "prod_bb", metadata: { gp: { market_id: "bonbeauty" } } },
          { id: "prod_evt", metadata: { gp: { market_id: "bonevent" } } },
        ],
        count: 115,
      });
    });

    expect(next).toHaveBeenCalled();
    expect(res.statusCode).not.toBe(403);
    expect(mockListProductIdsForSalesChannel).toHaveBeenCalledWith("db", "sc_bb");
    expect(req.query.id).toEqual(["prod_bb"]);

    const payload = res.body as { products: Array<{ id: string }>; count: number };
    expect(payload.products.map((p) => p.id)).toEqual(["prod_bb"]);
    // NFR-5 kontrola krzyzowa: produkt rynku B nie wychodzi pod kluczem rynku A.
    expect(payload.products.map((p) => p.id)).not.toContain("prod_evt");
    expect(payload.count).toBe(114);
  });

  /**
   * AC4 — odmowa GLOSNA. Dowod z ODCZYTU kazdego z trzech artefaktow:
   * linia logu, wartosc licznika po przebiegu, cialo + kod odpowiedzi.
   */
  it("AC4: odmowa emituje log z powodem domenowym, metryke i rozroznialny komunikat", async () => {
    const req = makeReq(logger);
    const res = makeRes();
    const before = Date.now() - 1;

    await marketContextStorage.run(PARTIAL_CONTEXT, async () => {
      await productListMarketScopeMiddleware(req, res as any, jest.fn());
    });

    // (1) LOG — powod w kategoriach domeny, nie gole "forbidden".
    expect(logger.warn).toHaveBeenCalledTimes(1);
    const [message, details] = logger.warn.mock.calls[0];
    expect(message).toContain("market-scope-denied");
    expect(details).toEqual(
      expect.objectContaining({
        reason: "sales_channel_id_missing",
        market_id: "bonbeauty",
        path: "/store/products",
        gate: "request",
      })
    );

    // (2) METRYKA — wartosc licznika ODCZYTANA po przebiegu.
    const stats = computeRangeStats(
      before,
      Date.now() + 1,
      MARKET_SCOPE_DENIED_COHORT
    );
    expect(stats.sample_size).toBe(1);

    // (3) KOD + komunikat rozroznialny od "Market context required" (`:315`).
    expect(res.statusCode).toBe(403);
    expect(res.body).toEqual(
      expect.objectContaining({
        message: MARKET_SCOPE_UNRESOLVABLE_MESSAGE,
        reason: "sales_channel_id_missing",
      })
    );
    expect((res.body as { message: string }).message).not.toBe(
      "Market context required"
    );
  });

  it("AC4: brak market_id i brak sales_channel_id maja ROZNE powody domenowe", async () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ market_id: "bonbeauty", sales_channel_id: undefined }, "sales_channel_id_missing"],
      [{ market_id: undefined, sales_channel_id: "sc_bb" }, "market_id_missing"],
    ];

    for (const [context, expectedReason] of cases) {
      logger.warn.mockReset();
      const req = makeReq(logger);
      const res = makeRes();

      await marketContextStorage.run(context as any, async () => {
        await productListMarketScopeMiddleware(req, res as any, jest.fn());
      });

      expect(res.statusCode).toBe(403);
      expect((res.body as { reason: string }).reason).toBe(expectedReason);
      expect(logger.warn.mock.calls[0][1]).toEqual(
        expect.objectContaining({ reason: expectedReason })
      );
    }
  });

  it("AC3: calkowity brak kontekstu ALS to rowniez odmowa, nie pominiety scoping", async () => {
    const req = makeReq(logger);
    const res = makeRes();
    const next = jest.fn();

    await productListMarketScopeMiddleware(req, res as any, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
    expect((res.body as { reason: string }).reason).toBe("context_missing");
  });

  /**
   * AC6 — bramka anty-nawrotowa. Skan po ZRODLE, ale dopiero PO WYCIECIU
   * komentarzy: regex slepy na komentarze czerwieni sie na wlasnym opisie
   * permisywnego ksztaltu (ten plik i naglowek middleware zawieraja go w tresci).
   *
   * Kontrola zachowania (testy powyzej) jest tu pierwotna; ten skan lapie
   * przywrocenie ksztaltu w wariancie, ktory testy zachowania moglyby ominac.
   */
  it("AC6: permisywny ksztalt nie wraca do productListMarketScopeMiddleware", () => {
    const source = readFileSync(
      join(__dirname, "../../api/middlewares.ts"),
      "utf8"
    );

    const withoutComments = source
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/.*$/gm, "$1");

    const start = withoutComments.indexOf(
      "export async function productListMarketScopeMiddleware"
    );
    expect(start).toBeGreaterThan(-1);
    const end = withoutComments.indexOf("\nexport default defineMiddlewares", start);
    expect(end).toBeGreaterThan(start);
    const body = withoutComments.slice(start, end);

    // Powrot bramy wejsciowej: scoping warunkowany obecnoscia kontekstu.
    expect(body).not.toMatch(/if\s*\(\s*context\?\.\s*sales_channel_id\s*\)/);
    // Powrot bramy wyjsciowej: brak kontekstu przepuszczajacy cialo dalej.
    expect(body).not.toMatch(
      /!context\?\.\s*market_id[\s\S]{0,120}?return\s+originalJson/
    );
  });
});
