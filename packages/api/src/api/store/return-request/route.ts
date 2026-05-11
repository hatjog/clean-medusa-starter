import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";

export async function GET(_req: MedusaRequest, res: MedusaResponse) {
  res.json({
    order_return_requests: [],
    count: 0,
    offset: 0,
    limit: 50,
  });
}
