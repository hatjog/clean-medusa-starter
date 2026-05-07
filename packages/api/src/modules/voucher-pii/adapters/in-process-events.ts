/**
 * in-process-events — EventEmitterPort stub adapter (cleanup-44 / TF-105).
 *
 * OQ #2 resolution: Opcja A — no-op stub for v1.6.0 staging-free deployment.
 * Real EventBus wiring is deferred to v1.7.0+ when the event infra is in place.
 *
 * PII redaction is enforced at this boundary (belt-and-suspenders): any
 * payload keys that could carry raw PII are scrubbed before logging.
 * The service layer should never pass raw PII in event payloads, but this
 * adapter enforces the constraint as a second layer.
 */

import type { EventEmitterPort } from "../ports";

const PII_KEYS = [
  "recipient_email",
  "recipient_phone",
  "email",
  "phone",
] as const;

function scrubPii(payload: Record<string, unknown>): Record<string, unknown> {
  const scrubbed = { ...payload };
  for (const key of PII_KEYS) {
    if (key in scrubbed) {
      scrubbed[key] = "[REDACTED]";
    }
  }
  return scrubbed;
}

export class InProcessEventEmitter implements EventEmitterPort {
  constructor(
    private readonly logger?: {
      debug?: (msg: string, meta?: unknown) => void;
    }
  ) {}

  async emit(event: {
    event_type: string;
    market_id: string;
    payload: Record<string, unknown>;
  }): Promise<void> {
    // Scrub PII at log boundary (belt-and-suspenders).
    const safePayload = scrubPii(event.payload);
    this.logger?.debug?.("voucher-pii event (stub)", {
      event_type: event.event_type,
      market_id: event.market_id,
      payload: safePayload,
    });
    // v1.7.0: dispatch via MedusaJS EventBus module.
  }
}

/** Exported for tests — allows white-box assertion of scrubPii behavior. */
export { scrubPii };
