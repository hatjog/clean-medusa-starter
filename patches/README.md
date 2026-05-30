# Local pnpm patches

This directory holds GP-local upstream patches managed via `pnpm patch` /
`pnpm patch-commit`. Patches are activated via `patchedDependencies` in
`pnpm-workspace.yaml` and applied automatically on `pnpm install`.

**Policy reference:** `specs/constitution/upstream-policy.md`.
Mercur/Medusa bugs are solved by GP-owned fork commits or local `pnpm patch`
records. GP does not file public Mercur/Medusa issues or block stories on
external fixes.

---

## Active patches

### `@mercurjs__core@2.1.1.patch`

| Field | Value |
|---|---|
| **Target** | `@mercurjs/core@2.1.1` |
| **Author** | GP Sprint 1 (Story 1.10 Robert Opcja 1, 2026-05-02) |
| **Story** | `v160-1-7-1-mercur-1-2-schema-port-physical-drops` (Layer B); `v1.10.0-2.5-mercur-seller-localized-content` (Layer B Seller translations) |
| **Bug surface** | Storefront `/store/products` returns 500 (MikroORM CriteriaNode crash) when `applySellerVisibilityFilter` injects `filterableFields.seller.status` (or even `seller_id`) because `Product.seller` is a module link, not direct ORM relation. Mercur 2.1.1 also exposes Seller `name` and `description` as plain text DML fields, so Medusa Translation Module will not accept Seller translation settings for those fields unless the model marks them translatable. Mercur store seller routes call `query.graph` without `locale`, so localized values would not be selected even when the Translation Module is active. |
| **Fix** | Rewrite middleware async: pre-fetch open seller IDs + their products via `query.graph` link traversal, collect visible product IDs, filter by `Product.id $in [...]`. Refined in cleanup-11 (Story 8.8 AC6) — earlier seller_id filter still crashed CriteriaNode. Mark Seller `name` and `description` with native `.translatable()` so GP can register localized seller name/bio content through Translation Module without inventing non-existent `bio`/`services` columns. Pass `req.locale` to Mercur store seller list/detail `query.graph` calls. |
| **GP tracking** | Local pnpm patch record; no external Mercur/Medusa issue per `specs/constitution/upstream-policy.md`. |
| **Expiry condition** | Remove when Mercur ≥ 2.2.0 ships native visibility fix and Seller DML fields are natively translatable; verify by reverting patch + running `__tests__/patches/mercur-core-visibility-filter.integration.spec.ts` and `__tests__/patches/mercur-core-seller-translation.unit.spec.ts` |
| **Last verified** | 2026-05-27 (Story 2.5 local verification — `pnpm install --frozen-lockfile`, Mercur patch metadata tests, and translation settings unit tests under pnpm 10.33.0) |
| **Regression test** | `__tests__/patches/mercur-core-visibility-filter.integration.spec.ts` — covers cleanup-11 link-traversal shape, sentinel, both Mercur 1.x and cleanup-2 crash guards, and explicit `take: 10000` pagination cap (B-2 latent scaling fix). `__tests__/patches/mercur-core-seller-translation.unit.spec.ts` — guards Seller `name`/`description` native translatable metadata and `req.locale` propagation in the patch and installed Mercur DML model. |
| **Patch shape note** | Compiled `.medusa/server/.../middlewares.js` is intentionally rewritten without the trailing `//# sourceMappingURL=...` comment + final newline. Node CJS does not consume the sourcemap; preserving the omission stabilizes the patch hash. If a future upstream bump regenerates the sourcemap, regenerate the patch with the sourcemap dropped to keep `patchedDependencies` hash deterministic. |

---

## Patch lifecycle

1. **Author** — `pnpm patch <pkg>@<version>` opens scratch dir; edit; `pnpm patch-commit <dir>`
2. **Verify** — patch file lands in `patches/`; `patchedDependencies` entry in `pnpm-workspace.yaml` updated
3. **Document** — add row to "Active patches" table above with: target, story, bug surface, fix summary, GP tracking reference, expiry condition, last-verified date
4. **Test** — author regression test under `__tests__/patches/<pkg>.integration.spec.ts` covering the patched semantics + edge cases
5. **CI guard** — `pnpm install --frozen-lockfile` validates patch hash; bump CI pnpm to ≥10 for `patchedDependencies` support
6. **Maintenance** — on upstream bump, re-verify patch applicability; if the new baseline fixes the bug, remove patch + entry and record the local removal evidence
7. **Audit cadence** — review all entries in this README at sprint close-out; flag any "last verified" > 30 days old

---

## CI freshness guard (TODO — story v160-cleanup-2 AC4)

Add validator `_grow/tools/validate_mercur_patch_freshness.py`:

- Parse `patches/*.patch` filenames → expected versions
- Cross-check `pnpm-workspace.yaml` `patchedDependencies` map
- Fail CI if `@mercurjs/*` version in lockfile != patched version without `PATCH_REVIEWED=true` env override
