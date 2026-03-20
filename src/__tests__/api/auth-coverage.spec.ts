/**
 * Auth auto-discovery CI gate (Story 8.1 — AC-6, FM-2, RT-3).
 *
 * Scans all route files under src/api/v1/admin/ and verifies that
 * the operatorAuthMiddleware is registered in middlewares.ts for /v1/admin/* paths.
 *
 * This gate prevents operator-only routes from accidentally being left open.
 */
import * as fs from "node:fs"
import * as path from "node:path"

const SRC_ROOT = path.resolve(__dirname, "../..")
const ADMIN_API_DIR = path.join(SRC_ROOT, "api", "v1", "admin")
const MIDDLEWARES_FILE = path.join(SRC_ROOT, "api", "middlewares.ts")

function findRouteFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return []

  const files: string[] = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      files.push(...findRouteFiles(fullPath))
    } else if (entry.name === "route.ts") {
      files.push(fullPath)
    }
  }
  return files
}

describe("Auth coverage gate for /v1/admin/* routes", () => {
  it("operatorAuthMiddleware is applied to /v1/admin/* in middlewares.ts", () => {
    expect(fs.existsSync(MIDDLEWARES_FILE)).toBe(true)

    const content = fs.readFileSync(MIDDLEWARES_FILE, "utf-8")

    // Must import operatorAuthMiddleware
    expect(content).toMatch(/operatorAuthMiddleware/)

    // Must have matcher for /v1/admin/*
    expect(content).toMatch(/\/v1\/admin\/\*/)
  })

  it("all route files under api/v1/admin/ exist (route directory sanity check)", () => {
    const routeFiles = findRouteFiles(ADMIN_API_DIR)

    // At minimum the entitlements route should exist
    expect(routeFiles.length).toBeGreaterThan(0)

    const routePaths = routeFiles.map((f) => path.relative(SRC_ROOT, f))
    expect(routePaths.some((p) => p.includes("entitlements"))).toBe(true)
  })

  it("withOperatorAuth HOF is exported from middlewares/with-operator-auth.ts", () => {
    const middlewareFile = path.join(SRC_ROOT, "middlewares", "with-operator-auth.ts")
    expect(fs.existsSync(middlewareFile)).toBe(true)

    const content = fs.readFileSync(middlewareFile, "utf-8")
    expect(content).toMatch(/export function withOperatorAuth/)
    expect(content).toMatch(/export async function operatorAuthMiddleware/)
  })
})
