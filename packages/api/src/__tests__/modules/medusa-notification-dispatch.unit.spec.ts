/**
 * MedusaNotificationDispatchAdapter — Step 3 kontraktu D-72 (Story 2.2, AC4).
 *
 * Powód istnienia tego pliku (review 2.2): realny adapter nie miał ANI JEDNEGO
 * testu — testy D-72 wstrzykują `FakeNotificationDispatch`, więc ścieżka
 * produkcyjna była niepokryta. Kluczowa własność do zabezpieczenia to R-2.2-H2:
 * odczyt `voucher_recipient_pii` (jedyna tabela z `FORCE ROW LEVEL SECURITY`)
 * MUSI biec w jawnym kontekście rynku, bo `executeDeliveryStep` woła subscriber
 * — poza ALS store-requestu, gdzie `rls-pool-hook` ustawia GUC. Bez tego polityka
 * jest fail-closed: 0 wierszy → `dlq_provider_failed` dla KAŻDEJ dostawy.
 *
 * Test nie potrzebuje żywego PG: sprawdza kontrakt zapytania (transakcja +
 * `set_config('app.gp_market_id', …, true)` przed SELECT-em). Weryfikacja na
 * żywej bazie z rolą podlegającą RLS pozostaje testem integracyjnym.
 */

import {
  MedusaNotificationDispatchAdapter,
  VoucherDeliveryDispatchError,
} from "../../modules/voucher-pii/adapters/medusa-notification-dispatch";

type RawCall = { sql: string; bindings: unknown[] };

function makeDb(row: Record<string, unknown> | undefined) {
  const raws: RawCall[] = [];
  const wheres: Array<Record<string, unknown>> = [];
  const tables: string[] = [];
  let whereNullCalled = false;

  const trx = ((table: string) => {
    tables.push(table);
    const qb = {
      select: () => qb,
      where: (clause: Record<string, unknown>) => {
        wheres.push(clause);
        return qb;
      },
      whereNull: () => {
        whereNullCalled = true;
        return qb;
      },
      first: async () => row,
    };
    return qb;
  }) as unknown as Record<string, unknown> & ((table: string) => unknown);

  (trx as unknown as { raw: unknown }).raw = async (
    sql: string,
    bindings: unknown[],
  ) => {
    raws.push({ sql, bindings });
  };

  // Zapytanie POZA transakcją = brak kontekstu rynku → test ma to wykryć.
  const db = (() => {
    throw new Error("odczyt PII poza transakcją z kontekstem rynku");
  }) as unknown as Record<string, unknown> & (() => unknown);
  (db as unknown as { transaction: unknown }).transaction = async (
    cb: (t: unknown) => Promise<unknown>,
  ) => cb(trx);

  return {
    db: db as never,
    raws,
    wheres,
    tables,
    whereNullCalled: () => whereNullCalled,
  };
}

function makeScope(notificationModule: unknown) {
  return { resolve: () => notificationModule };
}

const ARGS = {
  consent_audit_id: "audit-1",
  market_id: "bonbeauty",
  recipient_id: "pii-1",
  delivery_decision_id: "dd-1",
  request_id: "req-1",
};

describe("MedusaNotificationDispatchAdapter (AC4 / R-2.2-H2)", () => {
  it("ustawia app.gp_market_id w transakcji PRZED odczytem voucher_recipient_pii", async () => {
    const createNotifications = jest.fn(async () => ({ id: "notif-1" }));
    const { db, raws, wheres, tables } = makeDb({
      recipient_email: "buyer@example.test",
      locale: "pl",
    });
    const adapter = new MedusaNotificationDispatchAdapter(
      makeScope({ createNotifications }),
      db,
    );

    await adapter.dispatch(ARGS);

    expect(raws).toHaveLength(1);
    expect(raws[0].sql).toContain("set_config('app.gp_market_id'");
    // `is_local = true` — GUC znika z transakcją, zero wycieku na pulę połączeń.
    expect(raws[0].sql).toContain("true");
    expect(raws[0].bindings).toEqual(["bonbeauty"]);
    expect(tables).toEqual(["voucher_recipient_pii"]);
    expect(wheres[0]).toEqual({ id: "pii-1", market_id: "bonbeauty" });
  });

  it("zwraca provider_message_id i wysyła TOP-LEVEL idempotency_key (R-2.2-I2)", async () => {
    const createNotifications = jest.fn(async () => ({ id: "notif-7" }));
    const { db } = makeDb({ recipient_email: "buyer@example.test", locale: "ua" });
    const adapter = new MedusaNotificationDispatchAdapter(
      makeScope({ createNotifications }),
      db,
    );

    const result = await adapter.dispatch(ARGS);

    expect(result).toEqual({ provider_message_id: "notif-7" });
    const payload = (createNotifications.mock.calls as unknown as unknown[][])[0][0] as Record<
      string,
      unknown
    >;
    expect(payload.idempotency_key).toBe("voucher-delivery:audit-1");
    expect(payload.to).toBe("buyer@example.test");
    expect(payload.data).toMatchObject({
      market_id: "bonbeauty",
      locale: "ua",
      idempotency_key: "voucher-delivery:audit-1",
      template_key: "voucher_purchase_confirmation",
    });
  });

  it("brak dostępnego odbiorcy → fail-loud, zero wysyłki", async () => {
    const createNotifications = jest.fn();
    const { db } = makeDb(undefined);
    const adapter = new MedusaNotificationDispatchAdapter(
      makeScope({ createNotifications }),
      db,
    );

    await expect(adapter.dispatch(ARGS)).rejects.toMatchObject({
      error_code: "VOUCHER_DELIVERY_RECIPIENT_UNAVAILABLE",
    });
    expect(createNotifications).not.toHaveBeenCalled();
  });

  it("brak modułu Notification → fail-loud PRZED dotknięciem PII", async () => {
    const { db, raws } = makeDb({ recipient_email: "buyer@example.test" });
    const adapter = new MedusaNotificationDispatchAdapter(
      { resolve: () => undefined },
      db,
    );

    await expect(adapter.dispatch(ARGS)).rejects.toBeInstanceOf(
      VoucherDeliveryDispatchError,
    );
    expect(raws).toHaveLength(0);
  });
});
