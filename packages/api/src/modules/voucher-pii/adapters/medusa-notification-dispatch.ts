/**
 * medusa-notification-dispatch — produkcyjna implementacja `NotificationDispatchPort`
 * (Story 2.2, AC4; AD-5).
 *
 * Step 3 kontraktu D-72 przestaje być stubem: dispatch idzie przez
 * `Modules.NOTIFICATION` (a NIE przez `MessagingGateway` bezpośrednio i NIE przez
 * `stub-email-v1`), więc mail vouchera jedzie tą samą, kontrolowaną ścieżką co
 * cała reszta platformy.
 *
 * Zakres 2.2 kończy się na kanale: treść/wariant maila zakupowego, ledger
 * `voucher_delivery_dispatch` i subscriber `voucher-purchase-delivery` należą do
 * Story 2.3 — tutaj wysyłamy kanoniczny klucz rejestru
 * `voucher_purchase_confirmation`, którego ID w Brevo jest dziś `not_configured`,
 * więc provider kończy fail-loud `BREVO_TEMPLATE_NOT_CONFIGURED`. To zamierzone:
 * orchestrator zapisuje `dlq_provider_failed` zamiast udawać sukces stuba.
 *
 * PII: adres odbiorcy jest czytany z `voucher_recipient_pii` po `recipient_id`
 * dokładnie w momencie wysyłki i NIGDY nie trafia do audytu ani do eventu
 * (D-70) — orchestrator dostaje z powrotem wyłącznie `provider_message_id`.
 */

import type { Knex } from "knex";

import { Modules } from "@medusajs/framework/utils";
import { NOTIFICATION_TEMPLATE_KEYS } from "@gp/messaging";

import type { NotificationDispatchPort } from "../ports";

type NotificationModuleLike = {
  createNotifications?: (data: unknown, ...rest: unknown[]) => Promise<unknown>;
  send?: (data: unknown, ...rest: unknown[]) => Promise<unknown>;
};

type ScopeResolver = { resolve: (key: string) => unknown };

export class VoucherDeliveryDispatchError extends Error {
  readonly error_code: string;

  constructor(message: string, errorCode: string) {
    super(message);
    this.name = "VoucherDeliveryDispatchError";
    this.error_code = errorCode;
  }
}

export interface MedusaNotificationDispatchAdapterOptions {
  /** Provider zapisywany do `provider_ref` (domyślnie kanoniczny `brevo`). */
  providerRef?: string;
}

export class MedusaNotificationDispatchAdapter implements NotificationDispatchPort {
  readonly providerRef: string;

  constructor(
    private readonly scope: ScopeResolver,
    private readonly db: Knex,
    options: MedusaNotificationDispatchAdapterOptions = {},
  ) {
    this.providerRef = options.providerRef ?? "brevo";
  }

  async dispatch(args: {
    consent_audit_id: string;
    market_id: string;
    recipient_id: string;
    delivery_decision_id: string;
    request_id: string;
  }): Promise<{ provider_message_id: string | null }> {
    const notificationModule = this.resolveNotificationModule();

    const recipient = await this.readRecipient(args.recipient_id, args.market_id);

    const to = typeof recipient?.recipient_email === "string" ? recipient.recipient_email.trim() : "";
    if (!to) {
      // Zgoda wycofana / rekord tombstonowany / brak adresu — fail-loud, nigdy
      // wysyłka „w ciemno" i nigdy cichy sukces.
      throw new VoucherDeliveryDispatchError(
        `No dispatchable recipient for recipient_pii_id=${args.recipient_id}`,
        "VOUCHER_DELIVERY_RECIPIENT_UNAVAILABLE",
      );
    }

    const idempotencyKey = `voucher-delivery:${args.consent_audit_id}`;
    const payload = {
      to,
      channel: "email",
      template: NOTIFICATION_TEMPLATE_KEYS.VOUCHER_PURCHASE_CONFIRMATION,
      // R-2.2-I2: Medusa dedupikuje po TOP-LEVELOWYM `idempotency_key`
      // (`NotificationModuleService.createNotifications_` robi lookup
      // `notificationService_.list({ idempotency_key })`) — to trwały,
      // międzyprocesowy dedupe, którego dotąd nie używaliśmy. Kopia w `data`
      // zostaje, bo konsumuje ją in-memory cache gatewaya (inna warstwa).
      idempotency_key: idempotencyKey,
      data: {
        template_key: NOTIFICATION_TEMPLATE_KEYS.VOUCHER_PURCHASE_CONFIRMATION,
        market_id: args.market_id,
        locale: typeof recipient?.locale === "string" ? recipient.locale : "pl",
        flow_id: "voucher_purchase_delivery",
        idempotency_key: idempotencyKey,
        consent_audit_id: args.consent_audit_id,
        delivery_decision_id: args.delivery_decision_id,
        request_id: args.request_id,
      },
    };

    const result =
      typeof notificationModule.createNotifications === "function"
        ? await notificationModule.createNotifications(payload)
        : await notificationModule.send?.(payload);

    return { provider_message_id: extractNotificationId(result) };
  }

  /**
   * R-2.2-H2: odczyt `voucher_recipient_pii` w JAWNYM kontekście rynku.
   *
   * Tabela ma `ENABLE` **oraz** `FORCE ROW LEVEL SECURITY` (jedyna taka w repo),
   * a polityka porównuje `market_id` z GUC `app.gp_market_id`. GUC ustawia
   * wyłącznie `lib/rls-pool-hook.ts` i tylko wtedy, gdy ALS ma kontekst rynku
   * store-requestu. `executeDeliveryStep` biegnie z SUBSCRIBERA — poza tym ALS —
   * więc bez tego `set_config` polityka jest fail-closed: 0 wierszy → każdy
   * realny Step-3 degradowałby do `dlq_provider_failed`, wyglądając jak „problem
   * z Brevo", a nie jak błąd izolacji. Na dev (superuser omija RLS) byłoby to
   * niewidoczne — dlatego kontekst ustawiamy jawnie, transakcyjnie
   * (`is_local = true` → GUC znika razem z transakcją, zero wycieku na pulę).
   */
  private async readRecipient(
    recipientId: string,
    marketId: string,
  ): Promise<{ recipient_email?: unknown; locale?: unknown } | undefined> {
    return this.db.transaction(async (trx) => {
      await trx.raw("SELECT set_config('app.gp_market_id', ?, true)", [marketId]);
      return trx("voucher_recipient_pii")
        .select("recipient_email", "locale")
        .where({ id: recipientId, market_id: marketId })
        .whereNull("tombstoned_at")
        .first();
    });
  }

  private resolveNotificationModule(): NotificationModuleLike {
    let module: NotificationModuleLike | undefined;
    try {
      module = this.scope.resolve(Modules.NOTIFICATION) as NotificationModuleLike | undefined;
    } catch {
      module = undefined;
    }

    if (
      !module ||
      (typeof module.createNotifications !== "function" && typeof module.send !== "function")
    ) {
      throw new VoucherDeliveryDispatchError(
        "Notification module is not registered in the runtime container",
        "VOUCHER_DELIVERY_NOTIFICATION_MODULE_UNAVAILABLE",
      );
    }

    return module;
  }
}

function extractNotificationId(value: unknown): string | null {
  if (!value) return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const nested = extractNotificationId(item);
      if (nested) return nested;
    }
    return null;
  }
  if (typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (typeof record.id === "string" && record.id) return record.id;
  for (const key of ["data", "notification", "notifications", "result", "results"] as const) {
    const nested = extractNotificationId(record[key]);
    if (nested) return nested;
  }
  return null;
}
