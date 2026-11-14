/**
 * Story v1.16.0 7.8 — AC1 (backend class preservation) + AC2 (testmarketb
 * read-only, writes fail-closed) for GET /admin/operator/market-config.
 */
import { createHash } from "node:crypto"
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"

const mockResolveAdminMarketContext = jest.fn()
jest.mock("../../../../../lib/admin-market-context", () => ({
  resolveAdminMarketContext: (...args: unknown[]) => mockResolveAdminMarketContext(...args),
}))

import { DELETE, GET, PATCH, POST, PUT, WRITE_SCOPE_HEADER } from "../route"
import { readMarketConfigProjection } from "../../../../../lib/market-config-projection-reader"

const REPO_CONFIG_ROOT = path.resolve(__dirname, "../../../../../../../../../../gp-ops/config")

function sha256(v: Buffer | string): string {
  return createHash("sha256").update(v).digest("hex")
}

function listFiles(dir: string, base = dir): Array<[string, string]> {
  const out: Array<[string, string]> = []
  for (const name of readdirSync(dir)) {
    const abs = path.join(dir, name)
    if (statSync(abs).isDirectory()) out.push(...listFiles(abs, base))
    else out.push([path.relative(base, abs).replace(/\\/g, "/"), sha256(readFileSync(abs))])
  }
  return out.sort(([a], [b]) => a.localeCompare(b))
}

function dirHash(dir: string): string {
  return sha256(JSON.stringify(listFiles(dir)))
}

function writeProvenance(marketDir: string, marketId: string, instanceId: string): void {
  const files = Object.fromEntries(listFiles(marketDir).filter(([rel]) => rel !== ".gp-projection-provenance.json"))
  const digest = sha256(JSON.stringify(files))
  writeFileSync(
    path.join(marketDir, ".gp-projection-provenance.json"),
    JSON.stringify({
      schema_version: 1,
      release: "v1.16.0",
      market_id: marketId,
      instance_id: instanceId,
      stage: "runtime",
      source_digest: digest,
      projection_digest: digest,
      source_files: files,
      projection_files: files,
    })
  )
}

type MockRes = { statusCode: number; body: Record<string, unknown> | undefined; headers: Record<string, string> }

function makeRes(): MockRes & { status: jest.Mock; json: jest.Mock; setHeader: jest.Mock } {
  const res = { statusCode: 200, body: undefined, headers: {} } as MockRes & {
    status: jest.Mock
    json: jest.Mock
    setHeader: jest.Mock
  }
  res.status = jest.fn((code: number) => {
    res.statusCode = code
    return res
  })
  res.json = jest.fn((body: Record<string, unknown>) => {
    res.body = body
    return res
  })
  res.setHeader = jest.fn((k: string, v: string) => {
    res.headers[k] = v
  })
  return res
}

function makeReq(query: Record<string, string>, headers: Record<string, string> = {}) {
  const resolve = jest.fn(() => {
    throw new Error("route must not resolve container services")
  })
  return { req: { query, headers, scope: { resolve } } as never, resolve }
}

function allow(marketId: string | null) {
  mockResolveAdminMarketContext.mockResolvedValue({
    ok: true,
    market_id: marketId,
    actor_id: "user_1",
    actor_type: "user",
    is_super_admin: true,
    source: "intrinsic",
  })
}

const INSTANCE = "gp_test"
let root: string
const prevEnv = { root: process.env.GP_CONFIG_ROOT, instance: process.env.GP_INSTANCE_ID }

function marketDir(id: string): string {
  const dir = path.join(root, INSTANCE, "markets", id)
  mkdirSync(dir, { recursive: true })
  return dir
}

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), "gp-7-8-"))
  process.env.GP_CONFIG_ROOT = root
  process.env.GP_INSTANCE_ID = INSTANCE
  mockResolveAdminMarketContext.mockReset()
  jest.spyOn(console, "warn").mockImplementation(() => undefined)
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
  process.env.GP_CONFIG_ROOT = prevEnv.root
  process.env.GP_INSTANCE_ID = prevEnv.instance
  jest.restoreAllMocks()
})

describe("Story 7.8 AC1 — GET market-config preserves error class", () => {
  it("valid projection with matching provenance -> 200 state ok", async () => {
    const dir = marketDir("alpha")
    writeFileSync(path.join(dir, "market.yaml"), "market_id: alpha\ncurrency: PLN\n")
    writeProvenance(dir, "alpha", INSTANCE)
    allow("alpha")
    const res = makeRes()
    await GET(makeReq({ market_id: "alpha" }).req, res as never)
    expect(res.statusCode).toBe(200)
    expect(res.body).toMatchObject({ state: "ok", empty: false, stale: false, config: { currency: "PLN" } })
  })

  it("missing market directory -> 404 invalid_context (not 200 {})", async () => {
    allow("ghost")
    const res = makeRes()
    await GET(makeReq({ market_id: "ghost" }).req, res as never)
    expect(res.statusCode).toBe(404)
    expect(res.body).toMatchObject({ state: "invalid_context", code: "invalid_context", reason: "market_not_found" })
  })

  it("market_id outside slug alphabet (path traversal) -> 400 invalid_context", async () => {
    allow("../etc")
    const res = makeRes()
    await GET(makeReq({ market_id: "../etc" }).req, res as never)
    expect(res.statusCode).toBe(400)
    expect(res.body).toMatchObject({ state: "invalid_context", reason: "market_id_invalid" })
  })

  it("corrupted YAML -> 500 projection_error (not 200 {})", async () => {
    const dir = marketDir("broken")
    writeFileSync(path.join(dir, "market.yaml"), "market_id: [unclosed\n  : : :\n")
    writeProvenance(dir, "broken", INSTANCE)
    allow("broken")
    const res = makeRes()
    await GET(makeReq({ market_id: "broken" }).req, res as never)
    expect(res.statusCode).toBe(500)
    expect(res.body).toMatchObject({ state: "projection_error", reason: "market_config_invalid_yaml" })
    expect(res.body?.state).not.toBe("empty")
  })

  it("market.yaml missing in existing directory -> 500 projection_error", async () => {
    marketDir("nofile")
    allow("nofile")
    const res = makeRes()
    await GET(makeReq({ market_id: "nofile" }).req, res as never)
    expect(res.statusCode).toBe(500)
    expect(res.body).toMatchObject({ state: "projection_error", reason: "market_config_missing" })
  })

  it("scalar YAML document -> 500 projection_error (not a mapping)", async () => {
    const dir = marketDir("scalar")
    writeFileSync(path.join(dir, "market.yaml"), "just a string\n")
    allow("scalar")
    const res = makeRes()
    await GET(makeReq({ market_id: "scalar" }).req, res as never)
    expect(res.statusCode).toBe(500)
    expect(res.body).toMatchObject({ reason: "market_config_not_a_mapping" })
  })

  it("missing provenance sidecar -> 200 stale with reason provenance_missing", async () => {
    const dir = marketDir("nosidecar")
    writeFileSync(path.join(dir, "market.yaml"), "market_id: nosidecar\n")
    allow("nosidecar")
    const res = makeRes()
    await GET(makeReq({ market_id: "nosidecar" }).req, res as never)
    expect(res.statusCode).toBe(200)
    expect(res.body).toMatchObject({ state: "stale", stale: true, stale_reason: "provenance_missing" })
  })

  it("provenance not matching bytes on disk -> stale projection_digest_mismatch", async () => {
    const dir = marketDir("drift")
    writeFileSync(path.join(dir, "market.yaml"), "market_id: drift\n")
    writeProvenance(dir, "drift", INSTANCE)
    writeFileSync(path.join(dir, "market.yaml"), "market_id: drift\ncurrency: EUR\n")
    allow("drift")
    const res = makeRes()
    await GET(makeReq({ market_id: "drift" }).req, res as never)
    expect(res.body).toMatchObject({ state: "stale", stale_reason: "projection_digest_mismatch" })
  })

  it("provenance for another market -> stale provenance_scope_mismatch", async () => {
    const dir = marketDir("scoped")
    writeFileSync(path.join(dir, "market.yaml"), "market_id: scoped\n")
    writeProvenance(dir, "other", INSTANCE)
    allow("scoped")
    const res = makeRes()
    await GET(makeReq({ market_id: "scoped" }).req, res as never)
    expect(res.body).toMatchObject({ state: "stale", stale_reason: "provenance_scope_mismatch" })
  })

  it("provenance not valid JSON -> stale provenance_invalid", async () => {
    const dir = marketDir("badjson")
    writeFileSync(path.join(dir, "market.yaml"), "market_id: badjson\n")
    writeFileSync(path.join(dir, ".gp-projection-provenance.json"), "{not json")
    allow("badjson")
    const res = makeRes()
    await GET(makeReq({ market_id: "badjson" }).req, res as never)
    expect(res.body).toMatchObject({ state: "stale", stale_reason: "provenance_invalid" })
  })

  it("legally empty market.yaml with valid provenance -> 200 empty: true", async () => {
    const dir = marketDir("blank")
    writeFileSync(path.join(dir, "market.yaml"), "# intentionally empty\n")
    writeProvenance(dir, "blank", INSTANCE)
    allow("blank")
    const res = makeRes()
    await GET(makeReq({ market_id: "blank" }).req, res as never)
    expect(res.statusCode).toBe(200)
    expect(res.body).toMatchObject({ state: "empty", empty: true, stale: false })
  })

  it("no market grant -> 403 forbidden (class kept, no projection read)", async () => {
    mockResolveAdminMarketContext.mockResolvedValue({
      ok: false,
      status: 403,
      code: "MARKET_FORBIDDEN",
      message: "no grant",
      requested_market_id: "alpha",
    })
    const res = makeRes()
    await GET(makeReq({ market_id: "alpha" }).req, res as never)
    expect(res.statusCode).toBe(403)
    expect(res.body).toMatchObject({ state: "forbidden", code: "MARKET_FORBIDDEN" })
  })

  it("header market differs from query market -> 400 invalid_context conflict", async () => {
    allow("bonbeauty")
    const res = makeRes()
    await GET(makeReq({ market_id: "alpha" }, { "x-gp-market-id": "bonbeauty" }).req, res as never)
    expect(res.statusCode).toBe(400)
    expect(res.body).toMatchObject({ state: "invalid_context", reason: "market_id_conflict" })
  })

  it("missing GP_INSTANCE_ID -> 500 projection_error instance_unresolved (no gp-dev guess)", async () => {
    delete process.env.GP_INSTANCE_ID
    allow("alpha")
    const res = makeRes()
    await GET(makeReq({ market_id: "alpha" }).req, res as never)
    expect(res.statusCode).toBe(500)
    expect(res.body).toMatchObject({ reason: "instance_unresolved" })
  })

  it("every non-ok/empty projection outcome is logged (NFR-4: catch with effect)", async () => {
    allow("ghost")
    await GET(makeReq({ market_id: "ghost" }).req, makeRes() as never)
    expect(console.warn).toHaveBeenCalled()
  })
})

describe("Story 7.8 AC2 — testmarketb read-only, writes fail-closed", () => {
  const realTestmarketb = path.join(REPO_CONFIG_ROOT, "gp-dev", "markets", "testmarketb")

  it("real gp-dev testmarketb projection reads as read_only and does not resolve any service", async () => {
    const before = dirHash(realTestmarketb)
    const result = await readMarketConfigProjection("testmarketb", {
      configRoot: REPO_CONFIG_ROOT,
      instanceId: "gp-dev",
      logger: { warn: () => undefined },
    })
    expect(["ok", "stale"]).toContain(result.kind)
    expect(result).toMatchObject({ read_only: true })
    expect(dirHash(realTestmarketb)).toBe(before)
  })

  it("GET testmarketb -> read_only: true, container never resolved (no payment / flag-flip)", async () => {
    const dir = marketDir("testmarketb")
    writeFileSync(path.join(dir, "market.yaml"), "market_id: testmarketb\nstatus: draft\n")
    writeProvenance(dir, "testmarketb", INSTANCE)
    allow("testmarketb")
    const { req, resolve } = makeReq({ market_id: "testmarketb" })
    const res = makeRes()
    await GET(req, res as never)
    expect(res.body).toMatchObject({ state: "ok", read_only: true })
    expect(resolve).not.toHaveBeenCalled()
  })

  it("non-control market -> read_only: false", async () => {
    const dir = marketDir("alpha")
    writeFileSync(path.join(dir, "market.yaml"), "market_id: alpha\n")
    writeProvenance(dir, "alpha", INSTANCE)
    allow("alpha")
    const res = makeRes()
    await GET(makeReq({ market_id: "alpha" }).req, res as never)
    expect(res.body).toMatchObject({ read_only: false })
  })

  it.each([
    ["POST", POST],
    ["PUT", PUT],
    ["PATCH", PATCH],
    ["DELETE", DELETE],
  ])("%s without explicit scope -> 403 scope_required, projection untouched", async (_m, handler) => {
    const dir = marketDir("testmarketb")
    writeFileSync(path.join(dir, "market.yaml"), "market_id: testmarketb\n")
    writeProvenance(dir, "testmarketb", INSTANCE)
    const before = dirHash(root)
    const { req, resolve } = makeReq({ market_id: "testmarketb" })
    const res = makeRes()
    await handler(req, res as never)
    expect(res.statusCode).toBe(403)
    expect(res.body).toMatchObject({ state: "forbidden", code: "scope_required" })
    expect(dirHash(root)).toBe(before)
    expect(resolve).not.toHaveBeenCalled()
    expect(mockResolveAdminMarketContext).not.toHaveBeenCalled()
  })

  it("scoped write to testmarketb -> 403 read_only_market; scoped write elsewhere -> 405", async () => {
    const res1 = makeRes()
    await POST(makeReq({ market_id: "testmarketb" }, { [WRITE_SCOPE_HEADER]: "market:testmarketb" }).req, res1 as never)
    expect(res1.statusCode).toBe(403)
    expect(res1.body).toMatchObject({ code: "read_only_market" })
    const res2 = makeRes()
    await PUT(makeReq({ market_id: "alpha" }, { [WRITE_SCOPE_HEADER]: "market:alpha" }).req, res2 as never)
    expect(res2.statusCode).toBe(405)
    expect(res2.headers.Allow).toBe("GET")
  })
})
