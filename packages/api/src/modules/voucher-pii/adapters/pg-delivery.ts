/**
 * pg-delivery — Postgres adapter for DeliveryDecisionPort (cleanup-44 / TF-105).
 *
 * Manages `voucher_delivery_decision` table (single-row-per-consent-audit).
 * Created by STORY-2-2 migration.
 */

import type { Knex } from "knex";
import { randomUUID } from "node:crypto";
import type { DeliveryOutcome } from "../types";
import type { DeliveryDecisionPort } from "../ports";

export class PgDeliveryAdapter implements DeliveryDecisionPort {
  constructor(private readonly db: Knex) {}

  async insertPending(args: {
    consent_audit_id: string;
    market_id: string;
  }): Promise<{ delivery_decision_id: string }> {
    const id = randomUUID();
    await this.db("voucher_delivery_decision").insert({
      id,
      consent_audit_id: args.consent_audit_id,
      market_id: args.market_id,
      outcome: "pending",
      delivery_attempt_n: 0,
      provider_ref: null,
      latency_ms: null,
      created_at: new Date(),
    });
    return { delivery_decision_id: id };
  }

  async recordOutcome(args: {
    delivery_decision_id: string;
    outcome: DeliveryOutcome;
    latency_ms: number;
    provider_ref: string | null;
    delivery_attempt_n: number;
  }): Promise<void> {
    await this.db("voucher_delivery_decision")
      .where({ id: args.delivery_decision_id })
      .update({
        outcome: args.outcome,
        dispatched_at: args.outcome === "dispatched" ? new Date() : null,
        latency_ms: args.latency_ms,
        provider_ref: args.provider_ref,
        delivery_attempt_n: args.delivery_attempt_n,
      });
  }
}
