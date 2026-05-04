# Local pnpm patches

This directory holds GP-local upstream patches managed via `pnpm patch` /
`pnpm patch-commit`. Patches are activated via `patchedDependencies` in
`pnpm-workspace.yaml` and applied automatically on `pnpm install`.

**Policy reference:** `~/.claude/projects/-home-robsz-prj-GP/memory/feedback_mercur_local_patches_policy.md`
("Mercur upstream bugs ZAWSZE solved via local pnpm patch w patches/, NIGDY
upstream issue/wait-for-fix" — but every patch SHOULD have an upstream issue
filed for tracking).

---

## Active patches

### `@mercurjs__core@2.1.1.patch`

| Field | Value |
|---|---|
| **Target** | `@mercurjs/core@2.1.1` |
| **Author** | GP Sprint 1 (Story 1.10 Robert Opcja 1, 2026-05-02) |
| **Story** | `v160-1-7-1-mercur-1-2-schema-port-physical-drops` (Layer B) |
| **Bug surface** | Storefront `/store/products` returns 500 (MikroORM CriteriaNode crash) when `applySellerVisibilityFilter` injects `filterableFields.seller.status` (or even `seller_id`) because `Product.seller` is a module link, not direct ORM relation |
| **Fix** | Rewrite middleware async: pre-fetch open seller IDs + their products via `query.graph` link traversal, collect visible product IDs, filter by `Product.id $in [...]`. Refined in cleanup-11 (Story 8.8 AC6) — earlier seller_id filter still crashed CriteriaNode. |
| **Upstream issue** | TODO — to be filed at `mercurjs/mercur` (story `v160-cleanup-2`) |
| **Expiry condition** | Remove when Mercur ≥ 2.2.0 ships native fix; verify by reverting patch + running `__tests__/patches/mercur-core-visibility-filter.integration.spec.ts` |
| **Last verified** | 2026-05-04 (story v160-8-8 AC6 live E2E — `/store/products` returns 10 products via patched filter) |
| **Regression test** | `__tests__/patches/mercur-core-visibility-filter.integration.spec.ts` (TODO — author in cleanup-2 execution phase) |

---

## Patch lifecycle

1. **Author** — `pnpm patch <pkg>@<version>` opens scratch dir; edit; `pnpm patch-commit <dir>`
2. **Verify** — patch file lands in `patches/`; `patchedDependencies` entry in `pnpm-workspace.yaml` updated
3. **Document** — add row to "Active patches" table above with: target, story, bug surface, fix summary, upstream issue URL (if filed), expiry condition, last-verified date
4. **Test** — author regression test under `__tests__/patches/<pkg>.integration.spec.ts` covering the patched semantics + edge cases
5. **CI guard** — `pnpm install --frozen-lockfile` validates patch hash; bump CI pnpm to ≥10 for `patchedDependencies` support
6. **Maintenance** — on upstream bump, re-verify patch applicability; if upstream fixed, remove patch + entry + close upstream issue
7. **Audit cadence** — review all entries in this README at sprint close-out; flag any "last verified" > 30 days old

---

## CI freshness guard (TODO — story v160-cleanup-2 AC4)

Add validator `_grow/tools/validate_mercur_patch_freshness.py`:

- Parse `patches/*.patch` filenames → expected versions
- Cross-check `pnpm-workspace.yaml` `patchedDependencies` map
- Fail CI if `@mercurjs/*` version in lockfile != patched version without `PATCH_REVIEWED=true` env override
