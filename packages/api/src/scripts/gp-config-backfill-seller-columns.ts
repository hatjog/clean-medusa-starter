/**
 * `gp-config-backfill-seller-columns` — idempotentna ścieżka naprawcza dla
 * sellerów, którym seed trafił do LUSTRA zamiast do kolumny encji.
 *
 * ## Po co
 *
 * Do review cyklu 4 `gp-config-sync-vendors` zapisywał pola `seed_if_empty`
 * wyłącznie w `metadata.gp.*`. `createPayload` nie zawierał `description`,
 * a ścieżka UPDATE pisała `gpMetaUpdate.description`. `GET /store/seller/:handle`
 * czyta kolumnę — więc opisy wygenerowane przez story 4.6 były na storefroncie
 * NIEWIDOCZNE (`"description": null` przy 402 znakach w lustrze).
 *
 * Sam sync po fixie naprawia to przy okazji (pusta kolumna = Case 3 → seed),
 * ale tylko dla vendorów, których config nadal deklaruje, i tylko przy pełnym
 * runie orchestratora. Ten skrypt robi dokładnie jedną rzecz, bez configu
 * i bez reszty etapów.
 *
 * ## Kontrakt własności (ADR-165)
 *
 * Przepisujemy rejestr → kolumna WYŁĄCZNIE gdy zachodzą wszystkie trzy:
 *   1. pole jest w `metadata.gp.seeded_fields` (czyli to MY je zasialiśmy),
 *   2. kolumna encji jest pusta (`null` / `""`),
 *   3. rejestr `metadata.gp.<pole>` ma niepustą wartość.
 *
 * Pusta kolumna nie zawiera niczyjej treści, więc to NIE jest nadpisanie pracy
 * vendora — to dokończenie zapisu, który nigdy nie doszedł do skutku. Każdy
 * inny układ jest pomijany i policzony w raporcie.
 *
 * ## Domyślnie NIC NIE PISZE
 *
 * Bez `--apply` skrypt jest planem. To celowo odwrotna domyślność niż w
 * `gp-config-sync-*`: skrypt naprawczy uruchamia się rzadko, zwykle na bazie,
 * o której ktoś już się martwi.
 *
 * ## Użycie
 *
 *   medusa exec ./src/scripts/gp-config-backfill-seller-columns.ts [marketId]
 *   medusa exec ./src/scripts/gp-config-backfill-seller-columns.ts bonbeauty --apply
 *
 * Bez `marketId` obejmuje wszystkich sellerów; z `marketId` — tylko tych
 * z `metadata.gp.market_id === marketId`.
 */

import { ExecArgs } from "@medusajs/framework/types"

// Jedna implementacja zapisu sellera dla obu skryptów — wariantów metod update
// w module sellera jest trzy i nie chcemy drugiego miejsca do rozjechania.
import { updateSellerRecord } from "./gp-config-sync-vendors"

/** Pola seedowane, które mają WŁASNĄ kolumnę encji: rejestr → kolumna. */
const COLUMN_BACKED_SEED_FIELDS = [
  { seedField: "name", registryKey: "name", column: "name" },
  { seedField: "description", registryKey: "description", column: "description" },
  { seedField: "photo_url", registryKey: "photo_url", column: "logo" },
] as const

export type SellerColumnBackfillPlan = {
  seller_id: string
  handle: string | null
  /** Kolumny do zapisania wraz z wartością przepisywaną z rejestru. */
  columns: Record<string, string>
}

export type SellerColumnBackfillSummary = {
  ok: boolean
  apply: boolean
  market_id: string | null
  scanned: number
  planned: number
  applied: number
  skipped: {
    /** Kolumna już ma wartość — nie dotykamy (może być treścią vendora). */
    column_not_empty: number
    /** Pole nie jest w `seeded_fields` — nie nasze, nie ruszamy. */
    not_seeded: number
    /** Rejestr pusty — nie ma czego przepisać. */
    registry_empty: number
  }
  plans: SellerColumnBackfillPlan[]
  warnings: string[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isBlank(value: unknown): boolean {
  return value === null || value === undefined || (typeof value === "string" && value.trim() === "")
}

/**
 * Czysta funkcja decyzyjna — cały kontrakt własności w jednym miejscu,
 * testowalny bez DB i bez kontenera Medusy.
 */
export function planSellerColumnBackfill(
  seller: Record<string, unknown>,
  counters: SellerColumnBackfillSummary["skipped"]
): SellerColumnBackfillPlan | null {
  const metadata = isRecord(seller.metadata) ? seller.metadata : {}
  const gp = isRecord(metadata.gp) ? metadata.gp : {}
  const seededFields = Array.isArray(gp.seeded_fields) ? (gp.seeded_fields as unknown[]) : []

  const columns: Record<string, string> = {}

  for (const field of COLUMN_BACKED_SEED_FIELDS) {
    if (!seededFields.includes(field.seedField)) {
      counters.not_seeded += 1
      continue
    }
    if (!isBlank(seller[field.column])) {
      // Kolumna ma treść — może być vendora, może być naszym seedem po fixie.
      // Tak czy inaczej backfill nie ma tu nic do roboty.
      counters.column_not_empty += 1
      continue
    }
    const registryValue = gp[field.registryKey]
    if (typeof registryValue !== "string" || registryValue.trim() === "") {
      counters.registry_empty += 1
      continue
    }
    columns[field.column] = registryValue
  }

  if (Object.keys(columns).length === 0) return null

  return {
    seller_id: String(seller.id ?? ""),
    handle: typeof seller.handle === "string" ? seller.handle : null,
    columns,
  }
}

function resolveService(container: any, keysToTry: string[]): any {
  const errors: string[] = []
  for (const key of keysToTry) {
    try {
      return container.resolve(key)
    } catch (e: any) {
      errors.push(`${key}: ${e?.message ?? String(e)}`)
    }
  }
  throw new Error(
    `Cannot resolve service. Tried keys: ${keysToTry.join(", ")}. Errors: ${errors.join(" | ")}`
  )
}

async function listSellers(sellerModuleService: any): Promise<Record<string, unknown>[]> {
  if (typeof sellerModuleService.list === "function") {
    return (await sellerModuleService.list({})) ?? []
  }
  if (typeof sellerModuleService.listSellers === "function") {
    return (await sellerModuleService.listSellers({})) ?? []
  }
  throw new Error("Seller module service exposes neither list() nor listSellers()")
}

export default async function gpConfigBackfillSellerColumns({ container, args }: ExecArgs) {
  const positional = (args ?? []).filter((arg) => !arg.startsWith("--"))
  const marketId = (positional[0] ?? process.env.GP_MARKET_ID ?? "").trim() || null
  const apply = (args ?? []).includes("--apply")

  const summary: SellerColumnBackfillSummary = {
    ok: true,
    apply,
    market_id: marketId,
    scanned: 0,
    planned: 0,
    applied: 0,
    skipped: { column_not_empty: 0, not_seeded: 0, registry_empty: 0 },
    plans: [],
    warnings: [],
  }

  const sellerModuleService = resolveService(container, [
    "seller",
    "sellerModuleService",
    "seller_module",
    "ISellerModuleService",
  ])

  const allSellers = await listSellers(sellerModuleService)
  const sellers = marketId
    ? allSellers.filter((seller) => {
        const metadata = isRecord(seller.metadata) ? seller.metadata : {}
        const gp = isRecord(metadata.gp) ? metadata.gp : {}
        return gp.market_id === marketId
      })
    : allSellers

  for (const seller of sellers) {
    summary.scanned += 1
    const plan = planSellerColumnBackfill(seller, summary.skipped)
    if (!plan) continue

    summary.planned += 1
    summary.plans.push(plan)

    if (!apply) {
      console.log(
        `[plan] seller '${plan.handle ?? plan.seller_id}': backfill ${Object.keys(plan.columns).join(", ")}`
      )
      continue
    }

    try {
      await updateSellerRecord(sellerModuleService, plan.seller_id, plan.columns)
      summary.applied += 1
    } catch (error: any) {
      summary.warnings.push(
        `seller '${plan.handle ?? plan.seller_id}': backfill failed — ${error?.message ?? String(error)}`
      )
    }
  }

  summary.ok = summary.warnings.length === 0
  console.log(JSON.stringify(summary, null, 2))

  if (!apply && summary.planned > 0) {
    console.log(
      `\n${summary.planned} seller(s) require a backfill. Re-run with --apply to write.`
    )
  }

  if (!summary.ok) {
    process.exitCode = 1
  }

  return summary
}
