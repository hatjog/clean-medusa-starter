import SellerModule from "@mercurjs/core/modules/seller"
import { defineLink } from "@medusajs/framework/utils"

import { VOUCHER_MODULE } from "../modules/voucher"

/**
 * Story 9.3 (v1.10.0) — `entitlement_instance ↔ seller` module link.
 *
 * NOTE (review F-02 follow-up, 2026-05-28):
 * The voucher module is SQL-backed (no Medusa entity registry / DML
 * service layer) and therefore does not expose
 * `VoucherModule.linkable.entitlement_instance` via Medusa Framework's
 * canonical entity introspection. The literal linkable surface declared
 * below mirrors the convention used by other Mercur module links built on
 * raw SQL tables (cf. `links/index.ts`) and registers the link record so
 * that future ADR-099 Layer 4 traversals (via `query.graph(...)`) can rely
 * on it once `entitlement_instance` gains real FKs to `seller_id` / a
 * pivot table.
 *
 * The Story 9.3 buyer-notification subscriber does NOT consume this link
 * at runtime — it reads through `VoucherService.findBuyerClaimSource`
 * (SQL JOIN voucher × public.order × voucher_event), which is the
 * functionally-correct ADR-052 cutover path per Dev Notes §R3.
 *
 * Removing this link is deferred to ADR-099 follow-up when Layer 4 gains
 * either physical FK columns (`entitlement_instance.seller_id`) or a
 * pivot table seeded by an issue workflow.
 */
const entitlementInstanceLinkable = {
  id: {
    serviceName: VOUCHER_MODULE,
    field: "entitlement_instance",
    linkable: "entitlement_instance_id",
    primaryKey: "id",
  },
  toJSON: () => ({
    serviceName: VOUCHER_MODULE,
    field: "entitlement_instance",
    linkable: "entitlement_instance_id",
    primaryKey: "id",
  }),
}

export default defineLink(
  entitlementInstanceLinkable,
  SellerModule.linkable.seller,
)
