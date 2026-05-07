/**
 * voucher-pdf-storage loader — registers `voucher_pdf_storage` key in the
 * Medusa awilix container (cleanup-52 / TF-117).
 *
 * Adapter selection via VOUCHER_PDF_STORAGE_BACKEND env:
 *   - "filesystem" (default) — FilesystemVoucherPdfStorage
 *     Sandboxed root: VOUCHER_PDF_STORAGE_ROOT (default: /tmp/voucher-pdf-storage)
 *   - "postgres"             — PgVoucherPdfStorage
 *     Requires PG_CONNECTION in Medusa container.
 *
 * Retention: VOUCHER_PDF_RETENTION_DAYS (default 90 days).
 *
 * Pattern: mirrors voucher-pii loader (cleanup-44); register as singleton,
 * resolve in route/step via container.resolve("voucher_pdf_storage").
 *
 * @see TF-117, cleanup-52
 * @see loaders/voucher-pii.ts (pattern reference)
 */

import { asValue } from "awilix";
import type { MedusaContainer } from "@medusajs/types";
import { ContainerRegistrationKeys } from "@medusajs/framework/utils";
import type { Knex } from "knex";

import { FilesystemVoucherPdfStorage } from "../modules/voucher-delivery/storage/adapters/filesystem-storage";
import {
  PgVoucherPdfStorage,
  ensureVoucherDeliveryArtifactTable,
} from "../modules/voucher-delivery/storage/adapters/pg-storage";
import type { IVoucherPdfStorage } from "../modules/voucher-delivery/storage/ports";

const CONTAINER_KEY = "voucher_pdf_storage";
const DEFAULT_STORAGE_ROOT = "/tmp/voucher-pdf-storage";

export default async function voucherPdfStorageLoader({
  container,
}: {
  container: MedusaContainer;
}): Promise<void> {
  const backend =
    process.env["VOUCHER_PDF_STORAGE_BACKEND"] ?? "filesystem";

  // Review fix M3: parse retention strictly; reject 0 / negatives / NaN and
  // fall back to default (90). Adapters apply the same rule defensively.
  const envRetention = parseInt(
    process.env["VOUCHER_PDF_RETENTION_DAYS"] ?? "",
    10,
  );
  const retentionDays =
    Number.isFinite(envRetention) && envRetention > 0 ? envRetention : 90;

  // Resolve logger — graceful degradation if absent.
  let logger:
    | {
        debug?: (msg: string, meta?: unknown) => void;
        warn?: (msg: string, meta?: unknown) => void;
      }
    | undefined;
  try {
    logger = container.resolve(
      ContainerRegistrationKeys.LOGGER,
    ) as typeof logger;
  } catch {
    logger = undefined;
  }

  let storage: IVoucherPdfStorage;

  if (backend === "postgres") {
    // Resolve Knex — fail loud if missing (consistent with voucher-pii loader).
    let db: Knex;
    try {
      db = container.resolve(
        ContainerRegistrationKeys.PG_CONNECTION,
      ) as Knex;
    } catch (err) {
      throw new Error(
        `[voucher-pdf-storage loader] Cannot resolve PG_CONNECTION from ` +
          `Medusa container. Ensure the database is configured before this ` +
          `loader runs. Original error: ${(err as Error).message}`,
      );
    }

    // Ensure the artifact table exists (idempotent).
    await ensureVoucherDeliveryArtifactTable(db);

    // Review fix L7: forward logger to adapter for store/retrieve/purge debug.
    storage = new PgVoucherPdfStorage(db, retentionDays, logger);
    logger?.debug?.("[voucher-pdf-storage loader] PgVoucherPdfStorage initialised");
  } else {
    // Default: filesystem adapter.
    const storageRoot =
      process.env["VOUCHER_PDF_STORAGE_ROOT"] ?? DEFAULT_STORAGE_ROOT;
    storage = new FilesystemVoucherPdfStorage(storageRoot, retentionDays, logger);
    logger?.debug?.(
      `[voucher-pdf-storage loader] FilesystemVoucherPdfStorage initialised at ${storageRoot}`,
    );
  }

  // Register in Medusa container as singleton.
  (
    container as unknown as {
      register: (key: string, val: unknown) => void;
    }
  ).register(CONTAINER_KEY, asValue(storage));

  logger?.debug?.(
    `[voucher-pdf-storage loader] ${CONTAINER_KEY} registered (backend=${backend})`,
  );
}
