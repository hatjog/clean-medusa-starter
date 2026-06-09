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
    // M3 fix (ADR-148): w pełni zmaterializowany rekend (metadata.gp.locale|provenance)
    // — reprezentuje stan po sync, więc identyczny rerun = skip.
    locale: base.locale,
    provenance: base.provenanceTag,
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
    delete process.env.GP_DRY_RUN
  })

  afterAll(() => {
    process.env = originalEnv
  })

  it("domyślnie działa w dry-run i zapis dopuszcza tylko po --apply", () => {
    expect(parseReviewSyncArgs(["gp-dev", "bonbeauty"]).dryRun).toBe(true)
    expect(parseReviewSyncArgs(["gp-dev", "bonbeauty", "--apply"]).dryRun).toBe(false)
  })

  it("M1: GP_DRY_RUN=true jest twardym override — blokuje --apply z env/args", () => {
    process.env.GP_DRY_RUN = "true"
    process.env.GP_SYNC_APPLY = "true"
    // Nawet przy GP_SYNC_APPLY=true, GP_DRY_RUN=true wymusza dry-run
    expect(parseReviewSyncArgs(["gp-dev", "bonbeauty", "--apply"]).dryRun).toBe(true)
  })

  it("M1: GP_DRY_RUN=false nie blokuje --apply", () => {
    process.env.GP_DRY_RUN = "false"
    expect(parseReviewSyncArgs(["gp-dev", "bonbeauty", "--apply"]).dryRun).toBe(false)
  })

  it("M1: brak GP_DRY_RUN i brak --apply = dry-run (domyślnie bezpieczny)", () => {
    expect(parseReviewSyncArgs(["gp-dev", "bonbeauty"]).dryRun).toBe(true)
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

  it("I1: reaktywacja soft-deleted linku (targetId=null) NIE trafia do conflicts[]", () => {
    // Review istnieje w DB, ale link jest soft-deleted (targetId=null zwrócone przez loadExistingSeedReviews)
    const reactivate = existing({ targetId: null })
    const incoming = desired()

    const plan = buildReviewSyncPlan([incoming], [reactivate])

    // Powinien zaplanować update (reaktywacja), ale NOT jako konflikt
    expect(plan.entries).toEqual([
      expect.objectContaining({ action: "update" }),
    ])
    expect(plan.conflicts).toHaveLength(0)
  })

  it("I1: zmiana aktywnego targetu (targetId!==null) TRAFIA do conflicts[]", () => {
    // Review istnieje z aktywnym linkiem do innego targetu
    const withDifferentTarget = existing({ targetId: "seller-other-target" })
    const incoming = desired({ targetId: "seller-city-beauty" })

    const plan = buildReviewSyncPlan([incoming], [withDifferentTarget])

    expect(plan.entries).toEqual([
      expect.objectContaining({ action: "update" }),
    ])
    expect(plan.conflicts).toHaveLength(1)
    expect(plan.conflicts[0]).toContain("target_id")
  })

  it("M3 (ADR-148): backfilluje istniejący rekord bez metadata.gp.* przez update, bez seed-konfliktu", () => {
    // Rekord zaseedowany PRZED ADR-148 — locale/provenance jeszcze nie zmaterializowane.
    const preMaterialized = existing({ locale: null, provenance: null })
    const incoming = desired()

    const plan = buildReviewSyncPlan([incoming], [preMaterialized])

    expect(plan.entries).toEqual([
      expect.objectContaining({
        action: "update",
        diffs: expect.arrayContaining([
          expect.objectContaining({ field: "locale", incoming: "pl" }),
          expect.objectContaining({ field: "provenance", incoming: "seeded from gp-ops" }),
        ]),
      }),
    ])
    // Backfill projekcji display-only NIE jest seed-konfliktem.
    expect(plan.conflicts).toHaveLength(0)
    expect(plan.entries[0]).not.toHaveProperty("conflict")
  })

  it("M3 (ADR-148): zmiana ratingu PLUS backfill locale daje update z konfliktem tylko na rating", () => {
    const preMaterialized = existing({ locale: null, provenance: null })
    const incoming = desired({ rating: 3 })

    const plan = buildReviewSyncPlan([incoming], [preMaterialized])

    expect(plan.conflicts).toHaveLength(1)
    expect(plan.conflicts[0]).toContain("rating")
    expect(plan.conflicts[0]).not.toContain("locale")
    expect(plan.conflicts[0]).not.toContain("provenance")
  })

  it("M2: duplikaty existing po tym samym id (product-review multi-SC) są deduplikowane", () => {
    // Symuluje sytuację gdy loadExistingSeedReviews zwróci zdeduplikowaną tablicę.
    // buildReviewSyncPlan nie widzi duplikatów w pętli deactivation (dedupe odbywa się w loadExistingSeedReviews).
    const staleId = buildStableReviewId("seeded from gp-ops", "city-beauty", 9)
    // Dwa wpisy tego samego id (jak gdyby LEFT JOIN zwrócił dwa wiersze przed deduplikacją w DB layer)
    const existingDeduped = [existing(), existing({ id: staleId, deleted_at: null })]

    const plan = buildReviewSyncPlan([desired()], existingDeduped)

    // Stale review powinna pojawić się TYLKO raz jako deactivate
    const deactivations = plan.entries.filter((e) => e.action === "deactivate")
    expect(deactivations).toHaveLength(1)
    expect(deactivations[0].id).toBe(staleId)
  })
})
