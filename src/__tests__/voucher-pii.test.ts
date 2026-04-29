/**
 * voucher-pii.test — STORY-2-2 unit tests for the 5-step contract + retention
 * helpers + idempotency + rate-limiter.
 *
 * Maps to:
 *   - AC-VPII-PIPE-2.2-01 → recordConsentTransaction happy path
 *   - AC-VPII-PIPE-2.2-03 → 5-step contract (audit confirmed / not confirmed)
 *   - AC-VPII-PIPE-2.2-03 → idempotency replay = no double-execute
 *   - AC-VPII-PIPE-2.2-04 → rate-limiter atomicity (in-memory adapter)
 *   - AC-VPII-PIPE-2.2-05 → PII redaction (allowlist + scrub)
 *
 * In-memory ports keep these tests DB-free; integration tests against a live
 * Postgres + Redis stack live in `integration-tests/` (TODO when harness up).
 */

import { describe, expect, test } from "@jest/globals";

import { InMemoryIdempotencyAdapter } from "../lib/idempotency";
import {
  redactPayload,
  scrubString,
  sentryBeforeSend,
} from "../lib/pii-redaction";
import { InMemoryTokenBucketAdapter } from "../lib/rate-limit-token-bucket";
import {
  ConsentAuditFailedError,
  type AuditChainPort,
  type ConsentStateSnapshot,
  type DeliveryDecisionPort,
  type DeliveryOutcome,
  type EventEmitterPort,
  type VoucherPiiPort,
} from "../modules/voucher-pii";
import { VoucherPiiService } from "../modules/voucher-pii/voucher-pii.service";

// ---------------------------------------------------------------------------
// Test doubles — in-memory ports.
// ---------------------------------------------------------------------------

class FakePiiPort implements VoucherPiiPort {
  public inserts: Array<Record<string, unknown>> = [];
  public tombstones: Array<{ market_id: string; order_id: string }> = [];
  private nextId = 1;

  async insertRecipientPii(input: {
    market_id: string;
    entitlement_id: string;
    order_id: string;
    recipient_email: string | null;
    recipient_phone: string | null;
    locale: string;
    is_gift: boolean;
  }): Promise<{ recipient_pii_id: string }> {
    const recipient_pii_id = `pii_${this.nextId++}`;
    this.inserts.push({ ...input, recipient_pii_id });
    return { recipient_pii_id };
  }

  async tombstoneByOrder(args: {
    market_id: string;
    order_id: string;
  }): Promise<{ rows_affected: number }> {
    this.tombstones.push(args);
    return { rows_affected: 1 };
  }

  async purgeByMarketBefore(_args: {
    market_id: string;
    cutoff: Date;
    batch_size: number;
  }): Promise<{ rows_deleted: number }> {
    return { rows_deleted: 0 };
  }

  async cleanupOrphans(_args: {
    batch_size: number;
  }): Promise<{ rows_deleted: number }> {
    return { rows_deleted: 0 };
  }
}

class FakeAuditPort implements AuditChainPort {
  public rows: Array<{ id: string; payload: Record<string, unknown> }> = [];
  public confirmed: Map<string, ConsentStateSnapshot> = new Map();
  private nextId = 1;
  /** When set, readAfterWrite returns null to simulate audit failure. */
  public forceUnconfirmed = false;

  async appendAuditRow(args: {
    market_id: string;
    payload: Record<string, unknown>;
  }): Promise<{ audit_id: string }> {
    const audit_id = `audit_${this.nextId++}`;
    this.rows.push({ id: audit_id, payload: args.payload });
    if (args.payload.action === "GRANTED") {
      this.confirmed.set(audit_id, {
        consent_audit_id: audit_id,
        market_id: args.market_id,
        recipient_pii_id: String(args.payload.recipient_pii_id ?? ""),
        audit_confirmed: true,
      });
    }
    return { audit_id };
  }

  async getLatestForOrder(_args: {
    market_id: string;
    order_id: string;
  }): Promise<ConsentStateSnapshot | null> {
    return null;
  }

  async readAfterWrite(args: {
    consent_audit_id: string;
  }): Promise<ConsentStateSnapshot | null> {
    if (this.forceUnconfirmed) return null;
    return this.confirmed.get(args.consent_audit_id) ?? null;
  }
}

class FakeDeliveryPort implements DeliveryDecisionPort {
  public rows: Array<{
    delivery_decision_id: string;
    consent_audit_id: string;
    outcome: DeliveryOutcome | null;
    latency_ms: number | null;
    provider_ref: string | null;
    delivery_attempt_n: number;
  }> = [];
  private nextId = 1;

  async insertPending(args: {
    consent_audit_id: string;
    market_id: string;
  }): Promise<{ delivery_decision_id: string }> {
    const delivery_decision_id = `dd_${this.nextId++}`;
    this.rows.push({
      delivery_decision_id,
      consent_audit_id: args.consent_audit_id,
      outcome: null,
      latency_ms: null,
      provider_ref: null,
      delivery_attempt_n: 0,
    });
    return { delivery_decision_id };
  }

  async recordOutcome(args: {
    delivery_decision_id: string;
    outcome: DeliveryOutcome;
    latency_ms: number;
    provider_ref: string | null;
    delivery_attempt_n: number;
  }): Promise<void> {
    const row = this.rows.find(
      (r) => r.delivery_decision_id === args.delivery_decision_id
    );
    if (row) {
      row.outcome = args.outcome;
      row.latency_ms = args.latency_ms;
      row.provider_ref = args.provider_ref;
      row.delivery_attempt_n = args.delivery_attempt_n;
    }
  }
}

class FakeEvents implements EventEmitterPort {
  public events: Array<{
    event_type: string;
    market_id: string;
    payload: Record<string, unknown>;
  }> = [];
  async emit(event: {
    event_type: string;
    market_id: string;
    payload: Record<string, unknown>;
  }): Promise<void> {
    this.events.push(event);
  }
}

function buildService(): {
  service: VoucherPiiService;
  pii: FakePiiPort;
  audit: FakeAuditPort;
  delivery: FakeDeliveryPort;
  events: FakeEvents;
  idempotency: InMemoryIdempotencyAdapter;
  rateLimit: InMemoryTokenBucketAdapter;
} {
  const pii = new FakePiiPort();
  const audit = new FakeAuditPort();
  const delivery = new FakeDeliveryPort();
  const events = new FakeEvents();
  const idempotency = new InMemoryIdempotencyAdapter();
  const rateLimit = new InMemoryTokenBucketAdapter();
  const service = new VoucherPiiService({
    pii,
    audit,
    delivery,
    events,
    idempotency,
    rateLimit,
  });
  return { service, pii, audit, delivery, events, idempotency, rateLimit };
}

// ---------------------------------------------------------------------------
// AC-VPII-PIPE-2.2-01 — recordConsentTransaction happy path.
// ---------------------------------------------------------------------------

describe("recordConsentTransaction (AC-VPII-PIPE-2.2-01)", () => {
  test("inserts PII row + audit row + delivery decision in chained order", async () => {
    const { service, pii, audit, delivery, events } = buildService();
    const result = await service.recordConsentTransaction({
      market_id: "bonbeauty",
      order_id: "ord_001",
      entitlement_id: "ent_001",
      recipient_email: "redacted-test@example.com",
      recipient_phone: "+48500111222",
      locale: "pl",
      is_gift: true,
      request_id: "req_xyz",
    });

    expect(result.consent_audit_id).toBe("audit_1");
    expect(result.recipient_pii_id).toBe("pii_1");
    expect(result.delivery_decision_id).toBe("dd_1");
    expect(result.state_machine_state).toBe("delivery-decision-recorded");

    expect(pii.inserts).toHaveLength(1);
    expect(audit.rows).toHaveLength(1);
    expect(delivery.rows).toHaveLength(1);

    // Audit payload references PII row by id — NEVER inline email/phone.
    const auditPayload = audit.rows[0].payload;
    expect(auditPayload.recipient_pii_id).toBe("pii_1");
    expect(auditPayload).not.toHaveProperty("recipient_email");
    expect(auditPayload).not.toHaveProperty("recipient_phone");

    // Event emitted with id-references only.
    expect(events.events).toHaveLength(1);
    const emitted = events.events[0];
    expect(emitted.event_type).toBe("gp.voucher.consent_recorded.v1");
    expect(emitted.payload.outcome).toBe("granted");
    expect(emitted.payload).not.toHaveProperty("recipient_email");
    expect(emitted.payload).not.toHaveProperty("recipient_phone");
  });

  test("idempotency replay returns same result without re-INSERTing", async () => {
    const { service, pii, audit, delivery } = buildService();
    const input = {
      market_id: "bonbeauty",
      order_id: "ord_002",
      entitlement_id: "ent_002",
      recipient_email: null,
      recipient_phone: null,
      locale: "en",
      is_gift: false,
      request_id: "req_xyz_2",
    };
    const first = await service.recordConsentTransaction(input);
    const second = await service.recordConsentTransaction(input);

    expect(first.consent_audit_id).toBe(second.consent_audit_id);
    expect(pii.inserts).toHaveLength(1);
    expect(audit.rows).toHaveLength(1);
    expect(delivery.rows).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// AC-VPII-PIPE-2.2-03 — 5-step audit consistency contract.
// ---------------------------------------------------------------------------

describe("executeDeliveryStep (AC-VPII-PIPE-2.2-03)", () => {
  test("happy path: audit confirmed → dispatched + chained audit + event", async () => {
    const { service, audit, delivery, events } = buildService();
    const consent = await service.recordConsentTransaction({
      market_id: "bonbeauty",
      order_id: "ord_003",
      entitlement_id: "ent_003",
      recipient_email: null,
      recipient_phone: null,
      locale: "pl",
      is_gift: false,
      request_id: "req_a",
    });

    const result = await service.executeDeliveryStep({
      consent_audit_id: consent.consent_audit_id,
      market_id: "bonbeauty",
      recipient_id: consent.recipient_pii_id,
      request_id: "req_a",
      delivery_decision_id: consent.delivery_decision_id,
      delivery_attempt_n: 0,
    });

    expect(result.outcome).toBe("dispatched");
    expect(result.audit_chain_verified).toBe(true);
    expect(result.provider_ref).toBe("stub-email-v1");

    // Step 4 — chained DELIVERY_DECISION_RECORDED audit row written.
    const chainedRow = audit.rows.find(
      (r) => r.payload.action === "DELIVERY_DECISION_RECORDED"
    );
    expect(chainedRow).toBeDefined();
    expect(chainedRow!.payload.consent_audit_id).toBe(consent.consent_audit_id);

    // Delivery decision row terminal-stated.
    const ddRow = delivery.rows[0];
    expect(ddRow.outcome).toBe("dispatched");
    expect(ddRow.provider_ref).toBe("stub-email-v1");

    // Step 5 — observability event emitted.
    const dispatchedEvent = events.events.find(
      (e) => e.event_type === "gp.voucher.delivery_decision.v1"
    );
    expect(dispatchedEvent).toBeDefined();
    expect(dispatchedEvent!.payload.outcome).toBe("dispatched");
  });

  test("audit NOT confirmed → DLQ + state error-audit-failed + ZERO dispatched event", async () => {
    const { service, audit, delivery, events } = buildService();
    audit.forceUnconfirmed = true;

    await expect(
      service.executeDeliveryStep({
        consent_audit_id: "nonexistent_audit",
        market_id: "bonbeauty",
        recipient_id: "pii_x",
        request_id: "req_b",
        delivery_decision_id: "dd_x",
        delivery_attempt_n: 0,
      })
    ).rejects.toBeInstanceOf(ConsentAuditFailedError);

    // ZERO 'dispatched' outcome events emitted (only the 'dlq_audit_failed' one).
    const dispatched = events.events.filter(
      (e) => (e.payload as { outcome?: string }).outcome === "dispatched"
    );
    expect(dispatched).toHaveLength(0);

    // The DLQ outcome event WAS emitted (audit chain rejection signal).
    const dlqEvents = events.events.filter(
      (e) => (e.payload as { outcome?: string }).outcome === "dlq_audit_failed"
    );
    expect(dlqEvents).toHaveLength(1);

    expect(delivery.rows.length).toBe(0); // we never inserted dd_x via insertPending
  });

  test("rate-limit exhausted → dlq_rate_limited (no dispatch)", async () => {
    const { service, rateLimit, events } = buildService();
    // Force the recipient bucket to start empty by consuming all tokens upfront.
    // Default bucket size = 10; consume 10 first.
    for (let i = 0; i < 10; i++) {
      await rateLimit.consume({
        bucket_key: "rl:voucher:dispatch:bonbeauty:pii_4",
        bucket_size: 10,
        refill_per_min: 10,
      });
    }
    const consent = await service.recordConsentTransaction({
      market_id: "bonbeauty",
      order_id: "ord_004",
      entitlement_id: "ent_004",
      recipient_email: null,
      recipient_phone: null,
      locale: "pl",
      is_gift: false,
      request_id: "req_c",
    });
    // recipient_id = "pii_4" matches the bucket we drained above.
    const result = await service.executeDeliveryStep({
      consent_audit_id: consent.consent_audit_id,
      market_id: "bonbeauty",
      recipient_id: "pii_4",
      request_id: "req_c",
      delivery_decision_id: consent.delivery_decision_id,
      delivery_attempt_n: 0,
    });
    expect(result.outcome).toBe("dlq_rate_limited");
    const dispatched = events.events.filter(
      (e) => (e.payload as { outcome?: string }).outcome === "dispatched"
    );
    expect(dispatched).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// AC-VPII-PIPE-2.2-04 — rate-limiter atomicity.
// ---------------------------------------------------------------------------

describe("InMemoryTokenBucketAdapter (AC-VPII-PIPE-2.2-04)", () => {
  test("consumes 1 token per call until empty, then blocks", async () => {
    const bucket = new InMemoryTokenBucketAdapter(() => 1_000_000_000_000);
    const params = {
      bucket_key: "test",
      bucket_size: 3,
      refill_per_min: 1, // very slow refill (no spurious successes)
    };
    expect((await bucket.consume(params)).allowed).toBe(true);
    expect((await bucket.consume(params)).allowed).toBe(true);
    expect((await bucket.consume(params)).allowed).toBe(true);
    const fourth = await bucket.consume(params);
    expect(fourth.allowed).toBe(false);
    expect(fourth.retry_after_ms).toBeGreaterThan(0);
  });

  test("refills proportionally to elapsed time", async () => {
    let now = 0;
    const bucket = new InMemoryTokenBucketAdapter(() => now);
    const params = {
      bucket_key: "refill",
      bucket_size: 1,
      refill_per_min: 60, // 1 per second
    };
    // Drain the bucket.
    expect((await bucket.consume(params)).allowed).toBe(true);
    expect((await bucket.consume(params)).allowed).toBe(false);
    // Advance 1 second — bucket should refill exactly 1 token.
    now += 1000;
    expect((await bucket.consume(params)).allowed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// AC-VPII-PIPE-2.2-03 — idempotency wrapper replay.
// ---------------------------------------------------------------------------

describe("InMemoryIdempotencyAdapter (AC-VPII-PIPE-2.2-03)", () => {
  test("replay returns cached result without re-executing fn", async () => {
    const idem = new InMemoryIdempotencyAdapter();
    let calls = 0;
    const fn = async () => {
      calls++;
      return { value: "x" };
    };
    const a = await idem.withIdempotency("k1", 60, fn);
    const b = await idem.withIdempotency("k1", 60, fn);
    expect(calls).toBe(1);
    expect(a).toEqual(b);
  });

  test("throwing fn releases the lock so subsequent attempts re-execute", async () => {
    const idem = new InMemoryIdempotencyAdapter();
    let calls = 0;
    await expect(
      idem.withIdempotency("k2", 60, async () => {
        calls++;
        throw new Error("boom");
      })
    ).rejects.toThrow("boom");
    await idem.withIdempotency("k2", 60, async () => {
      calls++;
      return { value: "ok" };
    });
    expect(calls).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// AC-VPII-PIPE-2.2-05 — PII redaction.
// ---------------------------------------------------------------------------

describe("pii-redaction (AC-VPII-PIPE-2.2-05)", () => {
  test("scrubString redacts email + E.164 phone patterns", () => {
    expect(scrubString("contact me at user@example.com or +48500111222")).toBe(
      "contact me at [REDACTED] or [REDACTED]"
    );
  });

  test("redactPayload replaces non-allowlisted keys with [REDACTED]", () => {
    const payload = {
      market_id: "bonbeauty",
      order_id: "ord_1",
      recipient_email: "user@example.com",
      recipient_phone: "+48500111222",
      latency_ms: 123,
      payload: {
        request_id: "req_x",
        secret_token: "abc",
      },
    };
    const out = redactPayload(payload) as Record<string, unknown>;
    expect(out.market_id).toBe("bonbeauty");
    expect(out.order_id).toBe("ord_1");
    expect(out.recipient_email).toBe("[REDACTED]");
    expect(out.recipient_phone).toBe("[REDACTED]");
    expect(out.latency_ms).toBe(123);
    const inner = out.payload as Record<string, unknown>;
    expect(inner.request_id).toBe("req_x");
    expect(inner.secret_token).toBe("[REDACTED]");
  });

  test("sentryBeforeSend redacts message + contexts", () => {
    const ev = {
      message: "user@example.com triggered audit",
      contexts: {
        request: { recipient_email: "user@example.com", market_id: "bonbeauty" },
      },
    };
    const out = sentryBeforeSend(ev);
    expect(out.message).toBe("[REDACTED] triggered audit");
    const ctx = out.contexts!.request as Record<string, unknown>;
    expect(ctx.recipient_email).toBe("[REDACTED]");
    expect(ctx.market_id).toBe("bonbeauty");
  });

  test("synthetic 1k log lines — zero email/phone leakage (CI proxy)", () => {
    // Lightweight in-process proxy for the 1k synthetic test (full
    // integration with Sentry transport mock lives in
    // `integration-tests/pii-redaction.test.ts`). 1000 envelopes through the
    // redactor + scrubString — assertion: no literal patterns survive.
    const buffer: string[] = [];
    for (let i = 0; i < 1000; i++) {
      const payload = {
        market_id: "bonbeauty",
        recipient_email: `bonbeauty-test+pii-${i}@example.com`,
        recipient_phone: `+485001${String(i).padStart(5, "0")}`,
        request_id: `req_${i}`,
      };
      buffer.push(JSON.stringify(redactPayload(payload)));
      buffer.push(scrubString(`[log] ${payload.recipient_email} ${payload.recipient_phone}`));
    }
    const joined = buffer.join("\n");
    expect(joined).not.toMatch(/@example\.com/);
    expect(joined).not.toMatch(/\+48500/);
  });
});
