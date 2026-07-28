/**
 * ADR-165 — "treść vendor-owned wygrywa" — bramki własności vs `--overwrite`.
 *
 * Story 4.6, review-fix cykl 2 (finding 4-6-H1). Decyzja PO (Robert, 2026-07-28):
 * gp-config WYŁĄCZNIE seeduje treść sellera; nigdy nie jest jej właścicielem.
 *
 * Kontrakt egzekwowany przez ten plik:
 *   - Case 1 (seeded, DB == config)      → `--overwrite` MOŻE pisać
 *   - Case 2 (seeded, DB != config)      → vendor edytował → `--overwrite` NIE MOŻE pisać
 *   - Case 3 (nie-seeded, DB puste)      → `--overwrite` MOŻE zasiać
 *   - Case 4 (nie-seeded, DB niepuste)   → vendor-owned → `--overwrite` NIE MOŻE pisać
 *   - pominięcia z Case 2/4 są raportowane JAWNIE (nie po cichu)
 *   - `GP_FORCE_VENDOR_OVERWRITE` to osobny, mocniejszy kanał, który MOŻE
 *     zniszczyć treść vendora — i tylko on.
 *
 * RED-FIRST: przed fixem `if (overwrite) return { shouldWrite: true }` omijało
 * obie bramki, więc testy Case 2/Case 4 z `--overwrite` przechodziły dokładnie
 * odwrotnie (opis vendora był kasowany).
 *
 * Bez realnego DB — in-memory mock sellerService (wzorzec z
 * sync-vendors-ownership.test.ts / gp-config-sync-vendors.idempotency.spec.ts).
 */

import * as fs from 'fs/promises'
import * as os from 'os'
import * as path from 'path'

import gpConfigSyncVendors, { upsertSeller } from '../../scripts/gp-config-sync-vendors'

const CONFIG_DESCRIPTION = 'Opis z gp-config (seed)'
const VENDOR_DESCRIPTION = 'Opis napisany przez sprzedawczynię'

function makeSellerService(existingSellers: any[] = []) {
  return {
    list: jest.fn().mockResolvedValue(existingSellers),
    update: jest.fn().mockImplementation(async (id: string, payload: any) => ({ id, ...payload })),
    create: jest
      .fn()
      .mockImplementation(async (payload: any) => ({ id: 'seller-new-001', ...payload })),
  }
}

function baseVendor(overrides: Record<string, unknown> = {}) {
  return {
    vendor_id: 'studio-nova',
    slug: 'studio-nova',
    status: 'onboarded',
    description: CONFIG_DESCRIPTION,
    ...overrides,
  }
}

/** Istniejący seller z jawnie sterowanym stanem własności pola `description`. */
function existingSellerWith(opts: { seeded: boolean; dbDescription: string | null }) {
  return {
    id: 'seller-studio-nova',
    handle: 'studio-nova',
    name: 'Studio Nova',
    description: opts.dbDescription,
    metadata: {
      gp: {
        market_id: 'bonbeauty',
        seeded_fields: opts.seeded ? ['description'] : [],
        ...(opts.dbDescription !== null ? { description: opts.dbDescription } : {}),
      },
    },
  }
}

function updatedGp(sellerService: ReturnType<typeof makeSellerService>) {
  return sellerService.update.mock.calls[0][1].metadata.gp
}

// ---- Case 1: seeded + DB == config → overwrite może pisać ----

describe('ADR-165 Case 1 — pole seeded i NIEtknięte przez vendora', () => {
  it('--overwrite zapisuje wartość z configu (własność nadal po stronie seeda)', async () => {
    const sellerService = makeSellerService([
      existingSellerWith({ seeded: true, dbDescription: CONFIG_DESCRIPTION }),
    ])

    const result = await upsertSeller(
      sellerService,
      baseVendor({ description: CONFIG_DESCRIPTION }),
      false,
      'bonbeauty',
      'pln',
      true
    )

    expect(result.action).toBe('updated')
    expect(updatedGp(sellerService).description).toBe(CONFIG_DESCRIPTION)
    expect(result.ownershipProtectedFields ?? []).toEqual([])
  })
})

// ---- Case 2: seeded + vendor edytował → overwrite NIE MOŻE pisać ----

describe('ADR-165 Case 2 — pole seeded, ale vendor je edytował', () => {
  it('--overwrite NIE nadpisuje treści vendora', async () => {
    const sellerService = makeSellerService([
      existingSellerWith({ seeded: true, dbDescription: VENDOR_DESCRIPTION }),
    ])

    await upsertSeller(sellerService, baseVendor(), false, 'bonbeauty', 'pln', true)

    expect(updatedGp(sellerService).description).toBe(VENDOR_DESCRIPTION)
    expect(updatedGp(sellerService).description).not.toBe(CONFIG_DESCRIPTION)
  })

  it('raportuje pominięcie JAWNIE w ownershipProtectedFields i w note', async () => {
    const sellerService = makeSellerService([
      existingSellerWith({ seeded: true, dbDescription: VENDOR_DESCRIPTION }),
    ])

    const result = await upsertSeller(
      sellerService,
      baseVendor(),
      false,
      'bonbeauty',
      'pln',
      true
    )

    expect(result.ownershipProtectedFields).toEqual(['description'])
    expect(result.note).toContain('description')
  })

  it('zachowuje description w seeded_fields (znacznik własności nie znika)', async () => {
    const sellerService = makeSellerService([
      existingSellerWith({ seeded: true, dbDescription: VENDOR_DESCRIPTION }),
    ])

    await upsertSeller(sellerService, baseVendor(), false, 'bonbeauty', 'pln', true)

    expect(updatedGp(sellerService).seeded_fields).toContain('description')
  })
})

// ---- Case 3: nie-seeded + DB puste → overwrite może zasiać ----

describe('ADR-165 Case 3 — pole nie-seeded i puste w DB', () => {
  it('--overwrite zasiewa wartość i dopisuje pole do seeded_fields', async () => {
    const sellerService = makeSellerService([
      existingSellerWith({ seeded: false, dbDescription: null }),
    ])

    const result = await upsertSeller(
      sellerService,
      baseVendor(),
      false,
      'bonbeauty',
      'pln',
      true
    )

    expect(updatedGp(sellerService).description).toBe(CONFIG_DESCRIPTION)
    expect(updatedGp(sellerService).seeded_fields).toContain('description')
    expect(result.ownershipProtectedFields ?? []).toEqual([])
  })
})

// ---- Case 4: nie-seeded + DB niepuste → overwrite NIE MOŻE pisać ----

describe('ADR-165 Case 4 — pole vendor-owned od początku (nigdy nie seedowane)', () => {
  it('--overwrite NIE nadpisuje treści vendora', async () => {
    const sellerService = makeSellerService([
      existingSellerWith({ seeded: false, dbDescription: VENDOR_DESCRIPTION }),
    ])

    await upsertSeller(sellerService, baseVendor(), false, 'bonbeauty', 'pln', true)

    expect(updatedGp(sellerService).description).toBe(VENDOR_DESCRIPTION)
  })

  it('raportuje pominięcie i NIE dopisuje pola do seeded_fields', async () => {
    const sellerService = makeSellerService([
      existingSellerWith({ seeded: false, dbDescription: VENDOR_DESCRIPTION }),
    ])

    const result = await upsertSeller(
      sellerService,
      baseVendor(),
      false,
      'bonbeauty',
      'pln',
      true
    )

    expect(result.ownershipProtectedFields).toEqual(['description'])
    expect(updatedGp(sellerService).seeded_fields).not.toContain('description')
  })
})

// ---- Regresja: bez flag zachowanie legacy jest niezmienione ----

describe('ADR-165 — brak flag: zachowanie sprzed fixu bez zmian', () => {
  it('Case 2 bez --overwrite nadal zachowuje treść vendora', async () => {
    const sellerService = makeSellerService([
      existingSellerWith({ seeded: true, dbDescription: VENDOR_DESCRIPTION }),
    ])

    const result = await upsertSeller(sellerService, baseVendor(), false, 'bonbeauty')

    expect(updatedGp(sellerService).description).toBe(VENDOR_DESCRIPTION)
    // bez --overwrite nie ma czego raportować: nikt nie prosił o nadpisanie
    expect(result.ownershipProtectedFields ?? []).toEqual([])
  })

  it('Case 3 bez --overwrite nadal zasiewa puste pole', async () => {
    const sellerService = makeSellerService([
      existingSellerWith({ seeded: false, dbDescription: null }),
    ])

    await upsertSeller(sellerService, baseVendor(), false, 'bonbeauty')

    expect(updatedGp(sellerService).description).toBe(CONFIG_DESCRIPTION)
  })
})

// ---- GP_FORCE_VENDOR_OVERWRITE: osobny, mocniejszy kanał ----

describe('ADR-165 — GP_FORCE_VENDOR_OVERWRITE jako jedyny kanał niszczący', () => {
  it('nadpisuje Case 2 (vendor edytował)', async () => {
    const sellerService = makeSellerService([
      existingSellerWith({ seeded: true, dbDescription: VENDOR_DESCRIPTION }),
    ])

    const result = await upsertSeller(
      sellerService,
      baseVendor(),
      false,
      'bonbeauty',
      'pln',
      true,
      true
    )

    expect(updatedGp(sellerService).description).toBe(CONFIG_DESCRIPTION)
    expect(result.ownershipProtectedFields ?? []).toEqual([])
  })

  it('nadpisuje Case 4 (vendor-owned od początku) i przejmuje pole na seed', async () => {
    const sellerService = makeSellerService([
      existingSellerWith({ seeded: false, dbDescription: VENDOR_DESCRIPTION }),
    ])

    await upsertSeller(sellerService, baseVendor(), false, 'bonbeauty', 'pln', false, true)

    expect(updatedGp(sellerService).description).toBe(CONFIG_DESCRIPTION)
    expect(updatedGp(sellerService).seeded_fields).toContain('description')
  })
})

// ---- Realna ścieżka: entrypoint skryptu, realny YAML, realne parsowanie flag ----

/** Chainable knex-like mock: każde zapytanie kończy się pustym wynikiem. */
function makeDbMock() {
  const builder: any = new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === 'first') return async () => undefined
        if (prop === 'then') return undefined
        return () => builder
      },
    }
  )
  const db: any = () => builder
  return db
}

describe('ADR-165 — realna ścieżka: gpConfigSyncVendors z GP_OVERWRITE=true', () => {
  const envBackup = { ...process.env }
  let tmpRoot: string
  let logSpy: jest.SpyInstance

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'gp-adr165-'))
    const marketDir = path.join(tmpRoot, 'gp-dev', 'markets', 'bonbeauty')
    await fs.mkdir(path.join(marketDir, 'vendors', 'studio-nova'), { recursive: true })
    await fs.writeFile(
      path.join(marketDir, 'market.yaml'),
      [
        'market_id: bonbeauty',
        'currency: PLN',
        'vendors:',
        '  - vendor_id: studio-nova',
        '    slug: studio-nova',
        '    status: onboarded',
        `    description: "${CONFIG_DESCRIPTION}"`,
      ].join('\n'),
      'utf8'
    )
    await fs.writeFile(
      path.join(marketDir, 'vendors', 'studio-nova', 'products.yaml'),
      'products: []\n',
      'utf8'
    )
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined)
  })

  afterEach(async () => {
    logSpy.mockRestore()
    process.env = { ...envBackup }
    process.exitCode = undefined
    await fs.rm(tmpRoot, { recursive: true, force: true })
  })

  function readSummary() {
    const payloads = logSpy.mock.calls
      .map((c) => c[0])
      .filter((line): line is string => typeof line === 'string' && line.trimStart().startsWith('{'))
    return JSON.parse(payloads[payloads.length - 1])
  }

  it('NIE kasuje opisu vendora i zgłasza pominięcie w summary.warnings', async () => {
    process.env.GP_CONFIG_ROOT = tmpRoot
    process.env.GP_OVERWRITE = 'true'
    delete process.env.GP_FORCE_VENDOR_OVERWRITE

    const sellerService = makeSellerService([
      existingSellerWith({ seeded: true, dbDescription: VENDOR_DESCRIPTION }),
    ])
    const container = {
      resolve: (key: string) => {
        if (key === 'seller') return sellerService
        if (key === 'product') return { list: async () => [], listProducts: async () => [] }
        if (key === 'sellerProductLink') return { create: async () => ({}) }
        return makeDbMock()
      },
    }

    await gpConfigSyncVendors({ container, args: ['gp-dev', 'bonbeauty'] } as any)

    expect(updatedGp(sellerService).description).toBe(VENDOR_DESCRIPTION)

    const summary = readSummary()
    const ownershipWarnings = summary.warnings.filter(
      (w: string) => w.includes('studio-nova') && w.includes('description')
    )
    expect(ownershipWarnings).toHaveLength(1)
    expect(ownershipWarnings[0]).toMatch(/GP_FORCE_VENDOR_OVERWRITE/)
  })

  it('GP_FORCE_VENDOR_OVERWRITE=true nadpisuje i ostrzega fail-loud', async () => {
    process.env.GP_CONFIG_ROOT = tmpRoot
    process.env.GP_FORCE_VENDOR_OVERWRITE = 'true'
    delete process.env.GP_OVERWRITE
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined)

    const sellerService = makeSellerService([
      existingSellerWith({ seeded: true, dbDescription: VENDOR_DESCRIPTION }),
    ])
    const container = {
      resolve: (key: string) => {
        if (key === 'seller') return sellerService
        if (key === 'product') return { list: async () => [], listProducts: async () => [] }
        if (key === 'sellerProductLink') return { create: async () => ({}) }
        return makeDbMock()
      },
    }

    await gpConfigSyncVendors({ container, args: ['gp-dev', 'bonbeauty'] } as any)

    expect(updatedGp(sellerService).description).toBe(CONFIG_DESCRIPTION)
    expect(warnSpy.mock.calls.flat().join(' ')).toMatch(/GP_FORCE_VENDOR_OVERWRITE/)
    warnSpy.mockRestore()
  })
})
