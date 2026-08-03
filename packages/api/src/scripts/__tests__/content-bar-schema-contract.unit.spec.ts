/**
 * Story 1.4 v1.14.0 AC1 — drift-test kształtu po stronie PRODUCENTA.
 *
 * `buildContentBarMap` jest jedynym producentem `metadata.gp.content_bar`
 * (materializacja w `gp-config-sync-i18n-content.ts`, Story 4.2). Kontrakt
 * kształtu żyje w `specs/contracts/config/schemas/content-bar.v1.schema.json`,
 * a konsument (storefront) czyta go w
 * `GP/storefront/src/lib/__tests__/content-bar-schema-parity.test.ts`.
 *
 * Bez tego testu producent i konsument są związani tylko komentarzem — dokładnie
 * ten stan AC1 nazwał brakiem kontraktu as-code. Test celowo waliduje WYJŚCIE
 * funkcji, nie jej sygnaturę: rozjazd typu locale (BCP 47 zamiast sluga) albo
 * dodatkowe pole w pomiarze złamią asercję, nie tylko dokumentację.
 *
 * Skip-if-schema-unavailable: w standalone checkoucie backendu schematu
 * z monorepo nie ma; parity jest wtedy egzekwowane po stronie storefrontu.
 */

import fs from "fs"
import path from "path"

import { buildContentBarMap, localeRoutingSlug } from "../lib/content-bar"

const SCHEMA_PATH = path.resolve(
  __dirname,
  "../../../../../../../specs/contracts/config/schemas/content-bar.v1.schema.json"
)

const schemaAvailable = fs.existsSync(SCHEMA_PATH)
const schema = schemaAvailable ? JSON.parse(fs.readFileSync(SCHEMA_PATH, "utf8")) : null

type Violation = string

/**
 * Minimalny walidator pokrywający dokładnie te słowa kluczowe, których używa
 * `content-bar.v1.schema.json` (type / properties / required /
 * additionalProperties / minimum / $ref do #/$defs). Świadomie bez ajv:
 * backend nie ma tej zależności, a dociąganie jej dla jednego kontraktu
 * kosztowałoby więcej niż 40 linii tutaj.
 */
function validate(value: unknown, node: any, breadcrumb: string, root: any): Violation[] {
  const violations: Violation[] = []

  if (node?.$ref) {
    const refPath = String(node.$ref).replace(/^#\//, "").split("/")
    const resolved = refPath.reduce((acc: any, key) => acc?.[key], root)
    return validate(value, resolved, breadcrumb, root)
  }

  if (node.type === "object") {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return [`${breadcrumb}: expected object, got ${JSON.stringify(value)}`]
    }
    const record = value as Record<string, unknown>

    for (const required of node.required ?? []) {
      if (!(required in record)) {
        violations.push(`${breadcrumb}.${required}: required property missing`)
      }
    }

    const properties = node.properties ?? {}
    if (node.additionalProperties === false) {
      for (const key of Object.keys(record)) {
        if (!(key in properties)) {
          violations.push(`${breadcrumb}.${key}: additional property not allowed`)
        }
      }
    }

    for (const [key, childSchema] of Object.entries(properties)) {
      if (key in record) {
        violations.push(...validate(record[key], childSchema, `${breadcrumb}.${key}`, root))
      }
    }
    return violations
  }

  if (node.type === "integer") {
    if (typeof value !== "number" || !Number.isInteger(value)) {
      violations.push(`${breadcrumb}: expected integer, got ${JSON.stringify(value)}`)
    } else if (typeof node.minimum === "number" && value < node.minimum) {
      violations.push(`${breadcrumb}: ${value} < minimum ${node.minimum}`)
    }
    return violations
  }

  if (node.type === "boolean" && typeof value !== "boolean") {
    violations.push(`${breadcrumb}: expected boolean, got ${JSON.stringify(value)}`)
  }

  return violations
}

const describeIfSchema = schemaAvailable ? describe : describe.skip

describeIfSchema("AC1 — buildContentBarMap waliduje się przeciw content-bar.v1.schema.json", () => {
  it("mapa produktu ze wszystkich locale gp-ops jest zgodna ze schematem", () => {
    const map = buildContentBarMap("product", {
      "pl-PL": Array.from({ length: 187 }, (_, i) => `slowo${i}`).join(" "),
      "en-US": "short english stub",
      "uk-UA": "коротка українська заглушка",
      "de-DE": "kurzer deutscher Stub",
    })

    expect(validate(map, schema, "content_bar", schema)).toEqual([])
  })

  it("klucze wyjścia to slugi routingu, nie kody BCP 47 (uk-UA → ua)", () => {
    const map = buildContentBarMap("product", { "uk-UA": "тест" })

    expect(Object.keys(map)).toEqual(["ua"])
    expect(localeRoutingSlug("uk-UA")).toBe("ua")
    expect(validate(map, schema, "content_bar", schema)).toEqual([])
  })

  it("pusta mapa (encja bez treści) jest legalna — wszystkie klucze opcjonalne", () => {
    expect(validate(buildContentBarMap("product", {}), schema, "content_bar", schema)).toEqual([])
  })

  it("mapa kategorii/sellera używa TEGO SAMEGO kształtu (jeden kontrakt na typ encji)", () => {
    for (const entityType of ["product_category", "seller"]) {
      const map = buildContentBarMap(entityType, { "pl-PL": "opis", "de-DE": "" })
      expect(validate(map, schema, `content_bar[${entityType}]`, schema)).toEqual([])
    }
  })

  it("locale spoza enumu schematu jest WYKRYWANE, nie przemilczane", () => {
    // Gdyby gp-ops dostało kiedyś `fr-FR`, producent wyprodukowałby `fr`,
    // a schemat (additionalProperties: false) MUSI to odrzucić — to jest cała
    // wartość tego drift-testu.
    const map = buildContentBarMap("product", { "fr-FR": "bonjour" })

    expect(Object.keys(map)).toEqual(["fr"])
    expect(validate(map, schema, "content_bar", schema)).toEqual([
      "content_bar.fr: additional property not allowed",
    ])
  })

  it("`words` jest nieujemnym integerem, `bar` booleanem — dla każdego wpisu", () => {
    const map = buildContentBarMap("product", { "pl-PL": "", "en-US": "a b c" })

    for (const measurement of Object.values(map)) {
      expect(Number.isInteger(measurement.words)).toBe(true)
      expect(measurement.words).toBeGreaterThanOrEqual(0)
      expect(typeof measurement.bar).toBe("boolean")
    }
  })
})
