/**
 * Unit tests for canonical query serializer (cc-4 F-18).
 *
 * Asserts the bracket-notation REST convention used across all GP workspaces
 * (backend reference; vendored copies in storefront/admin-panel/vendor-panel).
 */

import { serializeQuery, buildUrl } from "../../lib/query-serializer"

describe("serializeQuery", () => {
  it("returns empty string for null/undefined/empty input", () => {
    expect(serializeQuery(null)).toBe("")
    expect(serializeQuery(undefined)).toBe("")
    expect(serializeQuery({})).toBe("")
  })

  it("serializes a flat primitive object", () => {
    expect(serializeQuery({ name: "foo", page: 2, active: true })).toBe(
      "name=foo&page=2&active=true",
    )
  })

  it("skips null / undefined / empty-string values", () => {
    expect(
      serializeQuery({
        empty: null,
        blank: "",
        skip: undefined,
        keep: 0,
        name: "bar",
      }),
    ).toBe("keep=0&name=bar")
  })

  it("serializes arrays with bracket notation (URL-encoded brackets)", () => {
    // encodeURIComponent encodes `[` as %5B and `]` as %5D; qs, Express,
    // and Medusa SDK all decode `status%5B%5D=draft` → `status[]=draft`.
    expect(
      serializeQuery({ status: ["draft", "published"] }),
    ).toBe("status%5B%5D=draft&status%5B%5D=published")
  })

  it("serializes nested objects with bracket key path (URL-encoded)", () => {
    expect(
      serializeQuery({ filter: { name: "foo", tags: ["a", "b"] } }),
    ).toBe("filter%5Bname%5D=foo&filter%5Btags%5D%5B%5D=a&filter%5Btags%5D%5B%5D=b")
  })

  it("URL-encodes special characters in keys and values", () => {
    expect(serializeQuery({ "q field": "hello world" })).toBe(
      "q%20field=hello%20world",
    )
  })

  it("matches the F-18 canonical shape: bracket notation, not JSON-stringified", () => {
    // This is the exact shape the backend validators expect (matches Medusa
    // SDK default and qs library default). Brackets are URL-encoded as
    // %5B/%5D but decode to [] on the server.
    const out = serializeQuery({ status: ["draft", "published"] })
    expect(out).toContain("status%5B%5D=draft")
    expect(out).toContain("status%5B%5D=published")
    // Specifically NOT the vendor-panel pre-F-18 broken shape (JSON-stringified
    // array as a single value):
    expect(out).not.toContain("%5B%22draft%22%2C%22published%22%5D")
  })

  it("serializes boolean values as 'true'/'false' strings", () => {
    expect(serializeQuery({ active: false, paused: true })).toBe(
      "active=false&paused=true",
    )
  })
})

describe("buildUrl", () => {
  it("returns base+path with no query when query is empty", () => {
    expect(buildUrl("https://api.gp.local", "/admin/sellers")).toBe(
      "https://api.gp.local/admin/sellers",
    )
    expect(buildUrl("https://api.gp.local", "/admin/sellers", {})).toBe(
      "https://api.gp.local/admin/sellers",
    )
  })

  it("appends ?query when non-empty (with URL-encoded brackets)", () => {
    expect(
      buildUrl("https://api.gp.local", "/admin/sellers", { status: ["active"] }),
    ).toBe("https://api.gp.local/admin/sellers?status%5B%5D=active")
  })
})
