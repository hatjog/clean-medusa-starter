/**
 * runtime-flag-resolver — STORY-2-3 D-79 / E-R11 per-market flag flip orchestrator.
 *
 * Owns the read+write surface for `voucher_template_v1_runtime_enabled` flag
 * **per market**. NEVER flips globally; the `--all-markets` operator path is
 * intentionally absent (per D-79 + Risk #3 in story spec).
 *
 * D-59 HARD GATE — fail-closed:
 *   - Before transitioning `false → true`, the resolver MUST verify the
 *     market's `legal_signoff` block (signed YAML committed under
 *     `gp-ops/markets/{market}/voucher-template-runtime/d59-legal-signoff.yaml`)
 *     is `signoff_status = approved` AND the External Counsel signature
 *     timestamp is within retention. Mismatch → `LegalSignoffMissingError`.
 *   - Override path requires Architecture lead + Compliance officer dual-key
 *     (operator passes BOTH `architect_actor_id` AND `compliance_actor_id`),
 *     emits `voucher.template.runtime.activated.v1` with
 *     `override_reason` + Sentry CRITICAL mirror via `canary-rollback.ts`.
 *
 * @see _bmad-output/implementation-artifacts/v150/STORY-2-3-VOUCHER-TEMPLATE-RUNTIME-ER11.md
 * @see _bmad-output/planning-artifacts/architecture.md L573-578 (D-79)
 * @see specs/adr/2026-04-29-adr-068-compliance-checklist.md (D-59 prerequisite)
 *
 * Boundary: this file is the orchestrator. It depends on three narrow ports:
 *   1. {@link FlagWritePort} — atomic state transition + audit row.
 *   2. {@link LegalSignoffPort} — read the YAML signoff + verify hash.
 *   3. {@link RuntimeEventEmitterPort} — emit `voucher.template.runtime.activated.v1`.
 *
 * Tests inject in-memory fakes; runtime wiring (Medusa container loader)
 * is out-of-scope here.
 */

export type RuntimeFlagState = "off" | "on" | "kill_switch";

/** D-59 gate outcome for a (market, flag_id) pair. */
export interface LegalSignoffStatus {
  /** `approved` | `pending` | `expired` | `revoked` | `forged` */
  signoff_status: "approved" | "pending" | "expired" | "revoked" | "forged";
  /** ISO-8601 — External Counsel signature time. */
  signed_at: string | null;
  /** SHA-256 of the committed signoff PDF (hex). NULL when not yet signed. */
  pdf_hash: string | null;
  /** ISO-8601 — last successful monthly hash verification (per pre-mortem #34). */
  last_hash_verified_at: string | null;
}

export class LegalSignoffMissingError extends Error {
  public readonly code = "LEGAL_SIGNOFF_MISSING" as const;
  constructor(public readonly marketId: string, public readonly status: LegalSignoffStatus["signoff_status"]) {
    super(
      `D-59 gate not satisfied for market='${marketId}' (signoff_status=${status}). ` +
        `See gp-ops/markets/${marketId}/voucher-template-runtime/d59-legal-signoff.yaml ` +
        `and gp-ops/runbooks/voucher-template-runtime-activation.md.`
    );
    this.name = "LegalSignoffMissingError";
  }
}

export class DualKeyOverrideMissingError extends Error {
  public readonly code = "DUAL_KEY_OVERRIDE_MISSING" as const;
  constructor(public readonly marketId: string) {
    super(
      `Override path requires BOTH architect_actor_id AND compliance_actor_id for market='${marketId}'. ` +
        `Single-key override rejected (see Pre-mortem #34 risk mitigation).`
    );
    this.name = "DualKeyOverrideMissingError";
  }
}

export class GlobalFlipForbiddenError extends Error {
  public readonly code = "GLOBAL_FLIP_FORBIDDEN" as const;
  constructor() {
    super(
      `Per-market scope is enforced by D-79; global flip is not supported. ` +
        `Flip markets one at a time with canary observation between each.`
    );
    this.name = "GlobalFlipForbiddenError";
  }
}

/** Atomic flag write port. Implementation MUST wrap the audit row + event emit
 *  in a single transaction; rollback on either failure. */
export interface FlagWritePort {
  transition(input: {
    flag_id: "voucher_template_v1_runtime_enabled";
    market_id: string;
    new_state: RuntimeFlagState;
    reason: string;
    actor_id: string;
    /** Optional dual-key override; populated when bypassing D-59. */
    override?: {
      architect_actor_id: string;
      compliance_actor_id: string;
      justification: string;
    };
  }): Promise<{ prior_state: RuntimeFlagState; audit_row_id: string }>;

  read(input: {
    flag_id: "voucher_template_v1_runtime_enabled";
    market_id: string;
  }): Promise<{ state: RuntimeFlagState; last_transition_at: Date | null }>;
}

/** Reads the D-59 signoff YAML + verifies hash chain. */
export interface LegalSignoffPort {
  readSignoff(market_id: string): Promise<LegalSignoffStatus>;
}

/** Emits `voucher.template.runtime.activated.v1` per architecture.md L1019. */
export interface RuntimeEventEmitterPort {
  emitActivated(input: {
    market_id: string;
    flag_id: "voucher_template_v1_runtime_enabled";
    prior_state: RuntimeFlagState;
    new_state: RuntimeFlagState;
    actor_id: string;
    timestamp: string;
    seller_id?: string | null;
    runtime_version?: string;
    override_reason?: string;
  }): Promise<{ event_id: string }>;
}

export interface FlipInput {
  market_id: string;
  new_state: RuntimeFlagState;
  reason: string;
  actor_id: string;
  /** When set, bypasses D-59 gate; both keys required. */
  override?: {
    architect_actor_id: string;
    compliance_actor_id: string;
    justification: string;
  };
}

export interface FlipResult {
  market_id: string;
  prior_state: RuntimeFlagState;
  new_state: RuntimeFlagState;
  audit_row_id: string;
  event_id: string;
  legal_signoff: LegalSignoffStatus;
  override_used: boolean;
}

export class RuntimeFlagResolver {
  constructor(
    private readonly flag: FlagWritePort,
    private readonly legal: LegalSignoffPort,
    private readonly events: RuntimeEventEmitterPort,
    private readonly now: () => Date = () => new Date()
  ) {}

  /**
   * Read current flag state + last D-59 status snapshot for a market.
   * Read-only; safe to invoke from canary / dashboards.
   */
  async getRuntimeStatus(input: { market_id: string }): Promise<{
    market_id: string;
    flag_state: RuntimeFlagState;
    last_transition_at: Date | null;
    legal_signoff: LegalSignoffStatus;
  }> {
    if (!input.market_id) throw new Error("RuntimeFlagResolver.getRuntimeStatus: market_id is required");
    const [snap, sig] = await Promise.all([
      this.flag.read({
        flag_id: "voucher_template_v1_runtime_enabled",
        market_id: input.market_id,
      }),
      this.legal.readSignoff(input.market_id),
    ]);
    return {
      market_id: input.market_id,
      flag_state: snap.state,
      last_transition_at: snap.last_transition_at,
      legal_signoff: sig,
    };
  }

  /**
   * Flip the per-market `voucher_template_v1_runtime_enabled` flag with D-59
   * gate enforcement. Idempotent on `(market_id, new_state)` — re-flipping to
   * the same state is a no-op (returns prior state unchanged but no event).
   *
   * @throws LegalSignoffMissingError when transitioning OFF→ON without override
   *         AND signoff_status !== "approved".
   * @throws DualKeyOverrideMissingError when override path is partially populated.
   * @throws GlobalFlipForbiddenError when caller tries to bypass per-market scope.
   */
  async flip(input: FlipInput): Promise<FlipResult> {
    if (!input.market_id) throw new Error("RuntimeFlagResolver.flip: market_id is required");
    if (input.market_id === "*" || input.market_id === "all") {
      throw new GlobalFlipForbiddenError();
    }
    if (!input.actor_id) throw new Error("RuntimeFlagResolver.flip: actor_id is required");

    if (input.override) {
      if (!input.override.architect_actor_id || !input.override.compliance_actor_id) {
        throw new DualKeyOverrideMissingError(input.market_id);
      }
    }

    const signoff = await this.legal.readSignoff(input.market_id);

    // D-59 HARD GATE: only enforce on OFF -> ON transition without override.
    const isActivating = input.new_state === "on";
    if (isActivating && !input.override && signoff.signoff_status !== "approved") {
      throw new LegalSignoffMissingError(input.market_id, signoff.signoff_status);
    }

    const transition = await this.flag.transition({
      flag_id: "voucher_template_v1_runtime_enabled",
      market_id: input.market_id,
      new_state: input.new_state,
      reason: input.reason,
      actor_id: input.override
        ? `override:${input.override.architect_actor_id}+${input.override.compliance_actor_id}`
        : input.actor_id,
      override: input.override,
    });

    // Idempotent no-op: same state -> no event emission.
    if (transition.prior_state === input.new_state) {
      return {
        market_id: input.market_id,
        prior_state: transition.prior_state,
        new_state: input.new_state,
        audit_row_id: transition.audit_row_id,
        event_id: "noop",
        legal_signoff: signoff,
        override_used: !!input.override,
      };
    }

    const ts = this.now().toISOString();
    const emitted = await this.events.emitActivated({
      market_id: input.market_id,
      flag_id: "voucher_template_v1_runtime_enabled",
      prior_state: transition.prior_state,
      new_state: input.new_state,
      actor_id: input.override
        ? `override:${input.override.architect_actor_id}+${input.override.compliance_actor_id}`
        : input.actor_id,
      timestamp: ts,
      override_reason: input.override?.justification,
    });

    return {
      market_id: input.market_id,
      prior_state: transition.prior_state,
      new_state: input.new_state,
      audit_row_id: transition.audit_row_id,
      event_id: emitted.event_id,
      legal_signoff: signoff,
      override_used: !!input.override,
    };
  }
}
