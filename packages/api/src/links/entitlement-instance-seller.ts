import SellerModule from "@mercurjs/core/modules/seller"
import { defineLink } from "@medusajs/framework/utils"

import { VOUCHER_MODULE } from "../modules/voucher"

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
