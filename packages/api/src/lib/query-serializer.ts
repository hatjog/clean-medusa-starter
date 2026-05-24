/**
 * Canonical query string serializer for cross-workspace consistency (cc-4 F-18).
 *
 * Backend-authored reference implementation, intended to be **vendored** into
 * each frontend workspace (storefront, admin-panel, vendor-panel) so that
 * every panel produces the SAME query string for the SAME input shape.
 *
 * ## Rationale
 *
 * Pre-F-18 state (v1.9.0):
 *   - `GP/vendor-panel/src/lib/client/client.ts:90-125` — bespoke encoder
 *     that JSON.stringify-s objects and double-encodes them as
 *     `status=%5B%22draft%22%2C%22published%22%5D` (a JSON array as a single
 *     query value).
 *   - `GP/admin-panel` — relies on `@medusajs/js-sdk` (qs-based internally).
 *   - `GP/storefront/src/lib/config.ts:48-54` — hand-rolled string concat
 *     without consistent encoding for objects / arrays.
 *
 * Three different shapes for the SAME backend query parameter:
 *   - vendor:    `status=%5B%22draft%22%2C%22published%22%5D`
 *   - admin:     `status[]=draft&status[]=published` (qs default)
 *   - storefront: `status=draft,published` (or `status=[object Object]` for objs)
 *
 * Backend validators receive different shapes depending on panel → flaky
 * tests, runtime mismatch.
 *
 * ## Decision
 *
 * Canonical format: **`qs` library default with bracket notation for arrays
 * and nested objects** (matches Medusa SDK convention and is the de-facto
 * REST API standard). Brackets are URL-encoded as `%5B`/`%5D` on the wire
 * but decode to `[]` server-side (qs, Express, FastAPI all handle):
 *   - `{ status: ['draft', 'published'] }` →
 *       `status%5B%5D=draft&status%5B%5D=published`
 *       (semantically `status[]=draft&status[]=published`)
 *   - `{ filter: { name: 'foo', tags: ['a', 'b'] } }` →
 *       `filter%5Bname%5D=foo&filter%5Btags%5D%5B%5D=a&filter%5Btags%5D%5B%5D=b`
 *       (semantically `filter[name]=foo&filter[tags][]=a&filter[tags][]=b`)
 *   - `{ q: 'hello world' }` → `q=hello%20world`
 *   - `null` / `undefined` / `''` values: **skipped**.
 *
 * ## Usage (backend)
 *
 *   import { serializeQuery } from "@/lib/query-serializer";
 *   const params = serializeQuery({ status: ['draft', 'published'] });
 *   // → "status[]=draft&status[]=published"
 *
 * ## Vendoring to frontend workspaces (F-18 follow-up)
 *
 * Because GP/storefront, GP/admin-panel, GP/vendor-panel are git submodules
 * with isolated package.json files (not yet importing shared @gp/* packages),
 * this module is **vendored** (copy-pasted) into each workspace:
 *
 *   - `GP/storefront/src/lib/query-serializer.ts` (v1.10.0 follow-up)
 *   - `GP/admin-panel/src/lib/query-serializer.ts` (v1.10.0 follow-up)
 *   - `GP/vendor-panel/src/lib/query-serializer.ts` (v1.10.0 follow-up)
 *
 * After vendoring, each panel's `fetchQuery` / equivalent calls
 * `serializeQuery(query)` instead of bespoke logic.
 *
 * Validator (v1.10.0): `_grow/tools/validate_query_serializer_consistency.py`
 *   - Asserts each panel's vendored copy is byte-identical to this canonical
 *     reference (modulo import statements).
 *
 * ## References
 *
 * - cc-4 F-18 finding (v1.9.0): three serializers across panels.
 * - `qs` lib (https://github.com/ljharb/qs) — used by Medusa SDK internally.
 * - ADR-109a (parallel): admin/vendor cross-market contract — uniform query
 *   shape required for validator parsing of market_id, capability headers.
 *
 * @module query-serializer
 */

/**
 * Serialize an object into a URL-encoded query string using bracket notation
 * for arrays and nested objects (the de-facto REST convention; matches
 * Medusa SDK internal serialization).
 *
 * @param query Object of key→value pairs. Values may be string, number,
 *              boolean, array, nested object, null, or undefined.
 * @returns Query string WITHOUT leading `?`. Empty string if query is empty
 *          or all values are null/undefined/''.
 *
 * @example
 *   serializeQuery({ status: ['draft', 'published'], page: 2 })
 *   // → "status[]=draft&status[]=published&page=2"
 *
 *   serializeQuery({ filter: { name: 'foo', tags: ['a', 'b'] } })
 *   // → "filter[name]=foo&filter[tags][]=a&filter[tags][]=b"
 *
 *   serializeQuery({ empty: null, blank: '', skip: undefined, keep: 0 })
 *   // → "keep=0"
 */
export function serializeQuery(
  query: Record<string, unknown> | undefined | null,
): string {
  if (!query) return ""
  const parts: string[] = []
  for (const [key, value] of Object.entries(query)) {
    appendParam(parts, key, value)
  }
  return parts.join("&")
}

/**
 * Recursive append helper. Handles:
 *   - null / undefined / '' → skip
 *   - primitive (string/number/boolean) → `key=encoded`
 *   - array → `key[]=item0&key[]=item1` (recursive for nested arrays/objects)
 *   - object → `key[subkey]=value` (recursive)
 */
function appendParam(parts: string[], key: string, value: unknown): void {
  if (value === null || value === undefined || value === "") return

  if (Array.isArray(value)) {
    for (const item of value) {
      appendParam(parts, `${key}[]`, item)
    }
    return
  }

  if (typeof value === "object") {
    for (const [subkey, subvalue] of Object.entries(value as Record<string, unknown>)) {
      appendParam(parts, `${key}[${subkey}]`, subvalue)
    }
    return
  }

  // Primitive: string, number, boolean.
  parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
}

/**
 * Build a full URL with serialized query string.
 *
 * @param baseUrl Base URL (e.g., "https://api.gp.local").
 * @param path Path with leading slash (e.g., "/admin/sellers").
 * @param query Optional query object (serialized via serializeQuery).
 * @returns Full URL with `?` separator if query non-empty.
 *
 * @example
 *   buildUrl("https://api.gp.local", "/admin/sellers", { status: ['active'] })
 *   // → "https://api.gp.local/admin/sellers?status[]=active"
 */
export function buildUrl(
  baseUrl: string,
  path: string,
  query?: Record<string, unknown> | null,
): string {
  const params = serializeQuery(query)
  return params ? `${baseUrl}${path}?${params}` : `${baseUrl}${path}`
}
