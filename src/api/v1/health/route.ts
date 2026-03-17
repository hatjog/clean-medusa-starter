/**
 * API v1 health endpoint (DD-23)
 *
 * MedusaJS file-based routing: src/api/v1/health/route.ts → /v1/health
 */

import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";

export async function GET(
  _req: MedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  res.json({
    status: "ok",
    version: "v1",
    service: "gp_core",
  });
}
