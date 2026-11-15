/**
 * data-export-recipient.ts — RODO Art. 15 (data subject access request) dla odbiorcy vouchera.
 *
 * Admin CLI: eksportuje wszystkie dane, które trzymamy o odbiorcy jako podmiocie danych.
 *
 * Usage — argumenty POZYCYJNE, bez `--` i bez prefiksu `--` przy kluczach:
 *
 *   pnpm --ignore-workspace exec medusa exec \
 *     ./packages/api/src/scripts/data-export-recipient.ts \
 *     subject=recipient voucher=<voucher_code> market=<market_id>
 *
 *   pnpm --ignore-workspace exec medusa exec \
 *     ./packages/api/src/scripts/data-export-recipient.ts \
 *     subject=recipient email=<recipient_email> market=<market_id> \
 *     operator=<kto> dsar_request_id=<id_wniosku>
 *
 * Forma z oryginalnej wersji (`… -- --subject=…`) NIE DZIAŁA i została zmierzona:
 * `medusa exec` deklaruje `[args..]` jako pozycyjne, więc yargs odrzuca nieznane opcje
 * (`Unknown arguments: subject, voucher`), a przy separatorze `--` argumenty giną i skrypt
 * dostaje pustą listę. Wywołanie przez wpis w `package.json` (`pnpm run … -- …`) też ich
 * nie dowozi — dlatego takiego wpisu tu świadomie NIE MA. Sprawdzone sondą:
 * `medusa exec <plik> a=1 b=2` → `args = ["a=1","b=2"]`.
 *
 * WYMÓG AUDYTOWY: każde wywołanie MUSI dopisać wpis `DSAR_ACCESS` do łańcucha
 * `voucher_pii_consent_audit` ZANIM pobierze jakiekolwiek dane — dostęp jest częścią
 * łańcucha odpornego na manipulację (ADR-078, D-67).
 *
 * ── Historia tego pliku, bo bez niej wygląda na nowy ────────────────────────────
 *
 * Narzędzie powstało w v1.6.0 (cleanup-6 CRIT-6.4) i **nigdy nie trafiło do `main`** —
 * żyło wyłącznie na dwóch porzuconych gałęziach. Zmierzone 2026-08-10: obowiązek DSAR
 * jest zadeklarowany w ADR-065 (indeks „per-subject query (Art. 15 right to access)"),
 * w kontrakcie `consent-privacy-dsar-integrity.v1.schema.json`, w konstytucji
 * (`eprivacy-policy.md`) i w rejestrze bramek (`consent-privacy-dsar-integrity`,
 * profil `full`, wymaga `runbook_ref` + `e2e_evidence_ref` + `audit_evidence_ref`).
 * Tabela audytu istnieje. Nośnika nie było: `grep DSAR_ACCESS` po kodzie dawał zero trafień.
 *
 * Wersja z gałęzi była przy tym niesprawna wobec DZISIEJSZEGO schematu w trzech miejscach
 * — odtworzenie jej dosłownie oznaczałoby wprowadzenie narzędzia, które rzuca wyjątkiem
 * albo, gorzej, **łamie łańcuch audytu**:
 *
 *   1. `FROM gp_core.entitlements WHERE voucher_code = $1` — relacji nie ma; `gp_mercur`
 *      ma pusty schemat `gp_core`, a kod vouchera żyje dziś w `voucher_event.voucher_code`
 *      razem z `entitlement_id`.
 *   2. `voucher_recipient_pii.deleted_at` — kolumna nazywa się dziś `tombstoned_at`.
 *   3. `INSERT INTO voucher_pii_consent_audit (recipient_pii_id, action, metadata)` —
 *      żadnej z tych kolumn już nie ma. Tabela jest łańcuchem hashowanym
 *      (`hour_bucket`, `prev_row_hash`, `current_row_hash`, `payload`), więc surowy INSERT
 *      albo padnie, albo wstawi wiersz spoza łańcucha i **zniszczy dokładnie tę własność,
 *      dla której ten audyt istnieje**.
 *
 * Dlatego zapis audytowy idzie przez `PgAuditAdapter.appendAuditRow` — ten sam nośnik,
 * którego używa `VoucherPiiService`. Chain jest liczony, nie zgadywany.
 *
 * @see specs/adr/2026-04-27-adr-065-voucher-pii-retention.md
 * @see specs/contracts/governance/schemas/consent-privacy-dsar-integrity.v1.schema.json
 * @see DW-15-131 — runbook `specs/legal/recipient-dsar-runbook.md` nadal nie istnieje
 */

import type { ExecArgs } from "@medusajs/framework/types";
import { ContainerRegistrationKeys } from "@medusajs/framework/utils";
import type { Knex } from "knex";

import { PgAuditAdapter } from "../modules/voucher-pii/adapters/pg-audit";
import {
  assertRecipientPiiMarketAccess,
  RecipientPiiMarketAccessDeniedError,
} from "../modules/voucher-pii/recipient-pii-market-guard";
import { GP_MARKET_SESSION_VAR } from "../lib/rls-pool-hook";

/** Ścieżka runbooka wymaganego przez bramkę `consent-privacy-dsar-integrity`. */
export const DSAR_RUNBOOK_PATH = "specs/legal/recipient-dsar-runbook.md";

export interface ExportArgs {
  subject?: string;
  voucher?: string;
  email?: string;
  market?: string;
  dsar_request_id?: string;
  operator?: string;
}

export function parseArgs(argv: string[] | undefined): ExportArgs {
  const args: ExportArgs = {};
  for (const arg of argv ?? []) {
    const [key, ...rest] = arg.replace(/^--/, "").split("=");
    const value = rest.join("=");
    if (key && value) {
      (args as Record<string, string>)[key] = value;
    }
  }
  return args;
}

export interface RecipientPiiRow {
  id: string;
  market_id: string;
  entitlement_id: string | null;
  order_id: string | null;
  recipient_email: string | null;
  recipient_phone: string | null;
  locale: string | null;
  is_gift: boolean | null;
  created_at: Date;
  tombstoned_at: Date | null;
}

/**
 * Lokalizuje wiersze PII odbiorcy.
 *
 * Ścieżka `--voucher` idzie przez `voucher_event`, bo to JEDYNE miejsce w schemacie,
 * które wiąże kod vouchera z uprawnieniem (`entitlement_instance` nie niesie kodu).
 */
export async function findRecipientPiiRows(
  db: Knex,
  args: ExportArgs
): Promise<RecipientPiiRow[]> {
  const columns = [
    "id",
    "market_id",
    "entitlement_id",
    "order_id",
    "recipient_email",
    "recipient_phone",
    "locale",
    "is_gift",
    "created_at",
    "tombstoned_at",
  ];

  if (args.voucher) {
    return db("voucher_recipient_pii")
      .select(columns)
      .whereIn(
        "entitlement_id",
        db("voucher_event")
          .distinct("entitlement_id")
          .where({ voucher_code: args.voucher })
          .whereNotNull("entitlement_id")
      )
      .orderBy("created_at", "desc");
  }

  if (args.email && args.market) {
    return db("voucher_recipient_pii")
      .select(columns)
      .where({ recipient_email: args.email, market_id: args.market })
      .orderBy("created_at", "desc");
  }

  throw new Error(
    "[data-export-recipient] Podaj market=<market_id> (wymagany od 11.6) oraz voucher=<kod> ALBO email=<email>"
  );
}

/** Usuwa z ładunku audytu dane INNEGO podmiotu danych (kupującego). */
export function redactOtherSubjects(payload: unknown): unknown {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return payload;
  const copy: Record<string, unknown> = { ...(payload as Record<string, unknown>) };
  for (const key of ["buyer_email", "buyer_phone", "purchaser_email"]) {
    if (key in copy) copy[key] = null;
  }
  return copy;
}

/**
 * Wiersze audytu powiązane z zamówieniami odbiorcy.
 *
 * Powiązanie idzie przez `payload->>'order_id'`, bo kolumny `recipient_pii_id` nie ma
 * od przebudowy tabeli w łańcuch (ten sam wzorzec, którego używa `getLatestForOrder`).
 */
export async function findAuditRows(
  db: Knex,
  orderIds: string[],
  marketIds: string[]
): Promise<Array<{ id: string; market_id: string; payload: unknown; created_at: Date }>> {
  if (orderIds.length === 0) return [];

  const rows = await db("voucher_pii_consent_audit")
    .select(["id", "market_id", "payload", "created_at"])
    .whereIn("market_id", marketIds)
    .whereRaw("payload->>'order_id' = ANY(?)", [orderIds])
    .orderBy("created_at", "asc");

  return rows.map((row) => ({ ...row, payload: redactOtherSubjects(row.payload) }));
}

export async function findDeliveryDecisionRows(
  db: Knex,
  consentAuditIds: string[]
): Promise<unknown[]> {
  if (consentAuditIds.length === 0) return [];

  return db("voucher_delivery_decision")
    .select([
      "id",
      "consent_audit_id",
      "outcome",
      "latency_ms",
      "delivery_attempt_n",
      "dispatched_at",
      "created_at",
    ])
    .whereIn("consent_audit_id", consentAuditIds)
    .orderBy("created_at", "asc");
}

/**
 * Dopisuje `DSAR_ACCESS` do łańcucha — po jednym wpisie na rynek, którego dotyczy zapytanie.
 *
 * Wołane PRZED pobraniem danych (ADR-078). Idzie przez `PgAuditAdapter`, więc
 * `prev_row_hash`/`current_row_hash`/`hour_bucket` liczy nośnik łańcucha, nie ten skrypt.
 */
export async function logDsarAccess(
  db: Knex,
  rows: RecipientPiiRow[],
  args: ExportArgs
): Promise<string[]> {
  const adapter = new PgAuditAdapter(db);
  const dsarRequestId = args.dsar_request_id ?? `dsar-${new Date().toISOString()}`;
  const operator = args.operator ?? "system";
  const auditIds: string[] = [];

  for (const marketId of [...new Set(rows.map((r) => r.market_id))]) {
    const scoped = rows.filter((r) => r.market_id === marketId);
    const { audit_id } = await adapter.appendAuditRow({
      market_id: marketId,
      payload: {
        action: "DSAR_ACCESS",
        dsar_request_id: dsarRequestId,
        operator,
        subject: "recipient",
        query: { voucher: args.voucher ?? null, email: args.email ?? null },
        recipient_pii_ids: scoped.map((r) => r.id),
        order_id: scoped.find((r) => r.order_id)?.order_id ?? null,
        accessed_at: new Date().toISOString(),
      },
    });
    auditIds.push(audit_id);
  }

  return auditIds;
}

const NOT_RETRIEVABLE = {
  idb_queue:
    "NOT_RETRIEVABLE: magazyn IndexedDB po stronie klienta (gp-voucher-offline) leży na " +
    "urządzeniu odbiorcy. Poinstruuj wnioskodawcę, żeby wyczyścił IndexedDB dla domeny " +
    "storefrontu: ustawienia przeglądarki → Application → Storage.",
  redis_session:
    "NOT_RETRIEVABLE: sesja Redis (efemeryczny token recipient_session, TTL ≤7 dni). " +
    "Mogła wygasnąć zanim wniosek DSAR został obsłużony.",
};

export default async function dataExportRecipient({
  container,
  args,
}: ExecArgs): Promise<void> {
  const parsed = parseArgs(args as string[]);

  if (parsed.subject && parsed.subject !== "recipient") {
    throw new Error(
      `[data-export-recipient] --subject musi być 'recipient'. Otrzymano: ${parsed.subject}`
    );
  }

  const pg = container.resolve(ContainerRegistrationKeys.PG_CONNECTION) as Knex;

  // v1.16.0 Story 11.6 (DW-15-362 p.1): eksport DSAR czyta dane obdarowanej
  // WYŁĄCZNIE w jawnie zadeklarowanym rynku (`market=`), przez guard nazwanej
  // odmowy — także ścieżka `voucher=`. Brak rynku = odmowa, nie eksport
  // przekrojowy; log odmowy bez PII.
  const market = parsed.market ?? null;
  if (!market) {
    console.warn(
      "[data-export-recipient] recipient pii market access denied",
      { error_code: "GP_RECIPIENT_PII_MARKET_ACCESS_DENIED", reason: "missing_market_context" }
    );
    throw new RecipientPiiMarketAccessDeniedError("missing_market_context");
  }
  await pg.transaction(async (db) => {
  await db.raw(`SELECT set_config('${GP_MARKET_SESSION_VAR}', ?, true)`, [market]);
  await assertRecipientPiiMarketAccess(db, market);

  // Krok 1 — zlokalizuj wiersze PII (tylko rynku z deklaracji).
  const piiRows = (await findRecipientPiiRows(db, parsed)).filter((r) => r.market_id === market);

  if (piiRows.length === 0) {
    process.stdout.write(
      JSON.stringify(
        {
          data_subject: "recipient",
          query: { voucher: parsed.voucher, email: parsed.email, market: parsed.market },
          found: false,
          tables: {},
          ...NOT_RETRIEVABLE,
          note:
            "Brak rekordów PII odbiorcy dla tego zapytania. Dane mogły zostać usunięte " +
            "przez zamiatanie retencyjne (365 dni).",
          dsar_runbook: DSAR_RUNBOOK_PATH,
          generated_at: new Date().toISOString(),
        },
        null,
        2
      ) + "\n"
    );
    return;
  }

  // Krok 2 — DSAR_ACCESS do łańcucha PRZED pobraniem danych.
  const accessAuditIds = await logDsarAccess(db, piiRows, parsed);

  // Krok 3 — ślad audytowy.
  const orderIds = [...new Set(piiRows.map((r) => r.order_id).filter((v): v is string => !!v))];
  const marketIds = [...new Set(piiRows.map((r) => r.market_id))];
  const auditRows = await findAuditRows(db, orderIds, marketIds);

  // Krok 4 — decyzje dostawy.
  const deliveryRows = await findDeliveryDecisionRows(
    db,
    auditRows.map((r) => r.id)
  );

  process.stdout.write(
    JSON.stringify(
      {
        data_subject: "recipient",
        query: { voucher: parsed.voucher, email: parsed.email, market: parsed.market },
        found: true,
        tables: {
          voucher_recipient_pii: piiRows,
          voucher_pii_consent_audit: auditRows,
          voucher_delivery_decision: deliveryRows,
        },
        ...NOT_RETRIEVABLE,
        redaction_applied: [
          "buyer_email/buyer_phone/purchaser_email wyzerowane w ładunku audytu (inny podmiot danych)",
          `wpis DSAR_ACCESS dopisany do łańcucha przed pobraniem danych (audit_id: ${accessAuditIds.join(", ")})`,
        ],
        dsar_runbook: DSAR_RUNBOOK_PATH,
        generated_at: new Date().toISOString(),
      },
      null,
      2
    ) + "\n"
  );
  });
}
