import type { MedusaContainer } from "@medusajs/types"

/**
 * cc-4 finding F-11: refuse to boot when `NODE_ENV=production` is paired
 * with `ALLOW_TEST_ENDPOINTS=true`. The combination would expose
 * `/admin/e2e-flag-toggle` (and any sibling test-only endpoint that
 * defers to the same env gate) on a public host — the `X-Test-Mode`
 * header is the only remaining barrier in that combination.
 *
 * Catching the misconfiguration at boot ensures it cannot silently land
 * in a production environment via a stray env var. Operators who
 * deliberately need a test endpoint on a hardened staging host should
 * keep `NODE_ENV` set to a non-production value (e.g. `staging`).
 */
export default async function testEndpointProdGuard(_args: {
  container: MedusaContainer
}): Promise<void> {
  if (
    process.env.NODE_ENV === "production" &&
    process.env.ALLOW_TEST_ENDPOINTS === "true"
  ) {
    throw new Error(
      "Refusing to boot: NODE_ENV=production AND ALLOW_TEST_ENDPOINTS=true. " +
        "Set ALLOW_TEST_ENDPOINTS=false (or unset) in production. " +
        "See packages/api/src/api/admin/e2e-flag-toggle/route.ts (cc-4 F-11).",
    )
  }
}
