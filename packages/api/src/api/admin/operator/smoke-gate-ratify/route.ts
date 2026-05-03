/**
 * Story v160-8-7: POST /admin/operator/smoke-gate-ratify — admin records
 * binary verdict (pass/fail) + admin_note + audit log.
 */

import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import {
  computeSmokeGateState,
  ratify,
} from "../../../../lib/phase-b-smoke-gate-aggregator"

export async function POST(
  req: MedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const body = (req.body ?? {}) as {
    verdict?: "pass" | "fail"
    admin_note?: string
    force?: boolean
  }
  if (!body.verdict || !["pass", "fail"].includes(body.verdict)) {
    res.status(400).json({ error: "verdict required (pass|fail)" })
    return
  }
  const state = await computeSmokeGateState()
  if (body.verdict === "pass" && state.items.some((it) => it.status === "fail") && !body.force) {
    res.status(409).json({
      error: "Cannot ratify PASS while items have status=fail; pass force=true to override",
      failing_items: state.items.filter((it) => it.status === "fail").map((it) => it.key),
    })
    return
  }
  const admin_id =
    (req as unknown as { auth_context?: { actor_id?: string } }).auth_context
      ?.actor_id ?? "admin"
  const record = {
    verdict: body.verdict,
    admin_id,
    admin_note: body.admin_note ?? "",
    ratified_at: new Date().toISOString(),
  }
  ratify(record)
  res.json({ ratified: record })
}
