/**
 * Story 4.2 / T6 — smoke pomiaru baru na REALNYM `gp-ops/markets/bonbeauty`.
 *
 * Sens tego testu jest inny niż unitów: unity dowodzą, że matematyka progu
 * jest poprawna, a ten dowodzi, że pomiar **przechodzi po prawdziwych
 * plikach źródłowych** — z ich block scalarami, cyrylicą, umlautami i
 * nieregularnym formatowaniem — i że **niczego w nich nie rusza**.
 *
 * Pomiar jest z definicji odczytowy (żadnego `writeFile` w ścieżce), więc
 * test dodatkowo pilnuje mtime plików: gdyby ktoś kiedyś dołożył zapis „przy
 * okazji", ten assert padnie.
 */

import fs from "node:fs"
import path from "node:path"

import { measureMarketContentBar } from "../gp-config-content-bar"
import { CONTENT_BAR_THRESHOLDS } from "../lib/content-bar"

function resolveProjectRoot(start: string): string {
  let current = path.resolve(start)
  while (true) {
    if (
      fs.existsSync(path.join(current, "gp-ops")) &&
      fs.existsSync(path.join(current, "GP"))
    ) {
      return current
    }
    const parent = path.dirname(current)
    if (parent === current) return ""
    current = parent
  }
}

const projectRoot = resolveProjectRoot(process.cwd())
const i18nRoot = projectRoot ? path.join(projectRoot, "gp-ops", "markets") : ""
const bonbeautyI18n = i18nRoot ? path.join(i18nRoot, "bonbeauty", "i18n") : ""

// Samodzielny checkout submodulu nie ma `gp-ops/` — wtedy smoke nie ma na
// czym działać i jest pomijany zamiast fałszywie failować (ta sama
// konwencja co monorepo-coupling opisane w jest.config.js).
const maybeDescribe =
  bonbeautyI18n && fs.existsSync(bonbeautyI18n) ? describe : describe.skip

maybeDescribe("smoke: pomiar baru na gp-ops/markets/bonbeauty", () => {
  const files = ["products.yaml", "categories.yaml", "sellers.yaml"]

  it("mierzy realny rynek bez mutowania źródeł", () => {
    const before = files.map((file) => ({
      file,
      stat: fs.statSync(path.join(bonbeautyI18n, file)),
    }))

    const report = measureMarketContentBar({
      configRoot: path.join(projectRoot, "gp-ops", "config"),
      i18nRoot,
      instanceId: "gp-dev",
      marketId: "bonbeauty",
    })

    expect(report.ok).toBe(true)
    expect(report.market).toBe("bonbeauty")
    expect(report.thresholds).toEqual(CONTENT_BAR_THRESHOLDS)

    // Realny rynek ma treści we wszystkich trzech typach.
    expect(report.entities.product.length).toBeGreaterThan(0)
    expect(report.entities.product_category.length).toBeGreaterThan(0)
    expect(report.entities.seller.length).toBeGreaterThan(0)

    // Żaden plik źródłowy nie został tknięty.
    for (const snapshot of before) {
      const after = fs.statSync(path.join(bonbeautyI18n, snapshot.file))
      expect(after.mtimeMs).toBe(snapshot.stat.mtimeMs)
      expect(after.size).toBe(snapshot.stat.size)
    }
  })

  it("produkuje kształt content_bar zgodny z AD-4 dla każdej encji", () => {
    const report = measureMarketContentBar({
      configRoot: path.join(projectRoot, "gp-ops", "config"),
      i18nRoot,
      instanceId: "gp-dev",
      marketId: "bonbeauty",
    })

    for (const measurements of Object.values(report.entities)) {
      for (const entity of measurements) {
        expect(typeof entity.handle).toBe("string")
        for (const [slug, measurement] of Object.entries(entity.content_bar)) {
          // Klucz = slug routingu (`pl`/`en`/`ua`/`de`), NIE kod BCP 47.
          expect(slug).toMatch(/^[a-z]{2}$/)
          expect(Number.isInteger(measurement.words)).toBe(true)
          expect(typeof measurement.bar).toBe("boolean")
        }
      }
    }
  })

  it("kategorie nie niosą PL w i18n (AD-12), ale mają PL w source coverage", () => {
    const report = measureMarketContentBar({
      configRoot: path.join(projectRoot, "gp-ops", "config"),
      i18nRoot,
      instanceId: "gp-dev",
      marketId: "bonbeauty",
    })

    // Gdyby `categories.yaml` niósł `pl-PL`, `measureMarketContentBar`
    // rzuciłby — samo dojście tutaj jest asercją AD-12. PL kategorii
    // pochodzi z gp-config products.yaml i ma swój wpis w mapie.
    for (const category of report.entities.product_category) {
      expect(Object.keys(category.content_bar)).toContain("pl")
    }
  })
})
