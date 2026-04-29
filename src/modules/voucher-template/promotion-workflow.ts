/**
 * promotion-workflow — STORY-2-3 D-79 voucher template promotion state machine.
 *
 * Implements the DRAFT → REVIEW → APPROVED → PUBLISHED transitions that the
 * `voucher_template_v1_runtime_enabled` flag enables. The state machine:
 *   - rejects ALL transitions when the per-market flag is OFF (RuntimeDisabledError);
 *   - only allows the canonical forward chain (no skipping; explicit reject
 *     paths from REVIEW or APPROVED collapse the template back to REJECTED);
 *   - emits one of three events per transition:
 *       voucher.template.submitted_for_approval.v1
 *       voucher.template.approved.v1
 *       voucher.template.rejected.v1
 *     (schemas landed in v1.4.0 STORY-VOUCHER-TEMPLATE-V1 / hatjog/GP#30 — this
 *     story does NOT introduce new schemas).
 *
 * Audit-first contract (D-67 + ADR-078):
 *   - Every transition writes a row to `voucher_pii_consent_audit` (sharded by
 *     `(market_id, hour_bucket)`) BEFORE the template status column is updated.
 *   - DB trigger (Migration1735000200001) requires the audit row to exist for
 *     the (template_id, from_status → to_status) tuple, OR the UPDATE rolls
 *     back. This file enforces the order at the application layer; the trigger
 *     is the defence-in-depth backstop.
 *
 * @see _bmad-output/implementation-artifacts/v150/STORY-2-3-VOUCHER-TEMPLATE-RUNTIME-ER11.md
 * @see _bmad-output/planning-artifacts/architecture.md L573-578 (D-79)
 */

import {
  RuntimeFlagResolver,
  type RuntimeFlagState,
} from "./runtime-flag-resolver";

export type TemplateStatus =
  | "DRAFT"
  | "REVIEW"
  | "APPROVED"
  | "PUBLISHED"
  | "REJECTED";

/** Canonical forward transitions. Reject paths handled separately. */
const FORWARD_EDGES: ReadonlyArray<readonly [TemplateStatus, TemplateStatus]> = [
  ["DRAFT", "REVIEW"],
  ["REVIEW", "APPROVED"],
  ["APPROVED", "PUBLISHED"],
] as const;

/** Reject edges — collapse to REJECTED from any non-terminal state. */
const REJECT_EDGES: ReadonlyArray<TemplateStatus> = [
  "REVIEW",
  "APPROVED",
] as const;

export class RuntimeDisabledError extends Error {
  public readonly code = "RUNTIME_DISABLED" as const;
  constructor(public readonly marketId: string, public readonly flagState: RuntimeFlagState) {
    super(
      `Voucher template runtime is OFF for market='${marketId}' (flag_state=${flagState}). ` +
        `promoteTemplate is rejected. Flip 'voucher_template_v1_runtime_enabled' ON ` +
        `(D-59 legal sign-off required) before promoting templates.`
    );
    this.name = "RuntimeDisabledError";
  }
}

export class PromotionPathInvalidError extends Error {
  public readonly code = "PROMOTION_PATH_INVALID" as const;
  constructor(public readonly fromStatus: TemplateStatus, public readonly toStatus: TemplateStatus) {
    super(
      `Promotion ${fromStatus} → ${toStatus} is not a legal transition. ` +
        `Allowed forward edges: DRAFT→REVIEW, REVIEW→APPROVED, APPROVED→PUBLISHED. ` +
        `Allowed reject edges: REVIEW→REJECTED, APPROVED→REJECTED.`
    );
    this.name = "PromotionPathInvalidError";
  }
}

/** Audit row write — extends `voucher_pii_consent_audit` chain. */
export interface PromotionAuditPort {
  appendPromotionAuditRow(input: {
    market_id: string;
    template_id: string;
    from_status: TemplateStatus;
    to_status: TemplateStatus;
    actor_id: string;
    seller_id?: string | null;
  }): Promise<{ audit_row_id: string }>;
}

/** Status mutation port — backed by the templates table writer with DB trigger. */
export interface TemplateStatusPort {
  /** @returns the prior status (caller asserts equality with `from_status`). */
  readStatus(input: { template_id: string }): Promise<TemplateStatus | null>;

  /**
   * UPDATE template SET status = $to WHERE id = $template_id AND status = $from.
   * MUST run inside the same tx as `appendPromotionAuditRow`. The DB trigger
   * verifies the audit row exists; ROLLBACK if not.
   */
  updateStatus(input: {
    template_id: string;
    expected_from: TemplateStatus;
    new_status: TemplateStatus;
  }): Promise<{ rows_affected: number }>;
}

/** Emits one of the three v1.4.0-landed lifecycle events. */
export interface PromotionEventEmitterPort {
  emitSubmittedForApproval(input: { template_id: string; market_id: string; actor_id: string }): Promise<void>;
  emitApproved(input: { template_id: string; market_id: string; actor_id: string }): Promise<void>;
  emitRejected(input: { template_id: string; market_id: string; actor_id: string; reason: string }): Promise<void>;
}

export interface PromoteInput {
  template_id: string;
  market_id: string;
  from_status: TemplateStatus;
  to_status: TemplateStatus;
  actor_id: string;
  /** Required when `to_status === "REJECTED"` — short reason string. */
  reject_reason?: string;
  /** Optional vendor seller. Audit row records null for platform/global actors. */
  seller_id?: string | null;
}

export interface PromoteResult {
  template_id: string;
  from_status: TemplateStatus;
  to_status: TemplateStatus;
  audit_row_id: string;
}

export class PromotionWorkflow {
  constructor(
    private readonly flagResolver: RuntimeFlagResolver,
    private readonly audit: PromotionAuditPort,
    private readonly templates: TemplateStatusPort,
    private readonly events: PromotionEventEmitterPort
  ) {}

  /**
   * Promote a template through the lifecycle. Validates flag + path +
   * current status; writes audit row first; updates status second; emits event last.
   *
   * @throws RuntimeDisabledError when the per-market flag is not "on".
   * @throws PromotionPathInvalidError when the requested edge is not legal.
   * @throws Error when the current template status does not match `from_status`.
   */
  async promote(input: PromoteInput): Promise<PromoteResult> {
    if (!input.template_id) throw new Error("PromotionWorkflow.promote: template_id is required");
    if (!input.market_id) throw new Error("PromotionWorkflow.promote: market_id is required");
    if (!input.actor_id) throw new Error("PromotionWorkflow.promote: actor_id is required");

    // 1. Flag gate.
    const status = await this.flagResolver.getRuntimeStatus({ market_id: input.market_id });
    if (status.flag_state !== "on") {
      throw new RuntimeDisabledError(input.market_id, status.flag_state);
    }

    // 2. Path validation.
    if (!isLegalEdge(input.from_status, input.to_status)) {
      throw new PromotionPathInvalidError(input.from_status, input.to_status);
    }

    // 3. Reject path requires reason.
    if (input.to_status === "REJECTED" && !input.reject_reason) {
      throw new Error("PromotionWorkflow.promote: reject_reason is required for REJECTED transitions");
    }

    // 4. Current status check.
    const current = await this.templates.readStatus({ template_id: input.template_id });
    if (current === null) {
      throw new Error(`PromotionWorkflow.promote: template ${input.template_id} not found`);
    }
    if (current !== input.from_status) {
      throw new Error(
        `PromotionWorkflow.promote: stale from_status — expected ${input.from_status}, ` +
          `actual ${current} for template ${input.template_id}`
      );
    }

    // 5. Audit row first (D-67 + DB trigger contract).
    const auditRow = await this.audit.appendPromotionAuditRow({
      market_id: input.market_id,
      template_id: input.template_id,
      from_status: input.from_status,
      to_status: input.to_status,
      actor_id: input.actor_id,
      seller_id: input.seller_id ?? null,
    });

    // 6. Status update.
    const updated = await this.templates.updateStatus({
      template_id: input.template_id,
      expected_from: input.from_status,
      new_status: input.to_status,
    });

    if (updated.rows_affected !== 1) {
      throw new Error(
        `PromotionWorkflow.promote: status update affected ${updated.rows_affected} rows ` +
          `(expected 1) — DB trigger likely rolled back; check audit row ${auditRow.audit_row_id}`
      );
    }

    // 7. Event emission (NIE new schemas; reuse v1.4.0 surface).
    if (input.to_status === "REVIEW") {
      await this.events.emitSubmittedForApproval({
        template_id: input.template_id,
        market_id: input.market_id,
        actor_id: input.actor_id,
      });
    } else if (input.to_status === "APPROVED" || input.to_status === "PUBLISHED") {
      await this.events.emitApproved({
        template_id: input.template_id,
        market_id: input.market_id,
        actor_id: input.actor_id,
      });
    } else if (input.to_status === "REJECTED") {
      await this.events.emitRejected({
        template_id: input.template_id,
        market_id: input.market_id,
        actor_id: input.actor_id,
        reason: input.reject_reason!,
      });
    }

    return {
      template_id: input.template_id,
      from_status: input.from_status,
      to_status: input.to_status,
      audit_row_id: auditRow.audit_row_id,
    };
  }
}

/** Pure helper — exported for tests and the DB trigger validator. */
export function isLegalEdge(from: TemplateStatus, to: TemplateStatus): boolean {
  if (to === "REJECTED") {
    return REJECT_EDGES.includes(from);
  }
  return FORWARD_EDGES.some(([f, t]) => f === from && t === to);
}
