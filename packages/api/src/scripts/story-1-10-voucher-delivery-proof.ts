import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import knexFactory from "knex";

import { PgAuditAdapter } from "../modules/voucher-pii/adapters/pg-audit";
import { PgDeliveryAdapter } from "../modules/voucher-pii/adapters/pg-delivery";
import { PgVoucherPiiAdapter } from "../modules/voucher-pii/adapters/pg-pii";
import { createInProcessIdempotencyPort } from "../modules/voucher-pii/adapters/pg-idempotency";
import { createInProcessRateLimitPort } from "../modules/voucher-pii/adapters/in-memory-rate-limit";
import { VoucherPiiService } from "../modules/voucher-pii/voucher-pii.service";
import type { EventEmitterPort } from "../modules/voucher-pii";

const ORDER_ID =
  process.env.GP_STORY_1_10_ORDER_ID ?? "order_01KRRYF2KNNG0V6AYZWRN0H6T4";
const ENTITLEMENT_ID =
  process.env.GP_STORY_1_10_ENTITLEMENT_ID ?? "ent_616d23617a72daec76c10aa6";
const MARKET_ID = process.env.GP_STORY_1_10_MARKET_ID ?? "bonbeauty";
const LOCALE = process.env.GP_STORY_1_10_LOCALE ?? "pl";
const REQUEST_ID =
  process.env.GP_STORY_1_10_REQUEST_ID ??
  `story-1-10-voucher-delivery-proof:${ORDER_ID}`;
const OUT_PATH =
  process.env.GP_STORY_1_10_DELIVERY_PROOF_PATH ??
  resolve(
    process.cwd(),
    "../../_bmad-output/releases/v1.8.0/implementation-artifacts/evidence/1-10-voucher-delivery-proof.json"
  );

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("DATABASE_URL is required");
}

class CapturingEvents implements EventEmitterPort {
  events: Array<{ event_type: string; market_id: string; payload: Record<string, unknown> }> = [];

  async emit(event: {
    event_type: string;
    market_id: string;
    payload: Record<string, unknown>;
  }): Promise<void> {
    this.events.push(event);
  }
}

type ExistingProofRow = {
  delivery_decision_id: string;
  consent_audit_id: string;
  recipient_pii_id: string | null;
  market_id: string;
  outcome: string;
  dispatched_at: Date | string | null;
  provider_ref: string | null;
  latency_ms: number | null;
  delivery_created_at: Date | string;
};

function safeEvent(event: {
  event_type: string;
  market_id: string;
  payload: Record<string, unknown>;
}) {
  return {
    event_type: event.event_type,
    market_id: event.market_id,
    payload_keys: Object.keys(event.payload).sort(),
  };
}

async function main() {
  const db = knexFactory({
    client: "pg",
    connection: databaseUrl,
  });

  try {
    const existing = await db("voucher_delivery_decision as d")
      .join("voucher_pii_consent_audit as a", "a.id", "d.consent_audit_id")
      .select<ExistingProofRow[]>([
        "d.id as delivery_decision_id",
        "d.consent_audit_id as consent_audit_id",
        db.raw("a.payload->>'recipient_pii_id' as recipient_pii_id"),
        "d.market_id as market_id",
        "d.outcome as outcome",
        "d.dispatched_at as dispatched_at",
        "d.provider_ref as provider_ref",
        "d.latency_ms as latency_ms",
        "d.created_at as delivery_created_at",
      ])
      .where("d.market_id", MARKET_ID)
      .whereRaw("a.payload->>'order_id' = ?", [ORDER_ID])
      .orderBy("d.created_at", "desc")
      .first();

    const events = new CapturingEvents();
    const service = new VoucherPiiService({
      pii: new PgVoucherPiiAdapter(db),
      audit: new PgAuditAdapter(db),
      delivery: new PgDeliveryAdapter(db),
      events,
      idempotency: createInProcessIdempotencyPort(),
      rateLimit: createInProcessRateLimitPort(),
    });

    let consentAuditId = existing?.consent_audit_id;
    let deliveryDecisionId = existing?.delivery_decision_id;
    let recipientPiiId = existing?.recipient_pii_id ?? undefined;
    let reusedExisting = Boolean(existing);

    if (!existing) {
      const consent = await service.recordConsentTransaction({
        market_id: MARKET_ID,
        order_id: ORDER_ID,
        entitlement_id: ENTITLEMENT_ID,
        recipient_email: null,
        recipient_phone: null,
        locale: LOCALE,
        is_gift: false,
        request_id: REQUEST_ID,
      });
      consentAuditId = consent.consent_audit_id;
      deliveryDecisionId = consent.delivery_decision_id;
      recipientPiiId = consent.recipient_pii_id;
      reusedExisting = false;
    }

    if (!consentAuditId || !deliveryDecisionId || !recipientPiiId) {
      throw new Error("Cannot resolve consent/delivery identifiers for proof run");
    }

    const current = await db("voucher_delivery_decision")
      .where({ id: deliveryDecisionId })
      .first();

    if (current?.outcome !== "dispatched") {
      await service.executeDeliveryStep({
        consent_audit_id: consentAuditId,
        market_id: MARKET_ID,
        recipient_id: recipientPiiId,
        request_id: REQUEST_ID,
        delivery_decision_id: deliveryDecisionId,
        delivery_attempt_n: Number(current?.delivery_attempt_n ?? 0),
      });
    }

    const proof = await db("voucher_delivery_decision as d")
      .join("voucher_pii_consent_audit as a", "a.id", "d.consent_audit_id")
      .select([
        "d.id as delivery_decision_id",
        "d.consent_audit_id as consent_audit_id",
        db.raw("a.payload->>'recipient_pii_id' as recipient_pii_id"),
        "d.market_id as market_id",
        "d.delivery_attempt_n as delivery_attempt_n",
        "d.outcome as outcome",
        "d.dispatched_at as dispatched_at",
        "d.provider_ref as provider_ref",
        "d.latency_ms as latency_ms",
        "d.created_at as delivery_created_at",
      ])
      .where("d.id", deliveryDecisionId)
      .first();

    const auditRows = await db("voucher_pii_consent_audit")
      .select(["id", "market_id", "payload", "created_at"])
      .where("market_id", MARKET_ID)
      .where(function () {
        this.where({ id: consentAuditId }).orWhereRaw(
          "payload->>'delivery_decision_id' = ?",
          [deliveryDecisionId]
        );
      })
      .orderBy("created_at", "asc");

    const payload = {
      story: "1.10",
      generated_at: new Date().toISOString(),
      reused_existing: reusedExisting,
      order_id: ORDER_ID,
      entitlement_id: ENTITLEMENT_ID,
      delivery: proof,
      audit_chain: auditRows.map((row) => ({
        id: row.id,
        market_id: row.market_id,
        created_at: row.created_at,
        payload:
          typeof row.payload === "string" ? JSON.parse(row.payload) : row.payload,
      })),
      emitted_events: events.events.map(safeEvent),
      pii_redaction: "recipient_email and recipient_phone were not stored for this proof run",
    };

    mkdirSync(dirname(OUT_PATH), { recursive: true });
    writeFileSync(OUT_PATH, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  } finally {
    await db.destroy();
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
