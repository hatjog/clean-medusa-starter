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

import fs from "node:fs/promises"
import path from "node:path"

import * as yaml from "js-yaml"

export type MarketRuntimeSyncArgs = {
  instanceId: string
  marketId: string
  configRoot: string
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

  return {
    instanceId,
    marketId,
    configRoot,
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
export const MONEY_PATH_BRAKE_SWITCHES = [
  "fr_6_7_multi_seller_purchase_return",
  "fr_9_delivery_idempotency",
  "fr_10_panel_redemption",
  "fr_12_redemption_ledger",
  "fr_14_market_isolation",
] as const

export const MONEY_PATH_BRAKE_STATES = ["engaged", "released"] as const

/** Wartosc bezpieczna z ADR-177 — fail-closed dla sciezki pieniadza. */
export const MONEY_PATH_BRAKE_SAFE_STATE = "engaged"

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
  const record = buildMarketRuntimeRecord(parsedArgs.marketId, marketYaml)
  const db = container.resolve(ContainerRegistrationKeys.PG_CONNECTION) as Knex

  const plan = await planMarketRuntimeSync(db, record)

  if (!parsedArgs.dryRun && plan.action !== "unchanged") {
    await applyMarketRuntimeSync(db, record)
  }

  // Raport bez sekretów: `support_email` to adres kontaktowy rynku publikowany
  // w stopce maila, a nie dana wrażliwa; żadnych kluczy API tu nie ma.
  const summary = {
    ok: true,
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
  }

  console.log(JSON.stringify(summary, null, 2))
  return summary
}
