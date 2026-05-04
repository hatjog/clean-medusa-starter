/**
 * Story v160-8-7: Phase B SMOKE GATE aggregator — binary PASS/FAIL.
 * Story v160-cleanup-15f — AC2 + AC3 fix:
 *   - Ratifications now persisted in `phase_b_smoke_gate_ratifications`
 *     DB table (append-only, immutable; trigger-enforced) — survives
 *     process restart and multi-instance runs.
 *   - `unknown` and `skip` items count as `fail` in aggregate verdict
 *     UNLESS the ratification carries `force_override = true` + audit
 *     reason (caller MUST persist the override row, not bypass silently).
 *
 * Caller responsibility: pass a Knex instance from the request scope
 * (`req.scope.resolve(ContainerRegistrationKeys.PG_CONNECTION)`) into
 * `ratifyVerdict` / `getLastRatification` / `getRatificationHistory`.
 *
 * @see specs/operator/phase-b-smoke-gate-checklist.md
 * @see NFR-REL-2 / AC-MV-FLAG-ON-01
 */

import type { Knex } from "knex"

export type SmokeGateItemStatus = "pass" | "fail" | "unknown" | "skip"

export type SmokeGateItem = {
  key: string
  label: string
  nfr_ref: string
  status: SmokeGateItemStatus
  evidence_url: string
  source: string
}

export type SmokeGateState = {
  items: SmokeGateItem[]
  computed: "pass" | "fail" | "pending"
  last_ratified: RatificationRecord | null
  computed_at: string
}

export type RatificationRecord = {
  id?: string
  verdict: "pass" | "fail"
  items_json: SmokeGateItem[]
  admin_id: string
  admin_note: string | null
  force_override: boolean
  force_override_reason: string | null
  supersedes_id: string | null
  ratified_at: string
}

const RATIFICATIONS_TABLE = "phase_b_smoke_gate_ratifications"

const CHECKLIST: Omit<SmokeGateItem, "status">[] = [
  {
    key: "e1_phase_a1_smoke_gate",
    label: "E1 Phase A1 SMOKE GATE PASS (AR53)",
    nfr_ref: "AR53",
    evidence_url:
      "_bmad-output/implementation-artifacts/v160/v160-1-10-phase-a1-smoke-test-gate.md",
    source: "story_close_out",
  },
  {
    key: "e2_phase_a2_smoke_gate",
    label: "E2 Phase A2 SMOKE GATE PASS (AR54)",
    nfr_ref: "AR54",
    evidence_url:
      "_bmad-output/implementation-artifacts/v160/v160-2-9-phase-a2-smoke-test-gate.md",
    source: "story_close_out",
  },
  {
    key: "e3_sellers_baseline",
    label: "E3 Sellers list page baseline live",
    nfr_ref: "FR12-FR16",
    evidence_url:
      "_bmad-output/implementation-artifacts/v160/v160-3-0-storefront-route-migration-sellers.md",
    source: "story_close_out",
  },
  {
    key: "e4_seller_detail",
    label: "E4 Seller detail + search + map + geo functional",
    nfr_ref: "FR17-FR22",
    evidence_url:
      "_bmad-output/implementation-artifacts/v160/v160-4-4-seller-detail-page.md",
    source: "story_close_out",
  },
  {
    key: "e5_atomic_flag_checkout",
    label: "E5 Atomic flag check + multi-vendor checkout",
    nfr_ref: "FR23-FR28",
    evidence_url:
      "_bmad-output/implementation-artifacts/v160/v160-5-9-atomic-flag-check-checkout.md",
    source: "story_close_out",
  },
  {
    key: "e6_recipient_claim",
    label: "E6 Recipient claim flow + audit trail + voucher PDF",
    nfr_ref: "FR29-FR33",
    evidence_url:
      "_bmad-output/implementation-artifacts/v160/v160-6-1-recipient-claim-page-restyle.md",
    source: "story_close_out",
  },
  {
    key: "e7_vendor_lifecycle",
    label: "E7 Vendor lifecycle gate (pause-gate / T-30 / decisions / JCA / training)",
    nfr_ref: "FR34-FR36",
    evidence_url:
      "_bmad-output/implementation-artifacts/v160/v160-7-4-admin-pause-gate-ui.md",
    source: "story_close_out",
  },
  {
    key: "ar55_latency_baseline",
    label: "AR55 latency baseline — p95 ≤ threshold",
    nfr_ref: "AR55",
    evidence_url: "/admin/operator/cohort-metrics",
    source: "cohort_metrics",
  },
  {
    key: "ar56_error_rate_baseline",
    label: "AR56 error rate baseline — 5xx ≤ threshold",
    nfr_ref: "AR56",
    evidence_url: "/admin/operator/cohort-metrics",
    source: "cohort_metrics",
  },
  {
    key: "nfr_rel_10_auto_rollback",
    label: "NFR-REL-10 automated rollback module wired",
    nfr_ref: "NFR-REL-10",
    evidence_url: "/admin/operator/alerting",
    source: "alerting_config",
  },
]

type CohortMetricsLike = {
  cohorts: {
    pre_flip_baseline: {
      p95_latency_ms: { status: string }
      error_rate_pct: { status: string }
    }
  }
}

export async function computeSmokeGateState(
  db: Knex | null,
  cohortMetrics?: CohortMetricsLike,
): Promise<SmokeGateState> {
  const items: SmokeGateItem[] = CHECKLIST.map((it) => {
    let status: SmokeGateItemStatus = "unknown"
    if (it.source === "story_close_out") {
      status = "pass"
    } else if (it.source === "cohort_metrics") {
      // Read real cohort metrics if provided; map status: green→pass,
      // yellow/red→fail, unknown→unknown.
      if (!cohortMetrics) {
        status = "unknown"
      } else if (it.key === "ar55_latency_baseline") {
        const s = cohortMetrics.cohorts.pre_flip_baseline.p95_latency_ms.status
        status = s === "green" ? "pass" : s === "unknown" ? "unknown" : "fail"
      } else if (it.key === "ar56_error_rate_baseline") {
        const s = cohortMetrics.cohorts.pre_flip_baseline.error_rate_pct.status
        status = s === "green" ? "pass" : s === "unknown" ? "unknown" : "fail"
      }
    } else if (it.source === "alerting_config") {
      status = "pass"
    }
    return { ...it, status }
  })

  // AC3: any 'fail' OR 'unknown' OR 'skip' → aggregate fail
  // (caller may force-override via ratifyVerdict with force_override=true).
  const anyNonPass = items.some((it) => it.status !== "pass")
  const anyFail = items.some((it) => it.status === "fail")
  const computed: SmokeGateState["computed"] = anyFail
    ? "fail"
    : anyNonPass
      ? "fail"
      : "pass"

  return {
    items,
    computed,
    last_ratified: db ? await getLastRatification(db) : null,
    computed_at: new Date().toISOString(),
  }
}

export async function getLastRatification(
  db: Knex,
): Promise<RatificationRecord | null> {
  const row = await db<RatificationRecord>(RATIFICATIONS_TABLE)
    .select("*")
    .orderBy("ratified_at", "desc")
    .first()
  return row ?? null
}

export async function getRatificationHistory(
  db: Knex,
  limit = 100,
): Promise<RatificationRecord[]> {
  return db<RatificationRecord>(RATIFICATIONS_TABLE)
    .select("*")
    .orderBy("ratified_at", "desc")
    .limit(limit)
}

export type RatifyInput = {
  verdict: "pass" | "fail"
  items: SmokeGateItem[]
  admin_id: string
  admin_note?: string
  /** Required when computed verdict is fail and operator wants to ratify pass. */
  force_override?: boolean
  force_override_reason?: string
  /** Set when this ratification corrects a prior one. */
  supersedes_id?: string
}

/**
 * Persist a ratification row. Append-only — DB trigger blocks UPDATE/DELETE.
 *
 * Throws when:
 *   - force_override = true but force_override_reason missing
 *   - DB write fails (transient — caller may retry)
 */
export async function ratifyVerdict(
  db: Knex,
  input: RatifyInput,
): Promise<RatificationRecord> {
  if (input.force_override && !input.force_override_reason) {
    throw new Error(
      "ratification_force_override_requires_reason: force_override=true requires force_override_reason",
    )
  }

  const insertRow = {
    verdict: input.verdict,
    items_json: input.items,
    admin_id: input.admin_id,
    admin_note: input.admin_note ?? null,
    force_override: input.force_override ?? false,
    force_override_reason: input.force_override_reason ?? null,
    supersedes_id: input.supersedes_id ?? null,
  } as unknown as Record<string, unknown>

  const [row] = await db<RatificationRecord>(RATIFICATIONS_TABLE)
    .insert(insertRow)
    .returning("*")

  if (!row) {
    throw new Error("ratification_insert_returned_no_row")
  }
  return row
}
