/**
 * gp-config-sync-market-runtime.ts — ożywienie kanału gp-config → runtime
 * (Story 5.7, AC2).
 *
 * ── Co ten etap zasila ──────────────────────────────────────────────────────
 * Tabelę `market_runtime_config` (migracja
 * `Migration20260730120000MarketRuntimeConfigTable`). To JEDYNE runtime'owe
 * źródło `locales`, `support_email` i `market_url` dla maili voucherowych.
 * Decyzja PO z 2026-07-30 jest wiążąca: żadnego env, żadnego hardkodu — pusty
 * wiersz ma zatrzymać wysyłkę, a nie zostać po cichu podmieniony na wartość
 * domyślną.
 *
 * ── Źródło prawdy ───────────────────────────────────────────────────────────
 * `gp-ops/markets/<market>/config/<instance>/markets/<market>/market.yaml`,
 * czytane przez złożony katalog konfiguracji (`GP_CONFIG_ROOT`, domyślnie
 * `../config`) — dokładnie tak jak wszystkie pozostałe etapy rodziny
 * `gp-config-sync-*`. Złożony katalog jest artefaktem assemble (byte-verbatim
 * projekcją źródeł), nie miejscem ręcznej edycji.
 *
 * ── Mapowanie (AC2.3) ───────────────────────────────────────────────────────
 *   market_id     ← market.yaml `market_id`
 *   locales       ← market.yaml `locales` (blok default/supported/fallback)
 *   support_email ← market.yaml `owners.email`
 *   market_url    ← market.yaml `domains.primary`, znormalizowana do
 *                   ABSOLUTNEGO URL `https://…` (domena bez schematu jest
 *                   legalnym wejściem konfiguracyjnym — normalizacja jest
 *                   jawna i deterministyczna, a nie zgadywana przy odczycie)
 *
 * ── Tryby ───────────────────────────────────────────────────────────────────
 * Domyślny jest DRY-RUN: planuje i raportuje, nie pisze. Zapis wymaga JAWNEJ
 * intencji `--apply`. Drugi apply tych samych danych nie zmienia wiersza —
 * raport pokazuje wtedy `unchanged`.
 *
 * UWAGA operacyjna: `medusa exec` parsuje argv yargs-em w trybie strict i
 * ODRZUCA nieznane flagi (`pnpm gp-config-sync-market-runtime gp-dev bonbeauty
 * --apply` kończy się `Unknown argument`), więc przez tę powierzchnię intencję
 * niesie zmienna środowiskowa — dokładnie tak jak w `gp-config-sync-reviews`:
 *
 *   pnpm gp-config-sync-market-runtime gp-dev bonbeauty                # dry-run
 *   GP_SYNC_APPLY=true pnpm gp-config-sync-market-runtime gp-dev bonbeauty
 *
 * Flaga `--apply` pozostaje kanonem dla wywołań bezpośrednich (orchestrator
 * dokleja ją do `stageArgs`, testy wołają `parseMarketRuntimeSyncArgs` wprost),
 * a `GP_DRY_RUN` orchestratora jest twardym override'em nad obiema formami.
 */

import { ExecArgs } from "@medusajs/framework/types"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import type { Knex } from "knex"

import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"

import * as yaml from "js-yaml"

import {
  MONEY_PATH_BRAKE_SAFE_STATE,
  MONEY_PATH_BRAKE_STATES,
  MONEY_PATH_BRAKE_SWITCHES,
} from "../lib/money-path-brakes"

export {
  MONEY_PATH_BRAKE_SAFE_STATE,
  MONEY_PATH_BRAKE_STATES,
  MONEY_PATH_BRAKE_SWITCHES,
} from "../lib/money-path-brakes"

export type MarketRuntimeSyncArgs = {
  instanceId: string
  marketId: string
  configRoot: string
  /**
   * Story 6.8 (R-1) — korzeń KANONICZNEGO źródła rynków (`gp-ops/markets`).
   * Round-trip hamulca porównuje runtime z tym źródłem, nie z projekcją.
   */
  marketsSourceRoot: string
  dryRun: boolean
}

export type MarketRuntimeRecord = {
  market_id: string
  locales: Record<string, unknown>
  support_email: string
  market_url: string
  /** v1.15.0 Story 2.1 (AD-25 / ADR-177) — hamulec sciezki pieniadza per rynek. */
  money_path_brakes: Record<string, string>
}

export type MarketRuntimeSyncPlan = {
  record: MarketRuntimeRecord
  action: "insert" | "update" | "unchanged"
}

/** Błąd konfiguracji rynku — zatrzymuje sync PRZED zapisem (AC2.4). */
export class MarketRuntimeConfigInvalidError extends Error {
  readonly error_code = "GP_CONFIG_MARKET_RUNTIME_INVALID"

  constructor(field: string, reason: string) {
    super(`market.yaml: pole '${field}' jest niepoprawne (${reason})`)
    this.name = "MarketRuntimeConfigInvalidError"
  }
}

export function parseMarketRuntimeSyncArgs(
  args: string[] | undefined,
): MarketRuntimeSyncArgs {
  const instanceId = (args?.[0] ?? process.env.GP_INSTANCE_ID ?? "gp-dev").trim()
  const marketId = (args?.[1] ?? process.env.GP_MARKET_ID ?? "bonbeauty").trim()
  const configRoot = (
    process.env.GP_CONFIG_ROOT ?? path.resolve(process.cwd(), "../config")
  ).trim()

  // Ten sam kontrakt trybów co `gp-config-sync-reviews`: `GP_DRY_RUN` jest
  // TWARDYM override'em orchestratora, a `--apply` musi być podane jawnie.
  const orchestratorDryRun = ["true", "1", "yes", "on"].includes(
    (process.env.GP_DRY_RUN ?? "").trim().toLowerCase(),
  )
  const envApply = ["true", "1", "yes", "on"].includes(
    (process.env.GP_SYNC_APPLY ?? "").trim().toLowerCase(),
  )
  const wantsApply = args?.includes("--apply") === true || envApply

  if (!instanceId) throw new Error("instanceId is required (args[0] or GP_INSTANCE_ID)")
  if (!marketId) throw new Error("marketId is required (args[1] or GP_MARKET_ID)")
  if (!configRoot) throw new Error("configRoot is required (GP_CONFIG_ROOT)")
  const marketsSourceRoot = (
    process.env.GP_MARKETS_SOURCE_ROOT ?? path.resolve(process.cwd(), "../../gp-ops/markets")
  ).trim()

  return {
    instanceId,
    marketId,
    configRoot,
    marketsSourceRoot,
    dryRun: orchestratorDryRun || !wantsApply,
  }
}

/**
 * `dev.bonbeauty.pl` → `https://dev.bonbeauty.pl`; `https://x/` → `https://x`.
 *
 * Domena bez schematu jest legalnym wejściem konfiguracyjnym (tak wygląda
 * `domains.primary` we wszystkich rynkach), więc normalizacja dokleja `https`
 * JAWNIE i w jednym miejscu. Wynik w tabeli jest zawsze absolutnym URL — to,
 * czego oczekuje szablon (`market_url` trafia wprost do `href`).
 */
export function normalizeMarketUrl(raw: unknown): string {
  if (typeof raw !== "string" || raw.trim().length === 0) {
    throw new MarketRuntimeConfigInvalidError("domains.primary", "pusta wartość")
  }

  const trimmed = raw.trim()
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)
    ? trimmed
    : `https://${trimmed}`

  let parsed: URL
  try {
    parsed = new URL(candidate)
  } catch {
    throw new MarketRuntimeConfigInvalidError(
      "domains.primary",
      "nie daje się znormalizować do absolutnego URL",
    )
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new MarketRuntimeConfigInvalidError(
      "domains.primary",
      "protokół inny niż http(s)",
    )
  }
  if (!parsed.hostname.includes(".")) {
    // `localhost`, `market` itp. nie są publicznie osiągalnymi domenami rynku.
    throw new MarketRuntimeConfigInvalidError(
      "domains.primary",
      "host nie jest domeną publiczną",
    )
  }

  return `${parsed.origin}${parsed.pathname}`.replace(/\/+$/, "")
}

export function normalizeSupportEmail(raw: unknown): string {
  if (typeof raw !== "string" || raw.trim().length === 0) {
    throw new MarketRuntimeConfigInvalidError("owners.email", "pusta wartość")
  }

  const trimmed = raw.trim()
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
    throw new MarketRuntimeConfigInvalidError(
      "owners.email",
      "nie wygląda na adres e-mail",
    )
  }

  return trimmed
}

export function normalizeLocalesBlock(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new MarketRuntimeConfigInvalidError("locales", "brak bloku locales")
  }

  const block = raw as Record<string, unknown>
  const defaultLocale = block.default
  const supported = block.supported

  if (typeof defaultLocale !== "string" || defaultLocale.trim().length === 0) {
    throw new MarketRuntimeConfigInvalidError("locales.default", "pusta wartość")
  }
  if (
    !Array.isArray(supported) ||
    supported.length === 0 ||
    supported.some((entry) => typeof entry !== "string" || entry.trim().length === 0)
  ) {
    throw new MarketRuntimeConfigInvalidError(
      "locales.supported",
      "oczekiwano niepustej listy niepustych stringów",
    )
  }
  if (!supported.includes(defaultLocale)) {
    throw new MarketRuntimeConfigInvalidError(
      "locales.default",
      "locale domyślne spoza listy supported",
    )
  }

  return block
}

/**
 * Story 2.1 (v1.15.0, AC4) — normalizacja bloku `money_path_brakes`.
 *
 * Brak bloku NIE jest bledem konfiguracji: rynek, ktory nie zadeklarowal
 * hamulcow, ma je wszystkie ZACIAGNIETE (`engaged`) — wartosc bezpieczna
 * ustalona w ADR-177. Bledem jest natomiast wartosc SPOZA enumu: cicha
 * podmiana literowki (`relesed`) na `engaged` ukrylaby fakt, ze operator
 * probowal zwolnic hamulec i mu sie nie udalo, a on sam bylby przekonany, ze
 * sie udalo. Dlatego niepoprawna wartosc zatrzymuje sync PRZED zapisem.
 */
export function normalizeMoneyPathBrakes(raw: unknown): Record<string, string> {
  const declared =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {}

  if (raw !== undefined && raw !== null && Object.keys(declared).length === 0) {
    throw new MarketRuntimeConfigInvalidError(
      "money_path_brakes",
      "blok obecny, ale pusty — zadeklaruj piec przelacznikow albo usun blok",
    )
  }

  for (const key of Object.keys(declared)) {
    if (!(MONEY_PATH_BRAKE_SWITCHES as readonly string[]).includes(key)) {
      throw new MarketRuntimeConfigInvalidError(
        `money_path_brakes.${key}`,
        "przelacznik spoza piatki zamrozonej w ADR-177",
      )
    }
  }

  const normalized: Record<string, string> = {}
  for (const name of MONEY_PATH_BRAKE_SWITCHES) {
    const value = declared[name]
    if (value === undefined) {
      normalized[name] = MONEY_PATH_BRAKE_SAFE_STATE
      continue
    }
    if (
      typeof value !== "string" ||
      !(MONEY_PATH_BRAKE_STATES as readonly string[]).includes(value)
    ) {
      throw new MarketRuntimeConfigInvalidError(
        `money_path_brakes.${name}`,
        `oczekiwano ${MONEY_PATH_BRAKE_STATES.join(" albo ")}, dostano '${String(value)}'`,
      )
    }
    normalized[name] = value
  }
  return normalized
}

/**
 * v1.16.0 Story 6.8 (AC2) — round-trip `money_path_brakes` source↔runtime.
 *
 * Porównuje blok ze źródła (market.yaml) z blokiem odczytanym z
 * `market_runtime_config` PO normalizacji obu stron. Brak wiersza albo bloku
 * po stronie runtime jest ROZJAZDEM (nie `released` i nie „zgodne, bo
 * domyślne"): wynik `ok=false` i wywołujący odmawia (fail-closed).
 * Funkcja niczego nie zwalnia i nie tworzy wartości — brak wpisu w źródle
 * normalizuje się do `engaged` (ADR-177), nigdy do `released`.
 */
export type MoneyPathBrakesRoundTrip = {
  market_id: string
  ok: boolean
  source: Record<string, string>
  runtime: Record<string, string> | null
  mismatches: string[]
}

/**
 * Story 6.8 (R-2/R-3) — nazwany kod rozjazdu. Etap `sync-market-runtime` jest
 * w orchestratorze OPCJONALNY (decyzja PO 2026-08-11: brak locales nie blokuje
 * zakupu), więc zwykły wyjątek zostałby zdegradowany do `warning`. Rozjazd
 * hamulca to inna klasa: `fatal = true` + kod — `runStage` raportuje go jako
 * `failed`, a orchestrator kończy run `ok=false` / exit 1, nie zmieniając
 * `required` etapu (kontrakt locales zostaje nietknięty).
 */
export const MONEY_PATH_BRAKES_DRIFT_ERROR_CODE = "GP_CONFIG_MONEY_PATH_BRAKES_DRIFT" as const

/**
 * Fazy rozjazdu (Story 6.8):
 * - `source-invalid` (R-16): KANONICZNE źródło ma niepoprawny blok hamulców
 *   (literówka stanu, przełącznik spoza ADR-177, pusty blok, zły YAML). To nie
 *   jest błąd locales — bez poprawnego źródła nie da się wykazać, co runtime
 *   ma odtwarzać, więc etap jest fatalny, a zastany runtime nie jest „zgodny".
 * - `source-projection`: projekcja `GP_CONFIG_ROOT` nie odtwarza źródła (także:
 *   projekcja z niepoprawnym blokiem hamulców).
 * - `pre-apply` (R-15/R-18/R-19): dry-run zastał bazę, która nie odtwarza
 *   źródła — w tym PUSTĄ bazę bez wiersza rynku (brak wpisu nie zwalnia
 *   hamulca i nie jest zgodnością przez wartość domyślną).
 * - `post-apply`: po zapisie runtime nadal nie odtwarza źródła.
 * - `source-missing`: brak pliku kanonicznego źródła.
 */
export type MoneyPathBrakesDriftPhase =
  | "source-projection"
  | "source-invalid"
  | "pre-apply"
  | "post-apply"
  | "source-missing"

/**
 * Story 6.8 (R-16) — normalizuje blok hamulców, zamieniając
 * `MarketRuntimeConfigInvalidError` w fatalny `MoneyPathBrakesDriftError`
 * nazwanej fazy. Bez tego literówka w bloku hamulców (np. `relesed`) była
 * zwykłym wyjątkiem, który etap opcjonalny degraduje do `warning`, a zastany
 * runtime zostawał bez sygnału fail-closed.
 */
export function normalizeMoneyPathBrakesOrFatal(
  marketId: string,
  raw: unknown,
  phase: "source-invalid" | "source-projection",
): Record<string, string> {
  try {
    return normalizeMoneyPathBrakes(raw)
  } catch (error) {
    if (!(error instanceof MarketRuntimeConfigInvalidError)) throw error
    throw new MoneyPathBrakesDriftError(
      {
        market_id: marketId,
        ok: false,
        source: {},
        runtime: null,
        mismatches: [`${phase === "source-invalid" ? "source" : "projection"}: ${error.message}`],
      },
      phase,
    )
  }
}

export class MoneyPathBrakesDriftError extends Error {
  readonly error_code = MONEY_PATH_BRAKES_DRIFT_ERROR_CODE
  readonly fatal = true

  constructor(
    public readonly roundTrip: MoneyPathBrakesRoundTrip,
    public readonly phase: MoneyPathBrakesDriftPhase = "post-apply",
  ) {
    super(
      `${MONEY_PATH_BRAKES_DRIFT_ERROR_CODE} [${phase}] money_path_brakes drift for market '${roundTrip.market_id}': ${roundTrip.mismatches.join("; ")}`,
    )
    this.name = "MoneyPathBrakesDriftError"
  }
}

export function compareMoneyPathBrakesRoundTrip(
  marketId: string,
  sourceBlock: unknown,
  runtimeBlock: unknown,
): MoneyPathBrakesRoundTrip {
  const source = normalizeMoneyPathBrakes(sourceBlock)
  const parsedRuntime =
    typeof runtimeBlock === "string" ? safeJsonParse(runtimeBlock) : runtimeBlock

  if (
    parsedRuntime === null ||
    parsedRuntime === undefined ||
    typeof parsedRuntime !== "object" ||
    Array.isArray(parsedRuntime)
  ) {
    return {
      market_id: marketId,
      ok: false,
      source,
      runtime: null,
      mismatches: ["runtime: brak bloku money_path_brakes"],
    }
  }

  const runtimeRecord = parsedRuntime as Record<string, unknown>
  const mismatches: string[] = []
  const runtime: Record<string, string> = {}
  for (const key of Object.keys(runtimeRecord)) {
    if (!(MONEY_PATH_BRAKE_SWITCHES as readonly string[]).includes(key)) {
      mismatches.push(`runtime: przelacznik spoza ADR-177 '${key}'`)
    }
  }
  for (const name of MONEY_PATH_BRAKE_SWITCHES) {
    const value = runtimeRecord[name]
    if (typeof value !== "string") {
      mismatches.push(`${name}: runtime brak wpisu (source '${source[name]}')`)
      continue
    }
    runtime[name] = value
    if (value !== source[name]) {
      mismatches.push(`${name}: source '${source[name]}' != runtime '${value}'`)
    }
  }

  return { market_id: marketId, ok: mismatches.length === 0, source, runtime, mismatches }
}

export function assertMoneyPathBrakesRoundTrip(
  marketId: string,
  sourceBlock: unknown,
  runtimeBlock: unknown,
  phase: MoneyPathBrakesDriftPhase = "post-apply",
): MoneyPathBrakesRoundTrip {
  const result = compareMoneyPathBrakesRoundTrip(marketId, sourceBlock, runtimeBlock)
  if (!result.ok) {
    throw new MoneyPathBrakesDriftError(result, phase)
  }
  return result
}

/**
 * Story 6.8 (R-1) — proweniencja kanonicznego źródła hamulca.
 *
 * `source_*` to plik w `gp-ops/markets/**` (jedyne miejsce edycji),
 * `projection_*` to złożony `GP_CONFIG_ROOT`, a `sidecar_*` to
 * `.gp-projection-provenance.json` zapisany przez assemble (Story 7.7).
 * `projection_built_from_source` = sidecar potwierdza, że projekcja powstała
 * z TEGO sha źródła; `null` = brak sidecara (np. instancja bez assemble ze
 * stemplem) — raportowane, nie zgadywane.
 */
export type MoneyPathBrakesSourceProvenance = {
  source_path: string
  source_sha256: string
  projection_path: string
  projection_sha256: string
  sidecar_path: string
  sidecar_source_sha256: string | null
  projection_built_from_source: boolean | null
}

export type CanonicalMarketSource = {
  doc: Record<string, unknown>
  provenance: MoneyPathBrakesSourceProvenance
}

export function canonicalMarketSourcePath(
  marketsSourceRoot: string,
  instanceId: string,
  marketId: string,
): string {
  return path.resolve(
    marketsSourceRoot,
    marketId,
    "config",
    instanceId,
    "markets",
    marketId,
    "market.yaml",
  )
}

function sha256Hex(raw: Buffer | string): string {
  return createHash("sha256").update(raw).digest("hex")
}

function parseMarketYamlDocument(raw: string, origin: string): Record<string, unknown> {
  const doc = yaml.load(raw, { schema: yaml.JSON_SCHEMA })
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) {
    throw new Error(`Invalid YAML document: ${origin}`)
  }
  return doc as Record<string, unknown>
}

/**
 * Czyta kanoniczne źródło rynku tym samym parserem co projekcję i liczy
 * proweniencję. Brak pliku źródła jest ROZJAZDEM fatalnym (`source-missing`):
 * bez źródła nie da się wykazać, że runtime je odtwarza.
 */
export async function loadCanonicalMarketSource(
  args: Pick<MarketRuntimeSyncArgs, "configRoot" | "instanceId" | "marketId" | "marketsSourceRoot">,
): Promise<CanonicalMarketSource> {
  const sourcePath = canonicalMarketSourcePath(args.marketsSourceRoot, args.instanceId, args.marketId)
  const projectionDir = path.resolve(args.configRoot, args.instanceId, "markets", args.marketId)
  const projectionPath = path.join(projectionDir, "market.yaml")
  const sidecarPath = path.join(projectionDir, ".gp-projection-provenance.json")

  let sourceRaw: Buffer
  try {
    sourceRaw = await fs.readFile(sourcePath)
  } catch (error) {
    throw new MoneyPathBrakesDriftError(
      {
        market_id: args.marketId,
        ok: false,
        source: {},
        runtime: null,
        mismatches: [
          `source: brak kanonicznego market.yaml (${sourcePath}): ${
            error instanceof Error ? error.message : String(error)
          }`,
        ],
      },
      "source-missing",
    )
  }
  const projectionRaw = await fs.readFile(projectionPath)

  let sidecarSourceSha: string | null = null
  try {
    const sidecar = JSON.parse(await fs.readFile(sidecarPath, "utf8")) as {
      source_files?: Record<string, unknown>
    }
    const entry = sidecar?.source_files?.["market.yaml"]
    sidecarSourceSha = typeof entry === "string" ? entry : null
  } catch {
    sidecarSourceSha = null
  }

  const sourceSha = sha256Hex(sourceRaw)
  // R-16: nieparsowalne kanoniczne źródło to ten sam przypadek co brak
  // źródła — nie zwykły błąd etapu opcjonalnego.
  let sourceDoc: Record<string, unknown>
  try {
    sourceDoc = parseMarketYamlDocument(sourceRaw.toString("utf8"), sourcePath)
  } catch (error) {
    throw new MoneyPathBrakesDriftError(
      {
        market_id: args.marketId,
        ok: false,
        source: {},
        runtime: null,
        mismatches: [
          `source: niepoprawny YAML kanonicznego market.yaml (${sourcePath}): ${
            error instanceof Error ? error.message : String(error)
          }`,
        ],
      },
      "source-invalid",
    )
  }
  return {
    doc: sourceDoc,
    provenance: {
      source_path: sourcePath,
      source_sha256: sourceSha,
      projection_path: projectionPath,
      projection_sha256: sha256Hex(projectionRaw),
      sidecar_path: sidecarPath,
      sidecar_source_sha256: sidecarSourceSha,
      projection_built_from_source: sidecarSourceSha === null ? null : sidecarSourceSha === sourceSha,
    },
  }
}

/**
 * Story 6.8 (R-1/R-3) — kontrola PRZED zapisem.
 *
 * 1. `source-projection`: kanoniczne źródło vs projekcja `GP_CONFIG_ROOT`,
 *    z której powstaje rekord. Nieaktualna projekcja `released` przy źródle
 *    `engaged` jest odmową — NIE trafia do bazy.
 * 2. `pre-apply`: kanoniczne źródło vs ZASTANY wiersz bazy. Rozjazd nie jest
 *    już „po cichu nadpisany": raport go nazywa (`pre_apply_drift`), dry-run
 *    zwraca `ok=false`. Apply nadpisuje go wartością ze źródła (to jest
 *    naprawa w stronę źródła), a kontrola `post-apply` sprawdza wynik.
 */
export type MoneyPathBrakesPreApplyCheck = {
  source_projection: MoneyPathBrakesRoundTrip
  pre_apply: MoneyPathBrakesRoundTrip
}

export function checkMoneyPathBrakesBeforeApply(input: {
  marketId: string
  canonicalBlock: unknown
  projectionBlock: unknown
  existingRuntimeBlock: unknown
}): MoneyPathBrakesPreApplyCheck {
  // R-16: najpierw KANONICZNE źródło — jego błąd jest fatalny (`source-invalid`).
  normalizeMoneyPathBrakesOrFatal(input.marketId, input.canonicalBlock, "source-invalid")
  // Projekcja musi się normalizować (literówka = błąd fatalny), a potem odtwarzać źródło.
  const projection = normalizeMoneyPathBrakesOrFatal(
    input.marketId,
    input.projectionBlock,
    "source-projection",
  )
  const sourceProjection = compareMoneyPathBrakesRoundTrip(
    input.marketId,
    input.canonicalBlock,
    projection,
  )
  if (!sourceProjection.ok) {
    throw new MoneyPathBrakesDriftError(sourceProjection, "source-projection")
  }
  const preApply = compareMoneyPathBrakesRoundTrip(
    input.marketId,
    input.canonicalBlock,
    input.existingRuntimeBlock,
  )
  return { source_projection: sourceProjection, pre_apply: preApply }
}

export async function readRuntimeMoneyPathBrakes(
  db: Knex,
  marketId: string,
): Promise<unknown> {
  const result = await db.raw(
    `SELECT money_path_brakes
       FROM market_runtime_config
      WHERE market_id = ?
      LIMIT 1`,
    [marketId],
  )
  const rows = extractRows<{ money_path_brakes: unknown }>(result)
  return rows.length === 0 ? null : rows[0]?.money_path_brakes ?? null
}

export function buildMarketRuntimeRecord(
  marketId: string,
  marketYaml: Record<string, unknown>,
): MarketRuntimeRecord {
  const declaredMarketId = marketYaml.market_id
  if (typeof declaredMarketId !== "string" || declaredMarketId.trim().length === 0) {
    throw new MarketRuntimeConfigInvalidError("market_id", "pusta wartość")
  }
  if (declaredMarketId.trim() !== marketId) {
    // Zapis pod cudzym `market_id` podmieniłby konfigurację innego rynku.
    throw new MarketRuntimeConfigInvalidError(
      "market_id",
      `'${declaredMarketId.trim()}' != rynek wywołania '${marketId}'`,
    )
  }

  const owners = (marketYaml.owners ?? {}) as Record<string, unknown>
  const domains = (marketYaml.domains ?? {}) as Record<string, unknown>

  return {
    market_id: marketId,
    locales: normalizeLocalesBlock(marketYaml.locales),
    support_email: normalizeSupportEmail(owners.email),
    market_url: normalizeMarketUrl(domains.primary),
    money_path_brakes: normalizeMoneyPathBrakes(marketYaml.money_path_brakes),
  }
}

type ExistingRow = {
  locales: unknown
  support_email: string | null
  market_url: string | null
  money_path_brakes: unknown
}

function extractRows<T>(result: unknown): T[] {
  const record = result as { rows?: unknown }
  if (Array.isArray(record?.rows)) return record.rows as T[]
  if (Array.isArray(result)) return result as T[]
  return []
}

function sameLocales(current: unknown, incoming: Record<string, unknown>): boolean {
  const parsed = typeof current === "string" ? safeJsonParse(current) : current
  return JSON.stringify(sortDeep(parsed)) === JSON.stringify(sortDeep(incoming))
}

function safeJsonParse(value: string): unknown {
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}

function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep)
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, entry]) => [key, sortDeep(entry)]),
    )
  }
  return value
}

export async function planMarketRuntimeSync(
  db: Knex,
  record: MarketRuntimeRecord,
): Promise<MarketRuntimeSyncPlan> {
  const result = await db.raw(
    `SELECT locales, support_email, market_url, money_path_brakes
       FROM market_runtime_config
      WHERE market_id = ?
      LIMIT 1`,
    [record.market_id],
  )
  const rows = extractRows<ExistingRow>(result)

  if (rows.length === 0) {
    return { record, action: "insert" }
  }

  const current = rows[0]
  const unchanged =
    current.support_email === record.support_email &&
    current.market_url === record.market_url &&
    sameLocales(current.locales, record.locales) &&
    sameLocales(current.money_path_brakes, record.money_path_brakes)

  return { record, action: unchanged ? "unchanged" : "update" }
}

export async function applyMarketRuntimeSync(
  db: Knex,
  record: MarketRuntimeRecord,
): Promise<void> {
  await db.raw(
    `INSERT INTO market_runtime_config
       (market_id, locales, support_email, market_url, money_path_brakes,
        created_at, updated_at)
     VALUES (?, ?::jsonb, ?, ?, ?::jsonb, now(), now())
     ON CONFLICT (market_id) DO UPDATE
        SET locales           = EXCLUDED.locales,
            support_email     = EXCLUDED.support_email,
            market_url        = EXCLUDED.market_url,
            money_path_brakes = EXCLUDED.money_path_brakes,
            updated_at        = now()`,
    [
      record.market_id,
      JSON.stringify(record.locales),
      record.support_email,
      record.market_url,
      JSON.stringify(record.money_path_brakes),
    ],
  )
}

async function loadMarketYaml(
  args: MarketRuntimeSyncArgs,
): Promise<Record<string, unknown>> {
  const marketPath = path.resolve(
    args.configRoot,
    args.instanceId,
    "markets",
    args.marketId,
    "market.yaml",
  )
  const raw = await fs.readFile(marketPath, "utf8")
  const doc = yaml.load(raw, { schema: yaml.JSON_SCHEMA })

  if (!doc || typeof doc !== "object" || Array.isArray(doc)) {
    throw new Error(`Invalid YAML document: ${marketPath}`)
  }

  return doc as Record<string, unknown>
}

export default async function gpConfigSyncMarketRuntime({
  container,
  args,
}: ExecArgs) {
  const parsedArgs = parseMarketRuntimeSyncArgs(args)
  const marketYaml = await loadMarketYaml(parsedArgs)

  // Story 6.8 (R-1/R-3/R-16): kontrola PRZED zapisem — kanoniczne źródło
  // (gp-ops/markets) vs projekcja i vs zastany wiersz. Rozjazd albo błąd
  // bloku hamulców (źródło lub projekcja) rzuca `MoneyPathBrakesDriftError`
  // (fatal) zanim cokolwiek trafi do bazy — także zanim
  // `buildMarketRuntimeRecord` zdążyłby rzucić zwykły (degradowany do
  // `warning`) `MarketRuntimeConfigInvalidError` dla tego samego bloku.
  const canonical = await loadCanonicalMarketSource(parsedArgs)
  normalizeMoneyPathBrakesOrFatal(parsedArgs.marketId, canonical.doc.money_path_brakes, "source-invalid")
  normalizeMoneyPathBrakesOrFatal(parsedArgs.marketId, marketYaml.money_path_brakes, "source-projection")

  const record = buildMarketRuntimeRecord(parsedArgs.marketId, marketYaml)
  const db = container.resolve(ContainerRegistrationKeys.PG_CONNECTION) as Knex

  const preApply = checkMoneyPathBrakesBeforeApply({
    marketId: record.market_id,
    canonicalBlock: canonical.doc.money_path_brakes,
    projectionBlock: marketYaml.money_path_brakes,
    existingRuntimeBlock: await readRuntimeMoneyPathBrakes(db, record.market_id),
  })

  const plan = await planMarketRuntimeSync(db, record)

  if (!parsedArgs.dryRun && plan.action !== "unchanged") {
    await applyMarketRuntimeSync(db, record)
  }

  // Story 6.8 (AC2): po apply runtime MUSI odtwarzac KANONICZNE źródło
  // dokladnie; rozjazd przerywa etap (fail-closed, kod nazwany). Dry-run nie
  // pisze, więc jego wynikiem jest stan zastany: rozjazd => `ok=false`.
  const brakesRoundTrip = parsedArgs.dryRun
    ? preApply.pre_apply
    : assertMoneyPathBrakesRoundTrip(
        record.market_id,
        canonical.doc.money_path_brakes,
        await readRuntimeMoneyPathBrakes(db, record.market_id),
        "post-apply",
      )

  // Raport bez sekretów: `support_email` to adres kontaktowy rynku publikowany
  // w stopce maila, a nie dana wrażliwa; żadnych kluczy API tu nie ma.
  const summary = {
    ok: brakesRoundTrip.ok,
    dry_run: parsedArgs.dryRun,
    instance_id: parsedArgs.instanceId,
    market_id: record.market_id,
    action: plan.action,
    planned_inserts: plan.action === "insert" ? 1 : 0,
    planned_updates: plan.action === "update" ? 1 : 0,
    unchanged: plan.action === "unchanged" ? 1 : 0,
    market_url: record.market_url,
    support_email: record.support_email,
    locales_default: record.locales.default,
    money_path_brakes_round_trip: {
      ok: brakesRoundTrip.ok,
      mismatches: brakesRoundTrip.mismatches,
      pre_apply_drift: preApply.pre_apply.ok ? [] : preApply.pre_apply.mismatches,
      provenance: canonical.provenance,
    },
    // R-18: zastany rozjazd naprawiony w apply jest NAZWANY w warnings (apply
    // w stronę źródła jest legalną ścieżką aktywacji — R-17 — więc to nie
    // porażka, ale operator musi widzieć, że baza nie odtwarzała źródła).
    warnings:
      !parsedArgs.dryRun && !preApply.pre_apply.ok
        ? [
            `${MONEY_PATH_BRAKES_DRIFT_ERROR_CODE} [pre-apply] zastany rozjazd naprawiony w stronę źródła: ${preApply.pre_apply.mismatches.join("; ")}`,
          ]
        : ([] as string[]),
  }

  console.log(JSON.stringify(summary, null, 2))

  // R-15/R-18/R-19: dry-run, który zastał rozjazd (także pustą bazę bez
  // wiersza rynku — brak wpisu nie zwalnia hamulca), kończy etap błędem
  // FATALNYM z nazwanym kodem. Sam `ok=false` w JSON i sam `process.exitCode`
  // nie wystarczają: orchestrator degraduje exitCode etapu do `warning`.
  if (parsedArgs.dryRun && !brakesRoundTrip.ok) {
    process.exitCode = 1
    throw new MoneyPathBrakesDriftError(brakesRoundTrip, "pre-apply")
  }
  for (const warning of summary.warnings) console.warn(warning)
  return summary
}
