import {
  buildReviewSyncPlan,
  buildStableReviewId,
  DesiredReview,
  ExistingSeedReview,
  parseReviewSyncArgs,
} from "../../scripts/gp-config-sync-reviews"

function desired(overrides: Partial<DesiredReview> = {}): DesiredReview {
  return {
    id: buildStableReviewId("seeded from gp-ops", "city-beauty", 0),
    vendorId: "city-beauty",
    index: 0,
    reference: "seller",
    targetId: "seller-city-beauty",
    rating: 5,
    customer_note: "Dobra wizyta",
    seller_note: null,
    locale: "pl",
    provenanceTag: "seeded from gp-ops",
    ...overrides,
  }
}

function existing(overrides: Partial<ExistingSeedReview> = {}): ExistingSeedReview {
  const base = desired()
  return {
    id: base.id,
    reference: base.reference,
    targetId: base.targetId,
    rating: base.rating,
    customer_note: base.customer_note,
    seller_note: base.seller_note,
    deleted_at: null,
    ...overrides,
  }
}

describe("sync-reviews stable ids", () => {
  it("generuje deterministyczny identyfikator z provenance+vendor+index", () => {
    const first = buildStableReviewId("seeded from gp-ops", "city-beauty", 2)
    const second = buildStableReviewId("seeded from gp-ops", "city-beauty", 2)
    const otherIndex = buildStableReviewId("seeded from gp-ops", "city-beauty", 3)
    const otherVendor = buildStableReviewId("seeded from gp-ops", "other-vendor", 2)

    expect(first).toBe(second)
    expect(first).toMatch(/^gp_rev_[0-9a-f]{32}$/)
    expect(first).not.toBe(otherIndex)
    expect(first).not.toBe(otherVendor)
  })
})

describe("parseReviewSyncArgs", () => {
  const originalEnv = process.env

  beforeEach(() => {
    process.env = { ...originalEnv }
    delete process.env.GP_SYNC_APPLY
  })

  afterAll(() => {
    process.env = originalEnv
  })

  it("domyślnie działa w dry-run i zapis dopuszcza tylko po --apply", () => {
    expect(parseReviewSyncArgs(["gp-dev", "bonbeauty"]).dryRun).toBe(true)
    expect(parseReviewSyncArgs(["gp-dev", "bonbeauty", "--apply"]).dryRun).toBe(false)
  })
})

describe("buildReviewSyncPlan", () => {
  it("planuje create dla nowej standalone review i skip dla identycznego rerun", () => {
    const incoming = desired()
    const firstPlan = buildReviewSyncPlan([incoming], [])
    const secondPlan = buildReviewSyncPlan([incoming], [existing()])

    expect(firstPlan.entries).toEqual([
      expect.objectContaining({
        id: incoming.id,
        action: "create",
        reference: "seller",
        targetId: "seller-city-beauty",
      }),
    ])
    expect(secondPlan.entries).toEqual([
      expect.objectContaining({
        id: incoming.id,
        action: "skip",
      }),
    ])
    expect(secondPlan.conflicts).toHaveLength(0)
  })

  it("wykrywa conflict report dla zmiany ratingu albo celu stable ID", () => {
    const incoming = desired({ rating: 4, targetId: "seller-new-target" })
    const plan = buildReviewSyncPlan([incoming], [existing()])

    expect(plan.entries).toEqual([
      expect.objectContaining({
        action: "update",
        conflict: expect.stringContaining("rating"),
        diffs: expect.arrayContaining([
          expect.objectContaining({ field: "rating" }),
          expect.objectContaining({ field: "target_id" }),
        ]),
      }),
    ])
    expect(plan.conflicts).toEqual([expect.stringContaining(incoming.id)])
  })

  it("planuje deactivation withdrawn dla seeded review nieobecnej w kontrakcie", () => {
    const stale = existing({
      id: buildStableReviewId("seeded from gp-ops", "city-beauty", 9),
    })

    const plan = buildReviewSyncPlan([desired()], [existing(), stale])

    expect(plan.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: stale.id,
          action: "deactivate",
        }),
      ])
    )
  })

  it("nie planuje ponownej deactivation dla już soft-deleted withdrawn review", () => {
    const stale = existing({
      id: buildStableReviewId("seeded from gp-ops", "city-beauty", 9),
      deleted_at: new Date("2026-06-09T00:00:00.000Z"),
    })

    const plan = buildReviewSyncPlan([desired()], [existing(), stale])

    expect(plan.entries.map((entry) => entry.id)).not.toContain(stale.id)
  })

  it("obsługuje product review jako osobny target scoped wcześniej przez resolver DB", () => {
    const productReview = desired({
      id: buildStableReviewId("seeded from gp-ops", "city-beauty", 1),
      index: 1,
      reference: "product",
      targetId: "prod-scoped-bonbeauty",
    })

    const plan = buildReviewSyncPlan([productReview], [])

    expect(plan.entries).toEqual([
      expect.objectContaining({
        action: "create",
        reference: "product",
        targetId: "prod-scoped-bonbeauty",
      }),
    ])
  })
})
