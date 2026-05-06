/**
 * Story v160-8-7: POST /admin/operator/smoke-gate-ratify — admin records
 * binary verdict (pass/fail) + admin_note + audit log.
 * Story v160-cleanup-15f — AC2 + AC3:
 *   - Ratification persisted to phase_b_smoke_gate_ratifications DB table.
 *   - `unknown`/`skip`/`fail` items block PASS verdict UNLESS request
 *     carries force=true + force_reason (audit-trailed in DB row).
 */

import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import type { Knex } from "knex"

import { computeCohortMetrics } from "../../../../lib/cohort-metrics-aggregator"
import {
  computeSmokeGateState,
  ratifyVerdict,
} from "../../../../lib/phase-b-smoke-gate-aggregator"

type RatifyBody = {
  verdict?: "pass" | "fail"
  admin_note?: string
  force?: boolean
  force_reason?: string
  supersedes_id?: string
}

export async function POST(
  req: MedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const body = (req.body ?? {}) as RatifyBody
  if (!body.verdict || !["pass", "fail"].includes(body.verdict)) {
    res.status(400).json({ error: "verdict required (pass|fail)" })
    return
  }

  const db = req.scope.resolve(ContainerRegistrationKeys.PG_CONNECTION) as Knex
  const cohortMetrics = await computeCohortMetrics({ db })
  const state = await computeSmokeGateState(db, cohortMetrics)

  // AC3: any non-pass item blocks PASS verdict unless force=true+reason.
  const nonPassItems = state.items.filter((it) => it.status !== "pass")
  if (body.verdict === "pass" && nonPassItems.length > 0 && !body.force) {
    res.status(409).json({
      error:
        "Cannot ratify PASS while items have status != pass (cleanup-15f AC3); pass force=true with force_reason to override",
      non_pass_items: nonPassItems.map((it) => ({
        key: it.key,
        status: it.status,
      })),
    })
    return
  }

  if (body.verdict === "pass" && body.force && !body.force_reason) {
    res.status(400).json({
      error: "force=true requires force_reason for audit trail (cleanup-15f AC3)",
    })
    return
  }

  const admin_id =
    (req as unknown as { auth_context?: { actor_id?: string } }).auth_context
      ?.actor_id ?? "admin"

  try {
    const row = await ratifyVerdict(db, {
      verdict: body.verdict,
      items: state.items,
      admin_id,
      admin_note: body.admin_note,
      force_override: Boolean(body.force),
      force_override_reason: body.force_reason,
      supersedes_id: body.supersedes_id,
    })
    res.json({ ratified: row })
  } catch (err) {
    res.status(500).json({
      error: "ratification_persist_failed",
      detail: (err as Error).message,
    })
  }
}
