/**
 * v1.16.0 Story 5.4 fix runda 2 (R-10/R-11) — JEDEN nośnik kontekstu rynku dla
 * całego poddrzewa `/vendor/vouchers/*`.
 *
 * Strukturalnie: każdy `route.ts` w poddrzewie woła
 * `runInVendorSellerMarketContext`. Nowa trasa, która go pominie, czerwieni tę
 * suitę — zamiast padać w panelu na `missing_market_context`.
 */
import fs from "node:fs"
import path from "node:path"

const SUBTREE = path.resolve(__dirname, "..", "..", "..", "api", "vendor", "vouchers")

function routeFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...routeFiles(full))
    else if (/^route\.[jt]s$/.test(entry.name)) out.push(full)
  }
  return out.sort()
}

describe("Story 5.4 fix runda 2 — /vendor/vouchers/* ma jeden nośnik rynku", () => {
  const files = routeFiles(SUBTREE)

  it("poddrzewo zawiera co najmniej trasy lookup i redeem (kontrola, że skan cokolwiek widzi)", () => {
    const rel = files.map((f) => path.relative(SUBTREE, f).split(path.sep).join("/"))
    expect(rel).toEqual(expect.arrayContaining(["[code]/lookup/route.ts", "[code]/redeem/route.ts"]))
  })

  it.each(files.map((f) => [path.relative(SUBTREE, f), f]))(
    "%s woła runInVendorSellerMarketContext",
    (_rel, file) => {
      const src = fs.readFileSync(file as string, "utf8")
      expect(src).toMatch(/import\s*\{[^}]*runInVendorSellerMarketContext[^}]*\}\s*from\s*"[^"]*lib\/vendor-seller-market-context"/)
      expect(src).toMatch(/await\s+runInVendorSellerMarketContext\(/)
    },
  )
})
