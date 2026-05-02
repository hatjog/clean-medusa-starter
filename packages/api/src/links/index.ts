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
