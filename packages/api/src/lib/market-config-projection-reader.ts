/**
 * market-config-projection-reader.ts — Story v1.16.0 7.8 (FR-8, NFR-4, K9).
 *
 * Read-only reader of the runtime gp-config projection produced by Story 7.7
 * (`gp-ops/cli/src/config-load.ts`): `<configRoot>/<instance>/markets/<market>/`
 * with `market.yaml` and the `.gp-projection-provenance.json` sidecar.
 *
 * Contract: every outcome is a distinct, discriminated class. A failure is
 * NEVER folded into an empty result — an unreadable projection is
 * `projection_error`, a missing market directory is `invalid_context`, a
 * projection whose provenance is missing or does not match the bytes on disk
 * is `stale`, and only a legally empty `market.yaml` is `empty`.
 *
 * The reader never writes, never activates a market and never touches payment
 * modules: it uses `fs` reads only.
 *
 * @module lib/market-config-projection-reader
 */
import { createHash } from "node:crypto"
import { promises as fs } from "node:fs"
import path from "node:path"
import yaml from "js-yaml"
import { resolveRuntimeInstanceId } from "./market-context"

export const PROJECTION_PROVENANCE_FILE = ".gp-projection-provenance.json"
const MARKET_CONFIG_FILE = "market.yaml"

/** Markets used exclusively for control/isolation testing: always read-only. */
export const READ_ONLY_CONTROL_MARKETS: ReadonlySet<string> = new Set(["testmarketb"])

const MARKET_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/

export type StaleReason =
  | "provenance_missing"
  | "provenance_invalid"
  | "provenance_scope_mismatch"
  | "projection_digest_mismatch"

export type ProjectionErrorCode =
  | "instance_unresolved"
  | "market_config_missing"
  | "market_config_unreadable"
  | "market_config_invalid_yaml"
  | "market_config_not_a_mapping"
  | "projection_unreadable"

export type InvalidContextCode = "market_id_missing" | "market_id_invalid" | "market_not_found"

export type MarketConfigProjectionResult =
  | { kind: "ok"; market_id: string; instance_id: string; read_only: boolean; config: Record<string, unknown> }
  | { kind: "empty"; market_id: string; instance_id: string; read_only: boolean }
  | {
      kind: "stale"
      market_id: string
      instance_id: string
      read_only: boolean
      reason: StaleReason
      config: Record<string, unknown> | null
    }
  | { kind: "invalid_context"; code: InvalidContextCode; market_id: string | null }
  | { kind: "projection_error"; code: ProjectionErrorCode; market_id: string | null }

export type ProjectionReaderLogger = { warn: (message: string) => void }

export type ReadMarketConfigProjectionOptions = {
  configRoot?: string
  instanceId?: string | null
  logger?: ProjectionReaderLogger
}

/** Same contract as storefront `resolveConfigRoot` / backend gp-config-sync scripts. */
export function resolveProjectionConfigRoot(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env.GP_CONFIG_ROOT?.trim()
  return fromEnv ? fromEnv : path.resolve(process.cwd(), "../config")
}

export function isReadOnlyControlMarket(marketId: string): boolean {
  return READ_ONLY_CONTROL_MARKETS.has(marketId)
}

function errnoCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code
}

function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex")
}

/** Mirrors `listProjectionFiles` + `digestFileMap` in gp-ops config-load (7.7). */
async function digestProjectionFiles(baseDir: string): Promise<Record<string, string>> {
  const entries: Array<[string, string]> = []
  async function walk(dir: string): Promise<void> {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        await walk(abs)
        continue
      }
      const rel = path.relative(baseDir, abs).replace(/\\/g, "/")
      if (rel === PROJECTION_PROVENANCE_FILE || rel === ".gitkeep") continue
      entries.push([rel, sha256(await fs.readFile(abs))])
    }
  }
  await walk(baseDir)
  entries.sort(([a], [b]) => a.localeCompare(b))
  return Object.fromEntries(entries)
}

function sameDigestMap(left: Record<string, string>, right: unknown): boolean {
  if (typeof right !== "object" || right === null) return false
  const r = right as Record<string, unknown>
  const leftKeys = Object.keys(left)
  if (leftKeys.length !== Object.keys(r).length) return false
  return leftKeys.every((key) => r[key] === left[key])
}

async function checkProvenance(
  marketDir: string,
  marketId: string,
  instanceId: string,
  logger: ProjectionReaderLogger
): Promise<StaleReason | null> {
  let raw: string
  try {
    raw = await fs.readFile(path.join(marketDir, PROJECTION_PROVENANCE_FILE), "utf8")
  } catch (error) {
    logger.warn(
      `[market-config-projection] provenance unreadable for ${marketId} (${errnoCode(error) ?? "unknown"}) -> stale`
    )
    return errnoCode(error) === "ENOENT" ? "provenance_missing" : "provenance_invalid"
  }
  let provenance: Record<string, unknown>
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      logger.warn(`[market-config-projection] provenance for ${marketId} is not an object -> stale`)
      return "provenance_invalid"
    }
    provenance = parsed as Record<string, unknown>
  } catch (error) {
    logger.warn(
      `[market-config-projection] provenance JSON invalid for ${marketId}: ${(error as Error).message} -> stale`
    )
    return "provenance_invalid"
  }
  if (
    provenance.schema_version !== 1 ||
    provenance.market_id !== marketId ||
    provenance.instance_id !== instanceId
  ) {
    logger.warn(`[market-config-projection] provenance scope mismatch for ${marketId}/${instanceId} -> stale`)
    return "provenance_scope_mismatch"
  }
  const actual = await digestProjectionFiles(marketDir)
  if (
    !sameDigestMap(actual, provenance.projection_files) ||
    provenance.projection_digest !== sha256(JSON.stringify(actual))
  ) {
    logger.warn(`[market-config-projection] projection bytes differ from provenance for ${marketId} -> stale`)
    return "projection_digest_mismatch"
  }
  return null
}

export async function readMarketConfigProjection(
  marketIdInput: string | null | undefined,
  opts: ReadMarketConfigProjectionOptions = {}
): Promise<MarketConfigProjectionResult> {
  const logger = opts.logger ?? console
  const marketId = typeof marketIdInput === "string" ? marketIdInput.trim() : ""
  if (!marketId) return { kind: "invalid_context", code: "market_id_missing", market_id: null }
  if (!MARKET_ID_PATTERN.test(marketId)) {
    logger.warn(`[market-config-projection] rejected market_id outside slug alphabet`)
    return { kind: "invalid_context", code: "market_id_invalid", market_id: null }
  }

  const instanceId =
    opts.instanceId !== undefined ? resolveRuntimeInstanceId(opts.instanceId ?? undefined) : resolveRuntimeInstanceId()
  if (!instanceId) {
    logger.warn(`[market-config-projection] GP_INSTANCE_ID unresolved -> projection_error`)
    return { kind: "projection_error", code: "instance_unresolved", market_id: marketId }
  }

  const configRoot = opts.configRoot ?? resolveProjectionConfigRoot()
  const marketDir = path.resolve(configRoot, instanceId, "markets", marketId)
  const readOnly = isReadOnlyControlMarket(marketId)

  try {
    const st = await fs.stat(marketDir)
    if (!st.isDirectory()) {
      logger.warn(`[market-config-projection] ${marketDir} is not a directory -> invalid_context`)
      return { kind: "invalid_context", code: "market_not_found", market_id: marketId }
    }
  } catch (error) {
    if (errnoCode(error) === "ENOENT") {
      logger.warn(`[market-config-projection] market directory missing for ${marketId} -> invalid_context`)
      return { kind: "invalid_context", code: "market_not_found", market_id: marketId }
    }
    logger.warn(
      `[market-config-projection] market directory unreadable for ${marketId} (${errnoCode(error) ?? "unknown"}) -> projection_error`
    )
    return { kind: "projection_error", code: "projection_unreadable", market_id: marketId }
  }

  let raw: string
  try {
    raw = await fs.readFile(path.join(marketDir, MARKET_CONFIG_FILE), "utf8")
  } catch (error) {
    const missing = errnoCode(error) === "ENOENT"
    logger.warn(
      `[market-config-projection] market.yaml ${missing ? "missing" : "unreadable"} for ${marketId} -> projection_error`
    )
    return {
      kind: "projection_error",
      code: missing ? "market_config_missing" : "market_config_unreadable",
      market_id: marketId,
    }
  }

  let parsed: unknown
  try {
    parsed = yaml.load(raw)
  } catch (error) {
    logger.warn(
      `[market-config-projection] market.yaml invalid YAML for ${marketId}: ${(error as Error).message} -> projection_error`
    )
    return { kind: "projection_error", code: "market_config_invalid_yaml", market_id: marketId }
  }

  let config: Record<string, unknown> | null
  if (parsed === null || parsed === undefined) {
    config = null
  } else if (typeof parsed === "object" && !Array.isArray(parsed)) {
    config = parsed as Record<string, unknown>
  } else {
    logger.warn(`[market-config-projection] market.yaml for ${marketId} is not a mapping -> projection_error`)
    return { kind: "projection_error", code: "market_config_not_a_mapping", market_id: marketId }
  }

  let staleReason: StaleReason | null
  try {
    staleReason = await checkProvenance(marketDir, marketId, instanceId, logger)
  } catch (error) {
    logger.warn(
      `[market-config-projection] projection inventory unreadable for ${marketId} (${errnoCode(error) ?? "unknown"}) -> projection_error`
    )
    return { kind: "projection_error", code: "projection_unreadable", market_id: marketId }
  }

  if (staleReason) {
    return { kind: "stale", market_id: marketId, instance_id: instanceId, read_only: readOnly, reason: staleReason, config }
  }
  if (config === null || Object.keys(config).length === 0) {
    return { kind: "empty", market_id: marketId, instance_id: instanceId, read_only: readOnly }
  }
  return { kind: "ok", market_id: marketId, instance_id: instanceId, read_only: readOnly, config }
}
