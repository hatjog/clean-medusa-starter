import ProductModule from "@medusajs/medusa/product"
import { defineLink } from "@medusajs/framework/utils"

import { VOUCHER_MODULE } from "../modules/voucher"

/**
 * Story 9.3 (v1.10.0) — `entitlement_instance ↔ product` module link.
 *
 * NOTE (review F-02 follow-up, 2026-05-28):
 * See `entitlement-instance-seller.ts` header — same forward-compat
 * caveat applies. The Story 9.3 buyer-notification subscriber resolves
 * `product_title` via the denormalized `voucher.product_title` column
 * (already populated by the voucher creation flow); it does NOT traverse
 * this link at runtime. The link is registered to keep Layer 4 join
 * surface declared for ADR-099 follow-up work.
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
  ProductModule.linkable.product,
)
