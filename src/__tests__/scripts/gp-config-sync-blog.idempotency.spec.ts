/**
 * Idempotency tests for gp-config-sync-blog.ts — syncBlog()
 *
 * Story 7.8 — AC: #1, #5
 *
 * Verifies that syncBlog() called 3× with the same posts config produces
 * identical articleService.upsert() payloads and identical DB state on each run.
 * Uses in-memory mock articleService — no real DB required.
 */

import { syncBlog } from '../../scripts/gp-config-sync-blog'

// ---- In-memory store ----

let inMemoryArticles: Map<string, any>
let articleIdCounter: number

// ---- Mock factory ----

function makeArticleService() {
  return {
    list: jest.fn(async ({ handle }: { handle: string }) => {
      const article = inMemoryArticles.get(handle)
      return article ? [article] : []
    }),
    upsert: jest.fn(async (payload: any) => {
      const id = payload.id ?? `article-${++articleIdCounter}`
      const article = { id, ...payload }
      inMemoryArticles.set(payload.handle, article)
      return article
    }),
  }
}

// ---- Snapshot helper ----

function snapshotArticles() {
  return JSON.parse(
    JSON.stringify(
      Array.from(inMemoryArticles.values()).sort((a, b) =>
        (a.handle ?? '').localeCompare(b.handle ?? '')
      )
    )
  )
}

// ---- Test fixtures ----

const TEST_BLOG_POSTS = [
  {
    handle: 'masaz-relaksacyjny-poradnik',
    title: 'Masaż relaksacyjny — poradnik',
    content: 'Treść artykułu o masażu relaksacyjnym.',
    status: 'published' as const,
    seo: {
      meta_title: 'Masaż relaksacyjny',
      meta_description: 'Dowiedz się więcej o masażu relaksacyjnym.',
    },
  },
  {
    handle: 'pielegnacja-skory-cially',
    title: 'Pielęgnacja skóry ciała',
    content: 'Treść artykułu o pielęgnacji.',
    status: 'draft' as const,
  },
]

// ---- Setup ----

beforeEach(() => {
  inMemoryArticles = new Map()
  articleIdCounter = 0
})

// ---- Tests ----

describe('syncBlog — idempotency: 3× runs produce identical DB state (AC #1, #5)', () => {
  it('snapshots after run1, run2, run3 are deep-equal (no drift)', async () => {
    const articleService = makeArticleService()
    const warnings: string[] = []

    // Run 1: creates articles
    await syncBlog(articleService, TEST_BLOG_POSTS, 'bonbeauty', false, warnings)
    expect(inMemoryArticles.size).toBe(2)
    const snap1 = snapshotArticles()

    // Run 2: updates articles — state must be identical
    await syncBlog(articleService, TEST_BLOG_POSTS, 'bonbeauty', false, warnings)
    const snap2 = snapshotArticles()

    // Run 3: same
    await syncBlog(articleService, TEST_BLOG_POSTS, 'bonbeauty', false, warnings)
    const snap3 = snapshotArticles()

    expect(snap2).toEqual(snap1)
    expect(snap3).toEqual(snap1)
    expect(warnings).toHaveLength(0)
  })

  it('articleService.upsert() payloads are identical on run2 vs run3 (deterministic, AC #5)', async () => {
    const articleService = makeArticleService()
    const warnings: string[] = []

    // Run 1: creates
    await syncBlog(articleService, TEST_BLOG_POSTS, 'bonbeauty', false, warnings)

    // Clear call history, run 2
    articleService.upsert.mockClear()
    await syncBlog(articleService, TEST_BLOG_POSTS, 'bonbeauty', false, warnings)
    const run2Payloads = articleService.upsert.mock.calls.map((c: any[]) => c[0])

    // Clear call history, run 3
    articleService.upsert.mockClear()
    await syncBlog(articleService, TEST_BLOG_POSTS, 'bonbeauty', false, warnings)
    const run3Payloads = articleService.upsert.mock.calls.map((c: any[]) => c[0])

    // Payloads must be identical
    expect(run3Payloads).toEqual(run2Payloads)
  })

  it('no duplicate articles across 3 runs (count stays stable)', async () => {
    const articleService = makeArticleService()
    const warnings: string[] = []

    for (let run = 0; run < 3; run++) {
      await syncBlog(articleService, TEST_BLOG_POSTS, 'bonbeauty', false, warnings)
    }

    expect(inMemoryArticles.size).toBe(TEST_BLOG_POSTS.length)
    // Total upsert calls = posts × runs (upsert is always called — idempotent by design)
    expect(articleService.upsert).toHaveBeenCalledTimes(TEST_BLOG_POSTS.length * 3)
  })

  it('upsert payloads include market_id in gp metadata on every run', async () => {
    const articleService = makeArticleService()
    const warnings: string[] = []

    for (let run = 0; run < 3; run++) {
      articleService.upsert.mockClear()
      await syncBlog(articleService, TEST_BLOG_POSTS, 'bonbeauty', false, warnings)
      for (const call of articleService.upsert.mock.calls) {
        const payload = call[0]
        expect(payload.metadata?.gp?.market_id).toBe('bonbeauty')
        expect(payload.metadata?.gp?.synced_by).toBe('gp-config-sync-blog')
      }
    }
  })
})
