/**
 * Story v160-6-5: Maps deeplink builders — ported backend-side from
 * storefront Story v160-4-5 (`GP/storefront/src/lib/helpers/maps-deeplink.ts`).
 *
 * Why port (instead of cross-import): backend voucher-delivery module CANNOT
 * import storefront sources (Next.js workspace boundary; barrel + node_*
 * leak risks). The deeplink contract is a pure URL-string template with
 * stable encoding semantics — duplicating ~80 LOC is the acceptable cost for
 * preserving the workspace isolation invariant. Both copies share an
 * identical contract test footprint (same encoding, same fallback paths)
 * so behaviour drift would be caught by either side's CI.
 *
 * Contract refs (canonical Apr 2026):
 *   - Google Maps URLs: /maps/dir/?api=1&destination=<lat>,<lng> + name as &query
 *   - Apple Maps URLs:  /?daddr=<lat>,<lng> + name as &q
 *   - Search fallback:  /maps/search/?api=1&query=<text>  ||  /?q=<text>
 *
 * URL encoding: `encodeURIComponent` defensively for ALL values (lat/lng
 * numbers don't strictly need encoding but name/address can carry spaces,
 * accents, punctuation — the helper enforces uniformly).
 */

export type LatLng = {
  lat: number
  lng: number
}

export type DeeplinkProvider = "google" | "apple"

export function buildGoogleMapsDeeplink({
  lat,
  lng,
  name,
}: LatLng & { name?: string }): string {
  const base = "https://www.google.com/maps/dir/?api=1"
  const dest = `&destination=${encodeURIComponent(`${lat},${lng}`)}`
  const label = name ? `&query=${encodeURIComponent(name)}` : ""
  return `${base}${dest}${label}`
}

export function buildAppleMapsDeeplink({
  lat,
  lng,
  name,
}: LatLng & { name?: string }): string {
  const base = "https://maps.apple.com/"
  const dest = `?daddr=${encodeURIComponent(`${lat},${lng}`)}`
  const label = name ? `&q=${encodeURIComponent(name)}` : ""
  return `${base}${dest}${label}`
}

export function buildSearchFallbackDeeplink({
  provider,
  name,
  address,
}: {
  provider: DeeplinkProvider
  name: string
  address: string
}): string {
  const query = encodeURIComponent(`${address}, ${name}`)
  if (provider === "google") {
    return `https://www.google.com/maps/search/?api=1&query=${query}`
  }
  return `https://maps.apple.com/?q=${query}`
}
