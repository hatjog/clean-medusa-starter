/**
 * packages/api/src/links/index.ts — Module link aggregator for v1.6.0 Phase A1.
 *
 * Story v160-1-10 finding: Medusa 2.13.x scanner reads `src/links/`
 * (legacy path); post-restructure (story 1.4) our links live at
 * `packages/api/src/links/`. Symlink at GP/backend/src/links →
 * packages/api/src/links bridges the gap.
 *
 * Mercur 2 (`@mercurjs/core@2.1.1`) ships its own module links under
 * `node_modules/@mercurjs/core/.medusa/server/src/links/` (product-seller,
 * promotion-seller, order-payout, etc.) but does NOT auto-register them via
 * plugin entry. We re-export them here so that the link loader picks them up
 * during Medusa boot and `Product.seller` (and friends) become queryable.
 *
 * Story v160-1-7-1 follow-up will replace the manual re-exports with
 * `withMercur(defineConfig(...))` wrapper after the modules array-form
 * conversion lands.
 */
export { default as productSellerLink } from "@mercurjs/core/links/product-seller-link"
export { default as promotionSellerLink } from "@mercurjs/core/links/promotion-seller-link"
export { default as orderGroupCartLink } from "@mercurjs/core/links/order-group-cart-link"
export { default as orderPayoutLink } from "@mercurjs/core/links/order-payout-link"
export { default as priceListSellerLink } from "@mercurjs/core/links/price-list-seller-link"
export { default as sellerMemberRbacRoleLink } from "@mercurjs/core/links/seller-member-rbac-role"

/**
 * NOTE (v1.10.0 boot-fix): the Story 9.3 `entitlement_instance ↔ {seller,product}`
 * module links were removed here. The voucher module is SQL-backed and does NOT
 * expose a real Medusa linkable surface for `entitlement_instance`, so the
 * hand-rolled literal linkable was rejected by Medusa 2.14.2's link loader at boot
 * ("Key entitlement_instance_id is not linkable on service voucher"), crashing
 * `medusa develop`. These links were documented as forward-compat only and were
 * NOT consumed at runtime (Story 9.3 reads via `VoucherService.findBuyerClaimSource`
 * SQL JOIN). Re-introduce them under ADR-099 Layer 4 once `entitlement_instance`
 * gains a real linkable surface (physical FKs or a pivot table). See git history of
 * `entitlement-instance-{seller,product}.ts` for the original rationale.
 */
