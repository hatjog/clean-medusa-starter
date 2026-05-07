/**
 * voucher-pii loader — registers `voucher_pii` key in Medusa container
 * (cleanup-44 / TF-105).
 *
 * This loader wires the VoucherPiiService as a singleton in the Medusa
 * awilix container. Without this registration the service resolves to null
 * and `POST /store/voucher-pii-consent` returns 503.
 *
 * Port adapters:
 *   - pii:         PgVoucherPiiAdapter (Postgres)
 *   - audit:       PgAuditAdapter (Postgres, D-67 hash chain)
 *   - delivery:    PgDeliveryAdapter (Postgres)
 *   - events:      InProcessEventEmitter (no-op stub; v1.7.0: real EventBus)
 *   - idempotency: InMemoryIdempotencyAdapter singleton (v1.7.0: Redis)
 *   - rateLimit:   InMemoryTokenBucketAdapter singleton (v1.7.0: Redis)
 *
 * OQ resolutions:
 *   OQ#1 (adapter): Opcja A — in-memory token bucket (single-process staging)
 *   OQ#2 (events):  Opcja A — no-op stub (EventBus wiring deferred v1.7.0)
 *   OQ#3 (idem):    Opcja A — in-memory (single-process staging)
 *   OQ#4 (resolve): req.scope.resolve("voucher_pii") in route.ts (already correct)
 *   OQ#5 (migrate): no new migration; STORY-2-2 tables are sufficient
 *
 * Refs: TF-105, cleanup-44, D-66, D-67, D-72
 */

import { asValue } from "awilix";
import type { MedusaContainer } from "@medusajs/types";
import { ContainerRegistrationKeys } from "@medusajs/framework/utils";
import type { Knex } from "knex";

import { PgVoucherPiiAdapter } from "../modules/voucher-pii/adapters/pg-pii";
import { PgAuditAdapter } from "../modules/voucher-pii/adapters/pg-audit";
import { PgDeliveryAdapter } from "../modules/voucher-pii/adapters/pg-delivery";
import { InProcessEventEmitter } from "../modules/voucher-pii/adapters/in-process-events";
import { createInProcessIdempotencyPort } from "../modules/voucher-pii/adapters/pg-idempotency";
import { createInProcessRateLimitPort } from "../modules/voucher-pii/adapters/in-memory-rate-limit";
import { VoucherPiiService } from "../modules/voucher-pii/voucher-pii.service";

export default async function voucherPiiLoader({
  container,
}: {
  container: MedusaContainer;
}): Promise<void> {
  // Resolve Knex from Medusa container — required; fail loud if missing (AC6).
  let db: Knex;
  try {
    db = container.resolve(ContainerRegistrationKeys.PG_CONNECTION) as Knex;
  } catch (err) {
    throw new Error(
      `[voucher-pii loader] Cannot resolve PG_CONNECTION from Medusa container. ` +
        `Ensure the database is configured before this loader runs. ` +
        `Original error: ${(err as Error).message}`
    );
  }

  // Resolve logger — graceful degradation if absent.
  let logger: { debug?: (msg: string, meta?: unknown) => void } | undefined;
  try {
    logger = container.resolve(ContainerRegistrationKeys.LOGGER) as typeof logger;
  } catch {
    logger = undefined;
  }

  // Build port adapters.
  const pii = new PgVoucherPiiAdapter(db);
  const audit = new PgAuditAdapter(db);
  const delivery = new PgDeliveryAdapter(db);
  const events = new InProcessEventEmitter(logger);
  const idempotency = createInProcessIdempotencyPort();
  const rateLimit = createInProcessRateLimitPort();

  // Instantiate the service.
  const service = new VoucherPiiService({
    pii,
    audit,
    delivery,
    events,
    idempotency,
    rateLimit,
  });

  // Register in Medusa container as singleton.
  (container as unknown as { register: (key: string, val: unknown) => void }).register(
    "voucher_pii",
    asValue(service)
  );

  logger?.debug?.("[voucher-pii loader] voucher_pii service registered in container");
}
