/**
 * Idempotency tests for gp-config-sync-catalog.ts
 *
 * Story 7.8 — AC: #1, #2, #3
 *
 * Verifies that syncCategories and syncCollections produce identical DB state
 * across 3 sequential runs on the same fixture config.
 * Uses in-memory mock productModuleService — no real DB required.
 */

import { syncCategories, syncCollections } from '../../scripts/gp-config-sync-catalog'

// ---- In-memory stores (reset before each test) ----

let inMemoryCategories: Map<string, any>
let inMemoryCollections: Map<string, any>
let entityIdCounter: number

// ---- Mock factory ----

function makeProductModuleService() {
  return {
    // Categories
    listProductCategories: jest.fn(async ({ handle }: { handle: string }) => {
      const cat = inMemoryCategories.get(handle)
      return cat ? [cat] : []
    }),
    updateProductCategories: jest.fn(async (id: string, payload: any) => {
      for (const [handle, cat] of inMemoryCategories.entries()) {
        if (cat.id === id) {
          const updated = { ...cat, ...payload }
          inMemoryCategories.set(handle, updated)
          return updated
        }
      }
    }),
    createProductCategories: jest.fn(async (payload: any) => {
      const id = `cat-${++entityIdCounter}`
      const cat = { id, ...payload }
      inMemoryCategories.set(payload.handle, cat)
      return cat
    }),
    // Collections
    listProductCollections: jest.fn(async ({ handle }: { handle: string }) => {
      const col = inMemoryCollections.get(handle)
      return col ? [col] : []
    }),
    updateProductCollections: jest.fn(async (id: string, payload: any) => {
      for (const [handle, col] of inMemoryCollections.entries()) {
        if (col.id === id) {
          const updated = { ...col, ...payload }
          inMemoryCollections.set(handle, updated)
          return updated
        }
      }
    }),
    createProductCollections: jest.fn(async (payload: any) => {
      const id = `col-${++entityIdCounter}`
      const col = { id, ...payload }
      inMemoryCollections.set(payload.handle, col)
      return col
    }),
  }
}

// ---- Snapshot helpers ----

function snapshotCategories() {
  return JSON.parse(
    JSON.stringify(
      Array.from(inMemoryCategories.values()).sort((a, b) =>
        (a.handle ?? '').localeCompare(b.handle ?? '')
      )
    )
  )
}

function snapshotCollections() {
  return JSON.parse(
    JSON.stringify(
      Array.from(inMemoryCollections.values()).sort((a, b) =>
        (a.handle ?? '').localeCompare(b.handle ?? '')
      )
    )
  )
}

// ---- Test fixtures ----

const TEST_CATEGORIES = [
  {
    category_id: 'masaz',
    name: 'Masaż',
    slug: 'masaz',
    active: true,
    rank: 1,
    description: 'Zabiegi masażu i pielęgnacji',
  },
  {
    category_id: 'pielegnacja',
    name: 'Pielęgnacja',
    slug: 'pielegnacja',
    active: true,
    rank: 2,
  },
]

const TEST_COLLECTIONS = [
  {
    collection_id: 'premium-core',
    title: 'Premium Core',
    handle: 'premium-core',
    active: true,
  },
]

// ---- Setup ----

beforeEach(() => {
  inMemoryCategories = new Map()
  inMemoryCollections = new Map()
  entityIdCounter = 0
})

// ---- Tests: syncCategories ----

describe('syncCategories — idempotency (AC #1, #2, #3)', () => {
  it('run1 creates, run2 and run3 produce identical DB state (deep-equal snapshots)', async () => {
    const pms = makeProductModuleService()
    const warnings: string[] = []

    // Run 1: creates categories
    await syncCategories(pms, TEST_CATEGORIES, 'bonbeauty', warnings)
    expect(inMemoryCategories.size).toBe(2)
    const snap1 = snapshotCategories()

    // Run 2: updates — state must be identical
    await syncCategories(pms, TEST_CATEGORIES, 'bonbeauty', warnings)
    const snap2 = snapshotCategories()

    // Run 3: same
    await syncCategories(pms, TEST_CATEGORIES, 'bonbeauty', warnings)
    const snap3 = snapshotCategories()

    expect(snap2).toEqual(snap1)
    expect(snap3).toEqual(snap1)
    expect(warnings).toHaveLength(0)
  })

  it('no duplicate categories across 3 runs (entity count stays stable)', async () => {
    const pms = makeProductModuleService()
    const warnings: string[] = []

    for (let run = 0; run < 3; run++) {
      await syncCategories(pms, TEST_CATEGORIES, 'bonbeauty', warnings)
    }

    expect(inMemoryCategories.size).toBe(TEST_CATEGORIES.length)
    // createProductCategories called exactly once per category (run 1 only)
    expect(pms.createProductCategories).toHaveBeenCalledTimes(TEST_CATEGORIES.length)
    // update called for subsequent runs
    expect(pms.updateProductCategories).toHaveBeenCalledTimes(
      TEST_CATEGORIES.length * 2 // run 2 + run 3
    )
  })

  it('syncCategories payloads are deterministic — same data on every run (AC #3)', async () => {
    const pms = makeProductModuleService()
    const warnings: string[] = []

    // Run 1: create
    await syncCategories(pms, TEST_CATEGORIES, 'bonbeauty', warnings)

    // Run 2: update
    await syncCategories(pms, TEST_CATEGORIES, 'bonbeauty', warnings)
    const run2UpdateCalls = pms.updateProductCategories.mock.calls.map((c: any[]) => c[1])

    // Reset mock call history, run 3
    pms.updateProductCategories.mockClear()
    await syncCategories(pms, TEST_CATEGORIES, 'bonbeauty', warnings)
    const run3UpdateCalls = pms.updateProductCategories.mock.calls.map((c: any[]) => c[1])

    // Update payloads must be identical between run2 and run3
    expect(run3UpdateCalls).toEqual(run2UpdateCalls)
  })
})

// ---- Tests: syncCollections ----

describe('syncCollections — idempotency (AC #1, #2)', () => {
  it('run1 creates, run2 and run3 produce identical DB state', async () => {
    const pms = makeProductModuleService()
    const warnings: string[] = []

    await syncCollections(pms, TEST_COLLECTIONS, 'bonbeauty', warnings)
    const snap1 = snapshotCollections()

    await syncCollections(pms, TEST_COLLECTIONS, 'bonbeauty', warnings)
    const snap2 = snapshotCollections()

    await syncCollections(pms, TEST_COLLECTIONS, 'bonbeauty', warnings)
    const snap3 = snapshotCollections()

    expect(snap2).toEqual(snap1)
    expect(snap3).toEqual(snap1)
    expect(warnings).toHaveLength(0)
  })

  it('no duplicate collections across 3 runs', async () => {
    const pms = makeProductModuleService()
    const warnings: string[] = []

    for (let run = 0; run < 3; run++) {
      await syncCollections(pms, TEST_COLLECTIONS, 'bonbeauty', warnings)
    }

    expect(inMemoryCollections.size).toBe(TEST_COLLECTIONS.length)
    expect(pms.createProductCollections).toHaveBeenCalledTimes(TEST_COLLECTIONS.length)
    expect(pms.updateProductCollections).toHaveBeenCalledTimes(TEST_COLLECTIONS.length * 2)
  })
})
