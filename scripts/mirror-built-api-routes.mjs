#!/usr/bin/env node
/**
 * mirror-built-api-routes — Story 7.12 (DEFECT-backend-api-route-build-emit-path).
 *
 * WHY: `src/api` (and 8 sibling resource dirs) are SYMLINKs → `packages/api/src/*`
 * (v160-cleanup-10, ec48fcb). `medusa build` (tsconfig rootDir './') resolves the
 * symlinks and emits compiled output under `.medusa/server/packages/api/src/<dir>`,
 * but Medusa's runtime route loader (rootDirectory=.medusa/server → project-plugin
 * resolve=.medusa/server/src) scans `.medusa/server/src/<dir>`, which the build never
 * creates (only `src/migrations` exists). Net effect: the canonical production run
 * pattern `cd .medusa/server && medusa start` mounts ZERO custom routes (all /v1/*,
 * /store/custom, /admin/custom, webhooks). DEV (`medusa develop`, roots at projectRoot,
 * readdir follows the source symlink) is unaffected — this is a latent prod-only bug.
 *
 * FIX: after `medusa build`, mirror the compiled resource dirs from
 * `.medusa/server/packages/api/src/<dir>` into the loader-scanned `.medusa/server/src/<dir>`.
 * Runs as part of the `build` npm script (medusa build && node ./scripts/mirror-built-api-routes.mjs).
 *
 * GUARD (Story 7.12 AC2): exits non-zero if the mirror did not produce a loadable
 * `.medusa/server/src/api/v1` — a built artifact that cannot serve /v1/* must FAIL the
 * build, not silently ship. `skip != green`.
 */
import fs from 'node:fs'
import path from 'node:path'

const SERVER = path.resolve('.medusa/server')
const SRC_PKG = path.join(SERVER, 'packages/api/src')
const DST = path.join(SERVER, 'src')

// Medusa-scanned project resource dirs (modules resolve via medusa-config moduleRoot,
// migrations already land under .medusa/server/src/migrations — both intentionally excluded).
const RESOURCES = ['api', 'subscribers', 'jobs', 'links', 'loaders', 'workflows']

function fail(msg) {
  console.error(`[mirror-built-api-routes] FAIL: ${msg}`)
  process.exit(1)
}

if (!fs.existsSync(SRC_PKG)) {
  fail(`compiled source root not found: ${SRC_PKG} (did 'medusa build' run first?)`)
}

const mirrored = []
for (const r of RESOURCES) {
  const from = path.join(SRC_PKG, r)
  const to = path.join(DST, r)
  if (!fs.existsSync(from)) continue
  fs.rmSync(to, { recursive: true, force: true })
  fs.cpSync(from, to, { recursive: true, dereference: true })
  mirrored.push(r)
}

// GUARD: the api routes are the load-bearing surface — must exist + carry v1.
const apiV1 = path.join(DST, 'api', 'v1')
if (!mirrored.includes('api') || !fs.existsSync(apiV1)) {
  fail(`.medusa/server/src/api/v1 missing after mirror — built artifact would mount 0 custom routes`)
}

console.log(
  `[mirror-built-api-routes] mirrored ${mirrored.join(', ')} → .medusa/server/src/ ` +
    `(built-mode route loader can now resolve /v1/*, /store/*, /admin/* custom routes)`
)
