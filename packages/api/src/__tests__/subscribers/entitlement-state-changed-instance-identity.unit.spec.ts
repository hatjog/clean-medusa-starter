/**
 * entitlement-state-changed-instance-identity.unit.spec.ts — v1.16.0 Story 11.2 AC1
 * (NFR-3, AD-49, DW-15-183, DW-15-298 p.4).
 *
 * Każda ścieżka producenta `gp.entitlements.entitlement_state_changed.v1`
 * (oraz `entitlement_refund_applied`) MUSI wpisać do `scope.instance_id`
 * instancję runtime z autorytatywnego nośnika (`GP_INSTANCE_ID`), a entitlement
 * id trzymać we własnym polu (`payload.entitlement_id`). Brak nośnika = odmowa
 * emisji z nazwanym kodem — bez domyślki `gp`/`gp-dev` i bez odczytu z koperty.
 *
 * Kontrola mutantem: przywrócenie `instance_id: <entitlement id>` u któregokolwiek
 * producenta czerwieni asercję `scope.instance_id === RUNTIME` (entitlement id
 * w fixture jest celowo RÓŻNY od instancji). Zdjęcie `requireRuntimeInstanceId`
 * czerwieni przypadki „brak GP_INSTANCE_ID".
 */

import { Modules } from "@medusajs/framework/utils"

jest.mock("../../workflows/entitlements/issue-entitlement", () => {
  class MissingEntitlementProfileError extends Error {}
  class VoucherIssuanceBlockedError extends Error {
    reason = "test_blocked"
    line_item_id: string | null = null
  }
  return {
    __esModule: true,
    issueEntitlementsForAllLineItems: jest.fn(),
    compensateIssuedEntitlement: jest.fn(),
    revokeEntitlementsOnRefund: jest.fn(),
    MissingEntitlementProfileError,
    VoucherIssuanceBlockedError,
  }
})

jest.mock("../../workflows/entitlements/live-issue-from-payment-intent", () => ({
  __esModule: true,
  liveIssueEntitlementsPerLineWithinTx: jest.fn(),
}))

import { issueEntitlementsForAllLineItems } from "../../workflows/entitlements/issue-entitlement"
import { liveIssueEntitlementsPerLineWithinTx } from "../../workflows/entitlements/live-issue-from-payment-intent"
import onOrderPlacedStripeRetry, {
  FIND_DEFERRED_CAPTURES_SQL,
} from "../../subscribers/on-order-placed-stripe-retry"
import voucherLiveIssueSubscriber from "../../subscribers/voucher-live-issue"
import { StripePaymentAuditWorkflow } from "../../workflows/payment/stripe-payment-audit"
import { VoucherService } from "../../modules/voucher"
import { STRIPE_PATH_Y_WEBHOOK_PROVIDER } from "../../lib/payment/stripe-payment-intent-transport"
import {
  ENTITLEMENT_STATE_CHANGED_EVENT_TYPE,
  type TransitionEventEnvelope,
} from "../../modules/voucher/entitlement-transition-wiring"
import {
  RUNTIME_INSTANCE_UNCONFIGURED_ERROR_CODE,
  RuntimeInstanceIdentityError,
  requireRuntimeInstanceId,
} from "../../lib/runtime-instance-identity"

const RUNTIME = "gp-bonbeauty-a"
const ENT = `ent_${"c".repeat(64)}`
const PREVIOUS = process.env.GP_INSTANCE_ID

beforeEach(() => {
  process.env.GP_INSTANCE_ID = RUNTIME
  ;(liveIssueEntitlementsPerLineWithinTx as jest.Mock).mockReset()
  ;(issueEntitlementsForAllLineItems as jest.Mock).mockReset()
})
afterAll(() => {
  if (PREVIOUS === undefined) delete process.env.GP_INSTANCE_ID
  else process.env.GP_INSTANCE_ID = PREVIOUS
})

type Emitted = { name: string; data: unknown }

function stateChanged(emit: jest.Mock): TransitionEventEnvelope[] {
  return (emit.mock.calls as Array<[Emitted]>)
    .map(([m]) => m)
    .filter((m) => m.name === ENTITLEMENT_STATE_CHANGED_EVENT_TYPE)
    .map((m) => m.data as TransitionEventEnvelope)
}

function expectRuntimeIdentity(events: TransitionEventEnvelope[]): void {
  expect(events.length).toBeGreaterThan(0)
  for (const event of events) {
    expect(event.scope.instance_id).toBe(RUNTIME)
    expect(event.scope.instance_id).not.toBe(ENT)
    expect(event.payload.entitlement_id).toBe(ENT)
  }
}

function makeContainer(client: { query: jest.Mock; release: jest.Mock }) {
  const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() }
  const eventBus = { emit: jest.fn().mockResolvedValue(undefined) }
  const container = {
    logger,
    resolve: (key: string) => {
      if (key === "__pg_pool__") return { connect: async () => client }
      if (key === "logger") return logger
      if (key === Modules.EVENT_BUS) return eventBus
      throw new Error(`unexpected resolve(${key})`)
    },
  }
  return { container, logger, eventBus }
}

function genericClient(rows: unknown[] = []) {
  return {
    query: jest.fn(async (sql: string, values: unknown[] = []) => {
      if (sql === FIND_DEFERRED_CAPTURES_SQL) return { rows, rowCount: rows.length }
      if (sql.includes("SET state = 'ACTIVE'")) return { rows: [{ id: values[0] }], rowCount: 1 }
      if (sql.includes("INSERT INTO webhook_event_processed")) return { rows: [], rowCount: 1 }
      return { rows: [], rowCount: 0 }
    }),
    release: jest.fn(),
  }
}

describe("Story 11.2 AC1 — źródło instancji producenta", () => {
  it("requireRuntimeInstanceId zwraca GP_INSTANCE_ID, a bez niego odmawia z nazwanym kodem", () => {
    expect(requireRuntimeInstanceId("t")).toBe(RUNTIME)
    delete process.env.GP_INSTANCE_ID
    let caught: unknown
    try {
      requireRuntimeInstanceId("t")
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(RuntimeInstanceIdentityError)
    expect((caught as RuntimeInstanceIdentityError).error_code).toBe(
      RUNTIME_INSTANCE_UNCONFIGURED_ERROR_CODE
    )
    // Bez domyślki: wartość spoza kształtu też jest odmową, nie „gp".
    expect(() => requireRuntimeInstanceId("t", "  ")).toThrow(RuntimeInstanceIdentityError)
    expect(() => requireRuntimeInstanceId("t", "gp dev")).toThrow(RuntimeInstanceIdentityError)
  })
})

describe("Story 11.2 AC1 — voucher-live-issue (geneza ISSUED Path Y live)", () => {
  const envelope = {
    event_type: "gp.stripe.payment_intent_succeeded.v1",
    // Koperta wejściowa niesie INNĄ wartość — producent nie może jej przepisać.
    scope: { instance_id: "gp-from-envelope", market_id: "bonbeauty" },
    payload: {
      payment_intent_id: "pi_1",
      order_id: "order_1",
      currency: "PLN",
      amount_minor: 25000,
      psp_occurred_at: "2026-11-14T10:00:00.000Z",
    },
  }

  it("scope.instance_id = GP_INSTANCE_ID, entitlement id w payload.entitlement_id", async () => {
    ;(liveIssueEntitlementsPerLineWithinTx as jest.Mock).mockResolvedValueOnce({
      event_processed: true,
      issued: [{ entitlement_id: ENT, entitlement_dedupe_key: "c".repeat(64), created: true }],
      line_outcomes: [],
      failed_lines: [],
    })
    const h = makeContainer(genericClient())
    await voucherLiveIssueSubscriber({
      event: { name: "gp.stripe.payment_intent_succeeded.v1", data: envelope },
      container: h.container,
    } as never)
    const events = stateChanged(h.eventBus.emit)
    expectRuntimeIdentity(events)
    expect(events[0].payload.to_state).toBe("ISSUED")
  })

  it("brak GP_INSTANCE_ID = odmowa PRZED tx: zero issue, zero emisji", async () => {
    delete process.env.GP_INSTANCE_ID
    const h = makeContainer(genericClient())
    await expect(
      voucherLiveIssueSubscriber({
        event: { name: "gp.stripe.payment_intent_succeeded.v1", data: envelope },
        container: h.container,
      } as never)
    ).rejects.toBeInstanceOf(RuntimeInstanceIdentityError)
    expect(liveIssueEntitlementsPerLineWithinTx).not.toHaveBeenCalled()
    expect(h.eventBus.emit).not.toHaveBeenCalled()
  })
})

describe("Story 11.2 AC1 — on-order-placed-stripe-retry (genesis Path Y + odzysk captured)", () => {
  const pathYRow = {
    event_id: "evt_1#deferred-issuance",
    provider: STRIPE_PATH_Y_WEBHOOK_PROVIDER,
    market_id: "bonbeauty",
    envelope: {
      entitlement_issue_deferred_reason: "webhook_before_order",
      psp_occurred_at: "2026-11-14T10:00:00.000Z",
    },
    amount: 25000,
    currency_code: "pln",
    payment_id: "pay_1",
    payment_intent_id: "pi_1",
  }

  it("Path Y: ISSUED i ACTIVE niosą instancję runtime, nie entitlement id (DW-15-298 p.4)", async () => {
    ;(liveIssueEntitlementsPerLineWithinTx as jest.Mock).mockResolvedValueOnce({
      event_processed: true,
      issued: [{ entitlement_id: ENT, entitlement_dedupe_key: "c".repeat(64), created: true }],
      line_outcomes: [],
      failed_lines: [],
    })
    const h = makeContainer(genericClient([pathYRow]))
    await (onOrderPlacedStripeRetry as unknown as (a: unknown) => Promise<void>)({
      event: { data: { id: "order_1" } },
      container: h.container,
    })
    const events = stateChanged(h.eventBus.emit)
    expect(events.map((e) => e.payload.to_state)).toEqual(["ISSUED", "ACTIVE"])
    expectRuntimeIdentity(events)
  })

  it("odzysk captured (stripe): geneza ACTIVE niesie instancję runtime", async () => {
    ;(issueEntitlementsForAllLineItems as jest.Mock).mockResolvedValueOnce({
      results: [{ entitlement_id: ENT, idempotent: false }],
    })
    const h = makeContainer(genericClient([{ ...pathYRow, provider: "stripe" }]))
    await (onOrderPlacedStripeRetry as unknown as (a: unknown) => Promise<void>)({
      event: { data: { id: "order_1" } },
      container: h.container,
    })
    expectRuntimeIdentity(stateChanged(h.eventBus.emit))
  })

  it("odzysk captured bez GP_INSTANCE_ID: nazwana odmowa PRZED wystawieniem, wiersz nierozwiązany, zero eventów", async () => {
    delete process.env.GP_INSTANCE_ID
    ;(issueEntitlementsForAllLineItems as jest.Mock).mockResolvedValueOnce({
      results: [{ entitlement_id: ENT, idempotent: false }],
    })
    const client = genericClient([{ ...pathYRow, provider: "stripe" }])
    const h = makeContainer(client)
    await (onOrderPlacedStripeRetry as unknown as (a: unknown) => Promise<void>)({
      event: { data: { id: "order_1" } },
      container: h.container,
    })
    expect(stateChanged(h.eventBus.emit)).toHaveLength(0)
    // Review R-5: kontrola PRZED wystawieniem — zero uprawnień, zero
    // `markDeferredResolved`, a transakcja paczki dochodzi do COMMIT (klasa
    // obsłużona w pętli wierszy, nie wywrotka całej paczki).
    expect(issueEntitlementsForAllLineItems).not.toHaveBeenCalled()
    const sqls = (client.query.mock.calls as Array<[string]>).map(([sql]) => sql)
    expect(sqls.some((sql) => /UPDATE\s+webhook_event_processed/i.test(sql))).toBe(false)
    expect(sqls).toContain("COMMIT")
    expect(sqls).not.toContain("ROLLBACK")
    expect(h.logger.error).toHaveBeenCalledWith(
      expect.stringContaining("RuntimeInstanceIdentityError")
    )
    expect(h.logger.error).toHaveBeenCalledWith(
      expect.stringContaining(RUNTIME_INSTANCE_UNCONFIGURED_ERROR_CODE)
    )
  })
})

describe("Story 11.2 AC1 — stripe-payment-audit (captured instant-issue)", () => {
  function payload() {
    return {
      event_id: "evt_cap_1",
      request_id: "req_1",
      payment_intent_id: "pi_cap_1",
      payment_id: "pay_cap_1",
      order_id: "ord_cap_1",
      market_id: "bonbeauty",
      payment_method_type: "card",
      processing_country: "PL",
      amount_minor: 19900,
      currency: "PLN",
      entitlement_profile: {
        profile_id: "voucher-kwotowy-365d",
        entitlement_type: "VOUCHER_AMOUNT",
        policy: { validity_days: 365 },
        currency: "PLN",
        amount_minor: 19900,
      },
    }
  }

  function workflow() {
    const client = genericClient()
    const eventBus = { emit: jest.fn().mockResolvedValue(undefined) }
    const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() }
    const connect = jest.fn(async () => client)
    const wf = new StripePaymentAuditWorkflow({ connect } as never, eventBus, logger)
    return { wf, eventBus, connect, client }
  }

  it("geneza ACTIVE: scope.instance_id = GP_INSTANCE_ID", async () => {
    ;(issueEntitlementsForAllLineItems as jest.Mock).mockResolvedValueOnce({
      results: [{ entitlement_id: ENT, idempotent: false }],
    })
    const { wf, eventBus } = workflow()
    await wf.process("payment.captured", payload() as never)
    expectRuntimeIdentity(stateChanged(eventBus.emit))
  })

  it("brak GP_INSTANCE_ID: transakcja odrzucona, zero emisji", async () => {
    delete process.env.GP_INSTANCE_ID
    ;(issueEntitlementsForAllLineItems as jest.Mock).mockResolvedValueOnce({
      results: [{ entitlement_id: ENT, idempotent: false }],
    })
    const { wf, eventBus, connect, client } = workflow()
    await expect(wf.process("payment.captured", payload() as never)).rejects.toBeInstanceOf(
      RuntimeInstanceIdentityError
    )
    expect(stateChanged(eventBus.emit)).toHaveLength(0)
    // Review R-5: odmowa PRZED transakcją — brak połączenia, brak wiersza
    // dedupe i brak wystawienia uprawnień (fail-closed zanim cokolwiek się zapisze).
    expect(connect).not.toHaveBeenCalled()
    expect(client.query).not.toHaveBeenCalled()
    expect(issueEntitlementsForAllLineItems).not.toHaveBeenCalled()
  })

  it("brak GP_INSTANCE_ID nie blokuje zdarzeń bez wystawienia (captured bez order_id)", async () => {
    delete process.env.GP_INSTANCE_ID
    const { wf, connect } = workflow()
    const noOrder = { ...payload(), order_id: undefined }
    await wf.process("payment.captured", noOrder as never)
    expect(connect).toHaveBeenCalled()
    expect(issueEntitlementsForAllLineItems).not.toHaveBeenCalled()
  })
})

describe("Story 11.2 (review R-5) — subscriber stripe-payment-audit obsługuje nazwaną odmowę", () => {
  it("RuntimeInstanceIdentityError z workflow ⇒ osobny log z kodem i rzut dalej (bez częściowego zapisu)", async () => {
    const refused = new RuntimeInstanceIdentityError("stripe-payment-audit")
    const run = jest.fn().mockRejectedValue(refused)
    const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() }
    let subscriber: (a: unknown) => Promise<void> = async () => undefined
    jest.isolateModules(() => {
      jest.doMock("../../workflows/payment/stripe-payment-audit", () => ({
        ...jest.requireActual("../../workflows/payment/stripe-payment-audit"),
        __esModule: true,
        stripePaymentAuditWorkflow: () => ({ run }),
      }))
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      subscriber = require("../../subscribers/stripe-payment-audit").default
    })
    await expect(
      subscriber({
        event: {
          name: "payment.captured",
          data: { event_id: "evt_1", payment_intent_id: "pi_1", request_id: "req_1" },
        },
        container: { logger },
      })
    ).rejects.toBe(refused)
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining(`error_code=${RUNTIME_INSTANCE_UNCONFIGURED_ERROR_CODE}`)
    )
    expect(logger.error).not.toHaveBeenCalledWith(expect.stringContaining("failed:"))
  })
})

describe("Story 11.2 (review R-1) — VoucherService.resolveTransitionScope (cancel_booking → ACTIVE i pozostałe tranzycje serwisu)", () => {
  type ScopeBuilder = {
    resolveTransitionScope: (row: { id: string; market_id: string; sales_channel_id?: string | null }) => {
      instance_id: string
      market_id: string
    }
  }

  it("scope.instance_id = GP_INSTANCE_ID, nie id uprawnienia", () => {
    const svc = new VoucherService({}, {}) as unknown as ScopeBuilder
    const scope = svc.resolveTransitionScope({ id: ENT, market_id: "bonbeauty" })
    expect(scope.instance_id).toBe(RUNTIME)
    expect(scope.instance_id).not.toBe(ENT)
    expect(scope.market_id).toBe("bonbeauty")
  })

  it("brak GP_INSTANCE_ID ⇒ RuntimeInstanceIdentityError (bez domyślki)", () => {
    delete process.env.GP_INSTANCE_ID
    const svc = new VoucherService({}, {}) as unknown as ScopeBuilder
    expect(() => svc.resolveTransitionScope({ id: ENT, market_id: "bonbeauty" })).toThrow(
      RuntimeInstanceIdentityError
    )
  })
})

describe("Story 11.2 AC1 — VoucherService.refund_request (entitlement_refund_applied)", () => {
  it("brak GP_INSTANCE_ID: odmowa PRZED połączeniem z bazą", async () => {
    delete process.env.GP_INSTANCE_ID
    const connect = jest.fn()
    const svc = new VoucherService({}, {}) as unknown as {
      _testPool: unknown
      refund_request: VoucherService["refund_request"]
    }
    svc._testPool = { connect, query: jest.fn() }
    await expect(
      svc.refund_request(ENT, { refund_id: "r1", amount: 100, currency: "PLN" })
    ).rejects.toBeInstanceOf(RuntimeInstanceIdentityError)
    expect(connect).not.toHaveBeenCalled()
  })
})
