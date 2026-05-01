/**
 * Full-pipeline idempotency snapshot test
 *
 * Story 7.8 — AC: #1, #2, #6
 *
 * Runs the full sync pipeline 3× sequentially:
 *   syncCategories → syncCollections → upsertSeller (×N) → syncBlog
 *
 * After each run a deep-copy snapshot of the entire in-memory DB is taken.
 * Asserts: deepEqual(snapshot1, snapshot2) and deepEqual(snapshot1, snapshot3).
 *
 * Uses shared in-memory stores for all services — no real DB required.
 */

import { syncCategories, syncCollections } from '../../scripts/gp-config-sync-catalog'
import { upsertSeller } from '../../scripts/gp-config-sync-vendors'
import { syncBlog } from '../../scripts/gp-config-sync-blog'

// ---- Shared in-memory stores ----

let inMemoryCategories: Map<string, any>
let inMemoryCollections: Map<string, any>
let inMemorySellers: Map<string, any>
let inMemoryArticles: Map<string, any>
let entityCounter: number

// ---- Mock factories ----

function makeProductModuleService() {
  return {
    listProductCategories: jest.fn(async ({ handle }: { handle: string }) => {
      const cat = inMemoryCategories.get(handle)
      return cat ? [cat] : []
    }),
    updateProductCategories: jest.fn(async (id: string, payload: any) => {
      for (const [h, cat] of inMemoryCategories.entries()) {
        if (cat.id === id) {
          const updated = { ...cat, ...payload }
          inMemoryCategories.set(h, updated)
          return updated
        }
      }
    }),
    createProductCategories: jest.fn(async (payload: any) => {
      const id = `e${++entityCounter}`
      const cat = { id, ...payload }
      inMemoryCategories.set(payload.handle, cat)
      return cat
    }),
    listProductCollections: jest.fn(async ({ handle }: { handle: string }) => {
      const col = inMemoryCollections.get(handle)
      return col ? [col] : []
    }),
    updateProductCollections: jest.fn(async (id: string, payload: any) => {
      for (const [h, col] of inMemoryCollections.entries()) {
        if (col.id === id) {
          const updated = { ...col, ...payload }
          inMemoryCollections.set(h, updated)
          return updated
        }
      }
    }),
    createProductCollections: jest.fn(async (payload: any) => {
      const id = `e${++entityCounter}`
      const col = { id, ...payload }
      inMemoryCollections.set(payload.handle, col)
      return col
    }),
  }
}

function makeSellerService() {
  return {
    list: jest.fn(async ({ handle }: { handle: string }) => {
      const seller = inMemorySellers.get(handle)
      return seller ? [seller] : []
    }),
    create: jest.fn(async (payload: any) => {
      const id = `e${++entityCounter}`
      const seller = { id, ...payload }
      inMemorySellers.set(payload.handle, seller)
      return seller
    }),
    update: jest.fn(async (id: string, payload: any) => {
      for (const [h, seller] of inMemorySellers.entries()) {
        if (seller.id === id) {
          const updated = { ...seller, ...payload }
          inMemorySellers.set(h, updated)
          return updated
        }
      }
    }),
  }
}

function makeArticleService() {
  return {
    list: jest.fn(async ({ handle }: { handle: string }) => {
      const article = inMemoryArticles.get(handle)
      return article ? [article] : []
    }),
    upsert: jest.fn(async (payload: any) => {
      const id = payload.id ?? `e${++entityCounter}`
      const article = { id, ...payload }
      inMemoryArticles.set(payload.handle, article)
      return article
    }),
  }
}

// ---- Snapshot helper ----

function snapshotStore() {
  const sorted = <T extends { handle?: string }>(arr: T[]): T[] =>
    [...arr].sort((a, b) => (a.handle ?? '').localeCompare(b.handle ?? ''))

  return {
    categories: JSON.parse(
      JSON.stringify(sorted(Array.from(inMemoryCategories.values())))
    ),
    collections: JSON.parse(
      JSON.stringify(sorted(Array.from(inMemoryCollections.values())))
    ),
    sellers: JSON.parse(
      JSON.stringify(sorted(Array.from(inMemorySellers.values())))
    ),
    articles: JSON.parse(
      JSON.stringify(sorted(Array.from(inMemoryArticles.values())))
    ),
  }
}

// ---- Pipeline runner ----

async function runPipeline(
  pms: ReturnType<typeof makeProductModuleService>,
  sellerService: ReturnType<typeof makeSellerService>,
  articleService: ReturnType<typeof makeArticleService>
) {
  const marketId = 'bonbeauty'
  const warnings: string[] = []

  // Stage 1: catalog (categories + collections)
  await syncCategories(pms, PIPELINE_CATEGORIES, marketId, warnings)
  await syncCollections(pms, PIPELINE_COLLECTIONS, marketId, warnings)

  // Stage 2: vendors
  for (const vendor of PIPELINE_VENDORS) {
    await upsertSeller(sellerService, vendor, false, marketId)
  }

  // Stage 3: blog
  await syncBlog(articleService, PIPELINE_BLOG_POSTS, marketId, false, warnings)

  return warnings
}

// ---- Pipeline test fixtures ----

const PIPELINE_CATEGORIES = [
  { category_id: 'masaz', name: 'Masaż', slug: 'masaz', active: true, rank: 1 },
  { category_id: 'pielegnacja', name: 'Pielęgnacja', slug: 'pielegnacja', active: true, rank: 2 },
]

const PIPELINE_COLLECTIONS = [
  { collection_id: 'premium-core', title: 'Premium Core', handle: 'premium-core', active: true },
]

const PIPELINE_VENDORS = [
  {
    vendor_id: 'kremidotyk',
    slug: 'kremidotyk',
    status: 'onboarded',
    display_name: 'KREM i DOTYK',
    email: 'kontakt@kremidotyk.pl',
    description: 'Masaże ciała i zabiegów pielęgnacyjnych',
    photo_url: 'https://cdn.example.com/kremidotyk/photo.jpg',
  },
]

const PIPELINE_BLOG_POSTS = [
  {
    handle: 'masaz-relaksacyjny-poradnik',
    title: 'Masaż relaksacyjny — poradnik',
    content: 'Treść artykułu.',
    status: 'published' as const,
  },
]

// ---- Setup ----

beforeEach(() => {
  inMemoryCategories = new Map()
  inMemoryCollections = new Map()
  inMemorySellers = new Map()
  inMemoryArticles = new Map()
  entityCounter = 0
})

// ---- Tests ----

describe('full sync pipeline — idempotency snapshot test (AC #1, #2, #6)', () => {
  it('snapshot after run1 deep-equals snapshot after run2 and run3 (zero delta)', async () => {
    const pms = makeProductModuleService()
    const sellerService = makeSellerService()
    const articleService = makeArticleService()

    // Run 1: seeds all entities
    await runPipeline(pms, sellerService, articleService)
    const snap1 = snapshotStore()

    // Run 2: should produce identical state
    await runPipeline(pms, sellerService, articleService)
    const snap2 = snapshotStore()

    // Run 3: should still be identical
    await runPipeline(pms, sellerService, articleService)
    const snap3 = snapshotStore()

    expect(snap2).toEqual(snap1)
    expect(snap3).toEqual(snap1)
  })

  it('entity counts stay stable across all 3 runs (no duplicates, AC #2)', async () => {
    const pms = makeProductModuleService()
    const sellerService = makeSellerService()
    const articleService = makeArticleService()

    for (let run = 0; run < 3; run++) {
      await runPipeline(pms, sellerService, articleService)
    }

    expect(inMemoryCategories.size).toBe(PIPELINE_CATEGORIES.length)
    expect(inMemoryCollections.size).toBe(PIPELINE_COLLECTIONS.length)
    expect(inMemorySellers.size).toBe(PIPELINE_VENDORS.length)
    expect(inMemoryArticles.size).toBe(PIPELINE_BLOG_POSTS.length)
  })

  it('categories and collections created exactly once across 3 runs', async () => {
    const pms = makeProductModuleService()
    const sellerService = makeSellerService()
    const articleService = makeArticleService()

    for (let run = 0; run < 3; run++) {
      await runPipeline(pms, sellerService, articleService)
    }

    // Create calls happen only in run 1
    expect(pms.createProductCategories).toHaveBeenCalledTimes(PIPELINE_CATEGORIES.length)
    expect(pms.createProductCollections).toHaveBeenCalledTimes(PIPELINE_COLLECTIONS.length)
    // Seller created once (run 1 only)
    expect(sellerService.create).toHaveBeenCalledTimes(PIPELINE_VENDORS.length)
  })

  it('no warnings generated by any pipeline run (clean config)', async () => {
    const pms = makeProductModuleService()
    const sellerService = makeSellerService()
    const articleService = makeArticleService()

    const warnings1 = await runPipeline(pms, sellerService, articleService)
    const warnings2 = await runPipeline(pms, sellerService, articleService)
    const warnings3 = await runPipeline(pms, sellerService, articleService)

    expect(warnings1).toHaveLength(0)
    expect(warnings2).toHaveLength(0)
    expect(warnings3).toHaveLength(0)
  })
})
