export type DryRunAction = "create" | "update" | "skip"

export type DryRunEntry = {
  entityType: string
  handle: string
  action: DryRunAction
  note?: string
}

export type FieldDiff = {
  field: string
  current: string
  incoming: string
}

function parseCliBooleanFlag(args: string[] | undefined, flag: string, envVar: string): boolean {
  if (args?.includes(flag)) return true

  const envValue = (process.env[envVar] ?? "").trim().toLowerCase()
  return envValue === "true" || envValue === "1" || envValue === "yes" || envValue === "on"
}

const HTML_ENTITY_MAP: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
}

function decodeNumericEntity(value: string, base: number): string {
  const codePoint = Number.parseInt(value, base)
  if (!Number.isFinite(codePoint)) return ""

  try {
    return String.fromCodePoint(codePoint)
  } catch {
    return ""
  }
}

export function normalizeHtml(value: string): string {
  return value
    .replace(/&#(\d+);/g, (_match, code) => decodeNumericEntity(code, 10))
    .replace(/&#x([0-9a-fA-F]+);/g, (_match, code) => decodeNumericEntity(code, 16))
    .replace(/&([a-zA-Z]+);/g, (match, name) => HTML_ENTITY_MAP[name] ?? match)
    .replace(/\u00a0/g, " ")
}

function normalizeComparisonValue(value: unknown): unknown {
  if (typeof value === "string") {
    return normalizeHtml(value).trim()
  }

  if (Array.isArray(value)) {
    return value.map((entry) => normalizeComparisonValue(entry))
  }

  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) =>
      left.localeCompare(right)
    )

    return Object.fromEntries(
      entries.map(([key, entryValue]) => [key, normalizeComparisonValue(entryValue)])
    )
  }

  return value
}

function stringifyComparisonValue(value: unknown): string {
  const normalized = normalizeComparisonValue(value)

  if (typeof normalized === "string") return normalized
  if (normalized === undefined) return "undefined"
  if (normalized === null) return "null"

  return JSON.stringify(normalized)
}

export function computeFieldDiffs(
  current: Record<string, unknown>,
  incoming: Record<string, unknown>
): FieldDiff[] {
  const keys = [...new Set([...Object.keys(current), ...Object.keys(incoming)])].sort()
  const diffs: FieldDiff[] = []

  for (const key of keys) {
    const currentValue = stringifyComparisonValue(current[key])
    const incomingValue = stringifyComparisonValue(incoming[key])
    if (currentValue === incomingValue) continue

    diffs.push({ field: key, current: currentValue, incoming: incomingValue })
  }

  return diffs
}

export function parseDryRunFlag(args?: string[]): boolean {
  return parseCliBooleanFlag(args, "--dry-run", "GP_DRY_RUN")
}

export function parseOverwriteFlag(args?: string[]): boolean {
  return parseCliBooleanFlag(args, "--overwrite", "GP_OVERWRITE")
}

export const FORCE_VENDOR_OVERWRITE_FLAG = "--force-vendor-overwrite"
export const FORCE_VENDOR_OVERWRITE_ENV = "GP_FORCE_VENDOR_OVERWRITE"

export type ForceVendorOverwriteDecision = {
  /** true ⟺ kanał był ustawiony DWUSTRONNIE (argv + env). */
  enabled: boolean
  /**
   * Ustawione ⟺ kanał był ustawiony JEDNOSTRONNIE i został ZIGNOROWANY.
   * Musi trafić do warningów i na stderr — cichy no-op byłby tym samym
   * defektem co cichy destroy, tylko z drugiej strony.
   */
  ignoredReason?: string
}

/**
 * --force-vendor-overwrite + GP_FORCE_VENDOR_OVERWRITE: ŚWIADOME zniszczenie
 * treści należącej do vendora.
 *
 * ADR-165 („treść vendor-owned wygrywa", ratyfikowany 2026-07-28): gp-config
 * WYŁĄCZNIE seeduje pola `seed_if_empty` sellera i nigdy nie jest ich
 * właścicielem. `--overwrite` nie przełamuje tej granicy — pomija pola
 * vendor-owned i raportuje je jawnie. Ten kanał jest jedynym, który je
 * przełamuje.
 *
 * Verify-B5 V1 — dlaczego to NIE jest `parseCliBooleanFlag` (OR argv|env):
 * `sanitizeEnv` (`packages/cli/src/adapters/PythonAdapter.ts`) kopiuje do
 * dziecka każdą niesekretną zmienną rodzica, a `GP_*` nie pasuje do żadnego
 * wzorca sekretu. Przy semantyce OR odziedziczone
 * `GP_FORCE_VENDOR_OVERWRITE=true` — z poprzedniej sesji diagnostycznej, z
 * shell profile'u, z CI — kasowało treść salonów bez ŻADNEJ intencji w
 * wywołaniu. To ta sama klasa co 3.4 H-2 i 4.4 M2, tylko destrukcyjna.
 *
 * Dlatego kanał jest DWUSTRONNY i wymaga koniunkcji:
 *   - argv `--force-vendor-overwrite` = intencja tego konkretnego wywołania,
 *   - env `GP_FORCE_VENDOR_OVERWRITE=true` = świadome potwierdzenie operatora.
 * Każda ze stron osobno jest IGNOROWANA i raportowana głośno.
 */
export function resolveForceVendorOverwrite(args?: string[]): ForceVendorOverwriteDecision {
  const intentInArgs = args?.includes(FORCE_VENDOR_OVERWRITE_FLAG) === true
  const rawEnv = (process.env[FORCE_VENDOR_OVERWRITE_ENV] ?? "").trim().toLowerCase()
  const envEnabled = rawEnv === "true" || rawEnv === "1" || rawEnv === "yes" || rawEnv === "on"

  if (intentInArgs && envEnabled) return { enabled: true }

  if (envEnabled) {
    return {
      enabled: false,
      ignoredReason:
        `${FORCE_VENDOR_OVERWRITE_ENV}='${rawEnv}' ZIGNOROWANE: brak jawnej intencji ` +
        `${FORCE_VENDOR_OVERWRITE_FLAG} w argumentach wywołania. Kanał destrukcyjny ` +
        `ADR-165 jest DWUSTRONNY — sama odziedziczona zmienna środowiskowa go nie ` +
        `włącza (treść vendor-owned pozostaje nietknięta).`,
    }
  }

  if (intentInArgs) {
    return {
      enabled: false,
      ignoredReason:
        `${FORCE_VENDOR_OVERWRITE_FLAG} ZIGNOROWANE: brak potwierdzenia ` +
        `${FORCE_VENDOR_OVERWRITE_ENV}=true. Kanał destrukcyjny ADR-165 jest ` +
        `DWUSTRONNY — sam argument go nie włącza (treść vendor-owned pozostaje ` +
        `nietknięta).`,
    }
  }

  return { enabled: false }
}

/**
 * --prune / GP_SYNC_PRUNE: reconcile DB rows to match config by also REMOVING
 * (soft-delete) rows the config no longer declares — e.g. a vendor's
 * seller-product links to products dropped from its products.yaml. Destructive,
 * so it is OFF by default and gated behind this flag.
 */
export function parsePruneFlag(args?: string[]): boolean {
  return parseCliBooleanFlag(args, "--prune", "GP_SYNC_PRUNE")
}

export class DryRunCollector {
  private readonly entries: DryRunEntry[] = []

  add(entry: DryRunEntry): void {
    this.entries.push({
      entityType: entry.entityType,
      handle: entry.handle,
      action: entry.action,
      ...(entry.note ? { note: entry.note } : {}),
    })
  }

  getEntries(): DryRunEntry[] {
    return [...this.entries]
  }

  renderTable(): string {
    if (this.entries.length === 0) {
      return "No planned operations."
    }

    const rows = [
      ["entity_type", "handle", "action", "note"],
      ...this.entries.map((entry) => [
        entry.entityType,
        entry.handle,
        entry.action,
        entry.note ?? "",
      ]),
    ]

    const widths = rows[0].map((_, columnIndex) =>
      Math.max(...rows.map((row) => row[columnIndex].length))
    )

    return rows
      .map((row) =>
        row.map((column, columnIndex) => column.padEnd(widths[columnIndex])).join("  ")
      )
      .join("\n")
  }
}