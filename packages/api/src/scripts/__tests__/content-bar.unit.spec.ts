/**
 * AD-4 — testy kanonicznego modułu progów baru i wordcount.
 *
 * Story 4.2 (FR-22). Te testy bronią inwariantu, dla którego AD-4 w ogóle
 * powstało: JEDNA stała progów i JEDNA metoda liczenia słów. Jeśli ktoś
 * doda drugi literał 80/40 albo drugi wordcount, coś tutaj musi puchnąć.
 */

import {
  CONTENT_BAR_ENTITY_TYPES,
  CONTENT_BAR_THRESHOLDS,
  CONTENT_BAR_THRESHOLD_ASSUMPTIONS,
  UnknownContentTypeError,
  buildContentBarMap,
  countContentWords,
  localeRoutingSlug,
  measureContentBar,
  thresholdForContentType,
} from "../lib/content-bar"

describe("CONTENT_BAR_THRESHOLDS", () => {
  it("trzyma ratyfikowany próg 80 dla produktów", () => {
    expect(CONTENT_BAR_THRESHOLDS.product).toBe(80)
    expect(CONTENT_BAR_THRESHOLD_ASSUMPTIONS.product).toBe(false)
  })

  it("trzyma próg 40 dla kategorii i sellerów, jawnie oznaczony jako [ASSUMPTION]", () => {
    expect(CONTENT_BAR_THRESHOLDS.product_category).toBe(40)
    expect(CONTENT_BAR_THRESHOLDS.seller).toBe(40)
    // Ratyfikacja PO = Story 4.1 (FR-21). Dopóki jej nie ma, konsumenci
    // (raport FR-23) MUSZĄ móc odróżnić hipotezę od decyzji.
    expect(CONTENT_BAR_THRESHOLD_ASSUMPTIONS.product_category).toBe(true)
    expect(CONTENT_BAR_THRESHOLD_ASSUMPTIONS.seller).toBe(true)
  })

  it("ma znacznik [ASSUMPTION] dla każdego znanego typu treści", () => {
    for (const entityType of CONTENT_BAR_ENTITY_TYPES) {
      expect(typeof CONTENT_BAR_THRESHOLD_ASSUMPTIONS[entityType]).toBe("boolean")
    }
  })

  it("jest zamrożona — próba mutacji nie przemyca nowego progu", () => {
    expect(Object.isFrozen(CONTENT_BAR_THRESHOLDS)).toBe(true)
  })
})

describe("thresholdForContentType", () => {
  it("zwraca próg po TYPIE treści, nie po fladze wywołania", () => {
    expect(thresholdForContentType("product")).toBe(80)
    expect(thresholdForContentType("product_category")).toBe(40)
    expect(thresholdForContentType("seller")).toBe(40)
  })

  it("dla nieznanego typu jest fail-loud, NIE cichym defaultem 80", () => {
    expect(() => thresholdForContentType("blog_post")).toThrow(UnknownContentTypeError)
    // Regression guard: gdyby ktoś „naprawił" to fallbackiem, ten assert padnie.
    let fallback: number | null = null
    try {
      fallback = thresholdForContentType("blog_post")
    } catch {
      fallback = null
    }
    expect(fallback).toBeNull()
  })

  it("komunikat błędu wskazuje, gdzie dodać typ", () => {
    expect(() => thresholdForContentType("unknown")).toThrow(/scripts\/lib\/content-bar/)
  })
})

describe("countContentWords", () => {
  it("liczy słowa rozdzielone dowolnym białym znakiem", () => {
    expect(countContentWords("jedno dwa trzy")).toBe(3)
    expect(countContentWords("jedno\ndwa\ttrzy")).toBe(3)
    // YAML block scalar (`>-`) zwija opis w wiele linii z wielokrotnymi spacjami.
    expect(countContentWords("jedno   dwa \n\n trzy")).toBe(3)
  })

  it("traktuje NBSP jako separator", () => {
    expect(countContentWords("jedno\u00a0dwa")).toBe(2)
  })

  it("nie dzieli słowa na myślniku ani interpunkcji", () => {
    expect(countContentWords("anti-aging")).toBe(1)
    expect(countContentWords("usługa, zabieg.")).toBe(2)
  })

  it("dla braku treści zwraca 0 zamiast rzucać", () => {
    expect(countContentWords("")).toBe(0)
    expect(countContentWords("   \n ")).toBe(0)
    expect(countContentWords(null)).toBe(0)
    expect(countContentWords(undefined)).toBe(0)
    expect(countContentWords(42)).toBe(0)
  })
})

describe("measureContentBar", () => {
  const words = (n: number) => Array.from({ length: n }, (_, i) => `w${i}`).join(" ")

  it("zalicza bar dokładnie NA progu (>=, nie >)", () => {
    expect(measureContentBar("product", words(80))).toEqual({ words: 80, bar: true })
    expect(measureContentBar("product", words(79))).toEqual({ words: 79, bar: false })
  })

  it("stosuje próg 40 dla kategorii i sellera", () => {
    expect(measureContentBar("product_category", words(40)).bar).toBe(true)
    expect(measureContentBar("product_category", words(39)).bar).toBe(false)
    expect(measureContentBar("seller", words(40)).bar).toBe(true)
  })

  it("ten sam tekst daje różny werdykt zależnie od typu treści", () => {
    const body = words(50)
    expect(measureContentBar("product", body).bar).toBe(false)
    expect(measureContentBar("product_category", body).bar).toBe(true)
    // ...ale wordcount jest identyczny — jedna metoda liczenia.
    expect(measureContentBar("product", body).words).toBe(
      measureContentBar("product_category", body).words
    )
  })
})

describe("localeRoutingSlug", () => {
  it("mapuje kody BCP 47 na slugi routingu storefrontu", () => {
    expect(localeRoutingSlug("pl-PL")).toBe("pl")
    expect(localeRoutingSlug("en-US")).toBe("en")
    expect(localeRoutingSlug("de-DE")).toBe("de")
  })

  it("mapuje uk-UA na slug 'ua' (kod języka ≠ slug routingu)", () => {
    expect(localeRoutingSlug("uk-UA")).toBe("ua")
    expect(localeRoutingSlug("uk")).toBe("ua")
    expect(localeRoutingSlug("ua")).toBe("ua")
  })

  it("akceptuje separator podkreślenia i whitespace", () => {
    expect(localeRoutingSlug(" de_DE ")).toBe("de")
  })

  it("jest fail-loud dla pustego kodu", () => {
    expect(() => localeRoutingSlug("")).toThrow(/empty locale/)
  })
})

describe("buildContentBarMap", () => {
  const words = (n: number) => Array.from({ length: n }, (_, i) => `w${i}`).join(" ")

  it("buduje mapę wg schematu AD-4 keyed po slugu routingu", () => {
    const map = buildContentBarMap("product", {
      "pl-PL": words(100),
      "de-DE": words(10),
    })
    expect(map).toEqual({
      pl: { words: 100, bar: true },
      de: { words: 10, bar: false },
    })
  })

  it("zapisuje locale bez treści jako jawne zero, nie pomija go", () => {
    const map = buildContentBarMap("product", { "uk-UA": "" })
    expect(map.ua).toEqual({ words: 0, bar: false })
  })

  it("przy kolizji slugów wygrywa dłuższy opis (bez cichego zera)", () => {
    const map = buildContentBarMap("seller", {
      "uk-UA": words(50),
      uk: "",
    })
    expect(map.ua).toEqual({ words: 50, bar: true })
  })

  it("jest fail-loud dla nieznanego typu ZANIM zbuduje częściową mapę", () => {
    expect(() => buildContentBarMap("newsletter", { "pl-PL": words(10) })).toThrow(
      UnknownContentTypeError
    )
  })

  it("dla pustego wejścia zwraca pustą mapę", () => {
    expect(buildContentBarMap("product", {})).toEqual({})
  })
})
