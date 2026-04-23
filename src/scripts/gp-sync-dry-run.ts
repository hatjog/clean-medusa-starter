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