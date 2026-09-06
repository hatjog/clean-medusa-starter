/**
 * stripe-route-inventory.unit.test.ts — Story 3.1 AC1 (v1.16.0, Epic 3).
 *
 * INWENTARYZACJA JAKO DANE: trzy trasy webhooka Stripe w GP, każda z ownerem,
 * weryfikacją podpisu, kluczem bariery, konsumentem i stanem końcowym. Test
 * porównuje inwentarz z TYM, co jest w repo (konfiguracja middleware'ów, eksporty
 * route'ów, pakiet Medusy w node_modules, konfiguracja subscriberów, stałe
 * `provider`). Rozjazd = FAIL. Kontrola negatywna: zmutowany inwentarz
 * (usunięta trasa / zmieniony status / zmieniony provider) MUSI dać niepusty diff.
 *
 * Lustro dla ludzi: `_bmad-output/releases/v1.16.0/implementation-artifacts/
 * evidence/3-1/stripe-routes-inventory.md` (super-repo). Fakty F-1…F-8 w tym
 * pliku mają te same identyfikatory co w artefakcie.
 */
import { describe, it, expect, jest } from "@jest/globals"
import { existsSync, readFileSync } from "node:fs"
import { createRequire } from "node:module"
import path from "node:path"

import middlewaresConfig from "../../../middlewares"
import { POST as retiredPOST, AUTHENTICATE as retiredAUTHENTICATE } from "../route"
import { STRIPE_WEBHOOK_RETIRED_MESSAGE } from "../helpers"
import { AUTHENTICATE as pathYAUTHENTICATE } from "../payment-intent/route"
import { config as pathYSubscriberConfig } from "../../../../subscribers/voucher-live-issue"
import { config as nativeSubscriberConfig } from "../../../../subscribers/stripe-payment-audit"
import { PAYMENT_INTENT_SUCCEEDED_EVENT } from "../../../../lib/payment/stripe-payment-intent-event"
import {
  STRIPE_NATIVE_WEBHOOK_PROVIDER,
  STRIPE_PATH_Y_WEBHOOK_PROVIDER,
  WEBHOOK_DELIVERY_BARRIER_TABLE,
} from "../../../../lib/payment/stripe-webhook-barrier-contract"

// ── Inwentarz (SSOT tego testu; lustro w evidence/3-1/stripe-routes-inventory.md)

type RouteOwner = "medusa-native" | "gp"
type RouteStatus = "live" | "retired"

type StripeRouteInventoryEntry = {
  path: string
  owner: RouteOwner
  status: RouteStatus
  /** Kto rozstrzyga o podpisie Stripe. */
  signature_verifier: string
  /** Klucz bariery poziomu 1 (`webhook_event_processed`) albo `null` dla trasy bez bariery. */
  barrier: { table: string; provider: string } | null
  /** Zdarzenie, którym trasa zasila konsumenta, albo `null`. */
  consumer_event: string | null
  /** Stan końcowy entitlementu produkowany przez konsumenta, albo `null`. */
  terminal_state: "ACTIVE" | "ISSUED" | null
  /** Kod HTTP zwracany Stripe'owi w ścieżce nominalnej. */
  nominal_http: number
}

export const STRIPE_ROUTE_INVENTORY: ReadonlyArray<StripeRouteInventoryEntry> = [
  {
    path: "/hooks/payment/stripe",
    owner: "medusa-native",
    status: "live",
    signature_verifier: "@medusajs/payment-stripe (webhooks.constructEvent w providerze, PO odpowiedzi 200)",
    barrier: { table: WEBHOOK_DELIVERY_BARRIER_TABLE, provider: STRIPE_NATIVE_WEBHOOK_PROVIDER },
    consumer_event: "payment.captured",
    terminal_state: "ACTIVE",
    nominal_http: 200,
  },
  {
    path: "/webhooks/stripe/payment-intent",
    owner: "gp",
    status: "live",
    signature_verifier: "route (HMAC-SHA256 na rawBody, fail-closed 400 PRZED odpowiedzią)",
    barrier: { table: WEBHOOK_DELIVERY_BARRIER_TABLE, provider: STRIPE_PATH_Y_WEBHOOK_PROVIDER },
    consumer_event: PAYMENT_INTENT_SUCCEEDED_EVENT,
    terminal_state: "ISSUED",
    nominal_http: 200,
  },
  {
    path: "/webhooks/stripe",
    owner: "gp",
    status: "retired",
    signature_verifier: "brak (410 bez czytania body)",
    barrier: null,
    consumer_event: null,
    terminal_state: null,
    nominal_http: 410,
  },
]

/** Czysty komparator inwentarz↔obserwacja: lista różnic (pusta = zgodność). */
export function diffRouteInventory(
  expected: ReadonlyArray<StripeRouteInventoryEntry>,
  observed: ReadonlyArray<StripeRouteInventoryEntry>
): string[] {
  const diffs: string[] = []
  const byPath = (rows: ReadonlyArray<StripeRouteInventoryEntry>) =>
    new Map(rows.map((row) => [row.path, row]))
  const exp = byPath(expected)
  const obs = byPath(observed)
  for (const p of exp.keys()) if (!obs.has(p)) diffs.push(`brak trasy w obserwacji: ${p}`)
  for (const p of obs.keys()) if (!exp.has(p)) diffs.push(`trasa spoza inwentarza: ${p}`)
  for (const [p, e] of exp) {
    const o = obs.get(p)
    if (!o) continue
    for (const key of Object.keys(e) as (keyof StripeRouteInventoryEntry)[]) {
      if (JSON.stringify(e[key]) !== JSON.stringify(o[key])) {
        diffs.push(`${p}.${key}: oczekiwano ${JSON.stringify(e[key])}, jest ${JSON.stringify(o[key])}`)
      }
    }
  }
  return diffs
}

// ── Obserwacja repo ──────────────────────────────────────────────────────────

const require = createRequire(__filename)
const NATIVE_HOOK_ROUTE_RELPATH = "dist/api/hooks/payment/[provider]/route.js"

function resolveNativeMedusaPackageDir(): string {
  const pkgJson = require.resolve("@medusajs/medusa/package.json")
  return path.dirname(pkgJson)
}

/**
 * Trasy WEBHOOKOWE Stripe zamontowane w GP: prefiks `/webhooks/` albo `/hooks/`.
 * `/store/payment-collections/:id/payment-sessions/stripe/refresh` też ma
 * „stripe" w nazwie, ale to trasa sklepu wołana przez storefront, nie webhook —
 * inwentarz Story 3.1 obejmuje wyłącznie trasy, w które puka Stripe.
 */
function stripeMatchers(): string[] {
  return (middlewaresConfig.routes ?? [])
    .map((r) => r.matcher)
    .filter(
      (m): m is string =>
        typeof m === "string" && /^\/(web)?hooks\//.test(m) && /stripe/i.test(m)
    )
}

type RouteRepositorySources = {
  native_route: string
  native_stripe_provider: string
  path_y_route: string
  path_y_transport: string
  native_workflow: string
  native_issue: string
  path_y_issue: string
  retired_route: string
}

/**
 * Odczyt obserwowanej powierzchni do osobnego obiektu pozwala kontrolom
 * negatywnym mutować ŹRÓDŁO fixture'u, a nie oczekiwany inwentarz. W produkcji
 * fixture jest zawsze zbudowany z plików repozytorium/natywnej zależności.
 */
function readRouteRepositorySources(): RouteRepositorySources {
  return {
    native_route: readFileSync(
      path.join(resolveNativeMedusaPackageDir(), NATIVE_HOOK_ROUTE_RELPATH),
      "utf8"
    ),
    native_stripe_provider: readFileSync(
      require.resolve("@medusajs/payment-stripe/dist/core/stripe-base"),
      "utf8"
    ),
    path_y_route: readFileSync(path.join(__dirname, "../payment-intent/route.ts"), "utf8"),
    path_y_transport: readFileSync(
      path.join(__dirname, "../../../../lib/payment/stripe-payment-intent-transport.ts"),
      "utf8"
    ),
    native_workflow: readFileSync(
      path.join(__dirname, "../../../../workflows/payment/stripe-payment-audit.ts"),
      "utf8"
    ),
    native_issue: readFileSync(
      path.join(__dirname, "../../../../workflows/entitlements/issue-entitlement.ts"),
      "utf8"
    ),
    path_y_issue: readFileSync(
      path.join(__dirname, "../../../../workflows/entitlements/live-issue-from-payment-intent.ts"),
      "utf8"
    ),
    retired_route: readFileSync(path.join(__dirname, "../route.ts"), "utf8"),
  }
}

/** Każde pole obserwacji pochodzi z konkretnego źródła, nigdy z inwentarza. */
function observeRouteInventory(sources: RouteRepositorySources): StripeRouteInventoryEntry[] {
  const nativeProviderLiterals = [
    ...sources.native_workflow.matchAll(/provider\s*=\s*'([^']+)'/g),
  ].map((match) => match[1])
  const nativeBarrierObserved =
    sources.native_workflow.includes(`INSERT INTO ${WEBHOOK_DELIVERY_BARRIER_TABLE}`) &&
    nativeProviderLiterals.length > 0
  const pathYBarrierObserved =
    sources.path_y_transport.includes(`INSERT INTO ${WEBHOOK_DELIVERY_BARRIER_TABLE}`) &&
    sources.path_y_transport.includes("STRIPE_PATH_Y_WEBHOOK_PROVIDER")
  const nativeRouteObserved =
    sources.native_route.includes("PaymentWebhookEvents.WebhookReceived") &&
    sources.native_route.includes("sendStatus(200)")
  const nativeSignatureObserved =
    sources.native_stripe_provider.includes("constructWebhookEvent") &&
    sources.native_stripe_provider.includes("webhooks.constructEvent(") &&
    sources.native_stripe_provider.includes('data.headers["stripe-signature"]')
  const pathYSubscriberEvents = Array.isArray(pathYSubscriberConfig.event)
    ? pathYSubscriberConfig.event
    : [pathYSubscriberConfig.event]
  const pathYSignatureObserved =
    sources.path_y_route.includes("verifyStripeSignature(") &&
    /res\.status\(400\)\.json\(\{ type: "invalid_signature"/m.test(sources.path_y_route)
  const retiredObserved =
    retiredAUTHENTICATE === false && /res\.status\(410\)\.json\(/m.test(sources.retired_route)

  return [
    {
      path: "/hooks/payment/stripe",
      owner: nativeRouteObserved ? "medusa-native" : "gp",
      status: nativeRouteObserved ? "live" : "retired",
      signature_verifier: nativeRouteObserved && nativeSignatureObserved
        ? "@medusajs/payment-stripe (webhooks.constructEvent w providerze, PO odpowiedzi 200)"
        : "niezweryfikowany native hook",
      barrier: nativeBarrierObserved
        ? {
            table: WEBHOOK_DELIVERY_BARRIER_TABLE,
            provider: nativeProviderLiterals[0] ?? "nieznany_provider",
          }
        : null,
      consumer_event: (Array.isArray(nativeSubscriberConfig.event)
        ? nativeSubscriberConfig.event
        : [nativeSubscriberConfig.event]
      ).includes("payment.captured")
        ? "payment.captured"
        : null,
      terminal_state: sources.native_issue.includes("EntitlementInstanceState.ACTIVE")
        ? "ACTIVE"
        : null,
      nominal_http: nativeRouteObserved ? 200 : 500,
    },
    {
      path: "/webhooks/stripe/payment-intent",
      owner: sources.path_y_route.includes("export async function POST") ? "gp" : "medusa-native",
      status: stripeMatchers().includes("/webhooks/stripe/payment-intent") ? "live" : "retired",
      signature_verifier: pathYSignatureObserved
        ? "route (HMAC-SHA256 na rawBody, fail-closed 400 PRZED odpowiedzią)"
        : "niezweryfikowany podpis Path Y",
      barrier: pathYBarrierObserved
        ? { table: WEBHOOK_DELIVERY_BARRIER_TABLE, provider: STRIPE_PATH_Y_WEBHOOK_PROVIDER }
        : null,
      consumer_event: pathYSubscriberEvents.includes(PAYMENT_INTENT_SUCCEEDED_EVENT)
        ? PAYMENT_INTENT_SUCCEEDED_EVENT
        : null,
      terminal_state:
        sources.path_y_issue.includes("EntitlementInstanceState.ISSUED") &&
        !sources.path_y_issue.includes("state: EntitlementInstanceState.ACTIVE")
          ? "ISSUED"
          : null,
      nominal_http: /res\.status\(200\)\.json\(\{[\s\S]*received: true/m.test(sources.path_y_route)
        ? 200
        : 500,
    },
    {
      path: "/webhooks/stripe",
      owner: sources.retired_route.includes("export async function POST") ? "gp" : "medusa-native",
      status: retiredObserved ? "retired" : "live",
      signature_verifier: retiredObserved ? "brak (410 bez czytania body)" : "niezweryfikowana trasa retired",
      barrier: null,
      consumer_event: null,
      terminal_state: null,
      nominal_http: retiredObserved ? 410 : 500,
    },
  ]
}

describe("Story 3.1 AC1 — inwentaryzacja tras webhooka Stripe (inwentarz == repo)", () => {
  it("F-1: GP montuje dokładnie dwie trasy `/webhooks/stripe*` i NIE montuje `/hooks/payment/stripe` (to trasa natywna Medusy)", () => {
    const matchers = stripeMatchers()
    expect(matchers).toHaveLength(2)
    expect(new Set(matchers).size).toBe(2)
    expect(new Set(matchers)).toEqual(new Set(["/webhooks/stripe", "/webhooks/stripe/payment-intent"]))
    expect(matchers.some((m) => m.includes("/hooks/payment"))).toBe(false)
    // Path Y jest jedyną trasą GP, która MUSI mieć rawBody (podpis HMAC na bajtach).
    const pathY = middlewaresConfig.routes?.find((r) => r.matcher === "/webhooks/stripe/payment-intent")
    expect(pathY?.methods).toEqual(["POST"])
    expect(pathY?.bodyParser).toEqual(expect.objectContaining({ preserveRawBody: true }))
  })

  it("F-2: trasa natywna `/hooks/payment/stripe` istnieje w @medusajs/medusa@2.14.2 i odpowiada 200 PRZED przetworzeniem (emit + sendStatus)", () => {
    const pkgDir = resolveNativeMedusaPackageDir()
    const pkg = JSON.parse(readFileSync(path.join(pkgDir, "package.json"), "utf8")) as { version: string }
    // Wersja z package.json workspace'u — inwentarz mierzy tę samą wartość,
    // którą pinuje repo, zamiast stałej wpisanej w test.
    const backendPkg = JSON.parse(
      readFileSync(path.join(__dirname, "../../../../../../../package.json"), "utf8")
    ) as { dependencies?: Record<string, string> }
    expect(pkg.version).toBe(backendPkg.dependencies?.["@medusajs/medusa"])
    expect(pkg.version).toBe("2.14.2")

    const routeFile = path.join(pkgDir, NATIVE_HOOK_ROUTE_RELPATH)
    expect(existsSync(routeFile)).toBe(true)
    const src = readFileSync(routeFile, "utf8")
    // Kolejność „ACK przed przetworzeniem" (ADR-174 §2.4): route emituje
    // `payment.webhook_received` i odpowiada 200; podpis weryfikuje dopiero
    // subscriber płatności. GP nie ma tu żadnego punktu zaczepienia.
    expect(src).toMatch(/PaymentWebhookEvents\.WebhookReceived/)
    expect(src).toMatch(/sendStatus\(200\)/)
    expect(src.indexOf("eventBus.emit")).toBeLessThan(src.indexOf("sendStatus(200)"))
  })

  it("F-3: `/webhooks/stripe` jest wycofana — 410 z komunikatem, bez auth, bez dotykania kontenera ani body", async () => {
    const status = jest.fn().mockReturnThis()
    const json = jest.fn()
    // Request BEZ scope/rawBody/headers: gdyby route czegokolwiek sięgał, rzuci.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await retiredPOST({} as any, { status, json } as any)
    expect(status).toHaveBeenCalledTimes(1)
    expect(status).toHaveBeenCalledWith(410)
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({ message: STRIPE_WEBHOOK_RETIRED_MESSAGE })
    )
    expect(retiredAUTHENTICATE).toBe(false)
    // Komunikat wskazuje trasę natywną jako następcę — to jedyna „logika" tej trasy.
    expect(STRIPE_WEBHOOK_RETIRED_MESSAGE).toContain("/hooks/payment/stripe")
  })

  it("F-4: trasa Path Y jest publiczna (AUTHENTICATE=false) — Stripe nie ma sesji; podpis zastępuje auth", () => {
    expect(pathYAUTHENTICATE).toBe(false)
  })

  it("F-5: dwa konsumenty, dwa zdarzenia — natywny `payment.captured`, Path Y `gp.stripe.payment_intent_succeeded.v1`", () => {
    const nativeEvents = Array.isArray(nativeSubscriberConfig.event)
      ? nativeSubscriberConfig.event
      : [nativeSubscriberConfig.event]
    expect(nativeEvents).toContain("payment.captured")
    expect(nativeEvents).not.toContain(PAYMENT_INTENT_SUCCEEDED_EVENT)
    expect(pathYSubscriberConfig.event).toBe(PAYMENT_INTENT_SUCCEEDED_EVENT)
  })

  it("F-6: obie trasy żywe piszą do JEDNEJ tabeli bariery, ale w ROZŁĄCZNYCH przestrzeniach `provider`", () => {
    expect(STRIPE_NATIVE_WEBHOOK_PROVIDER).not.toBe(STRIPE_PATH_Y_WEBHOOK_PROVIDER)
    // Kontrola dryfu literału: ścieżka natywna nie eksportuje stałej, wpisuje
    // `provider = 'stripe'` w SQL. Gdy ktoś zmieni literał w workflow, ten test
    // ma pęknąć, bo kompensacja natywna zacznie (nie)dosięgać wierszy Path Y.
    const nativeWorkflowSrc = readFileSync(
      path.join(__dirname, "../../../../workflows/payment/stripe-payment-audit.ts"),
      "utf8"
    )
    const providerLiterals = [...nativeWorkflowSrc.matchAll(/provider\s*=\s*'([^']+)'/g)].map(
      (m) => m[1]
    )
    expect(providerLiterals.length).toBeGreaterThan(0)
    expect(new Set(providerLiterals)).toEqual(new Set([STRIPE_NATIVE_WEBHOOK_PROVIDER]))
    expect(nativeWorkflowSrc).toMatch(
      new RegExp(`INSERT INTO ${WEBHOOK_DELIVERY_BARRIER_TABLE}`)
    )
    const transportSrc = readFileSync(
      path.join(__dirname, "../../../../lib/payment/stripe-payment-intent-transport.ts"),
      "utf8"
    )
    expect(transportSrc).toMatch(new RegExp(`INSERT INTO ${WEBHOOK_DELIVERY_BARRIER_TABLE}`))
  })

  it("F-7: dwa stany końcowe — natywny wystawia ACTIVE, Path Y wystawia ISSUED (dwie gałęzie jednej funkcji, ADR-174 §3)", () => {
    const liveIssueSrc = readFileSync(
      path.join(__dirname, "../../../../workflows/entitlements/live-issue-from-payment-intent.ts"),
      "utf8"
    )
    const nativeIssueSrc = readFileSync(
      path.join(__dirname, "../../../../workflows/entitlements/issue-entitlement.ts"),
      "utf8"
    )
    // Path Y: INSERT ze stanem ISSUED, nigdy ACTIVE jako genezą.
    expect(liveIssueSrc).toMatch(/EntitlementInstanceState\.ISSUED/)
    expect(liveIssueSrc).not.toMatch(/state:\s*EntitlementInstanceState\.ACTIVE/)
    // Natywny (issue-entitlement wołany z stripe-payment-audit): geneza ACTIVE.
    expect(nativeIssueSrc).toMatch(/EntitlementInstanceState\.ACTIVE/)
  })

  it("F-8: inwentarz == obserwacja (komparator zwraca pusty diff)", () => {
    const observed = observeRouteInventory(readRouteRepositorySources())
    expect(diffRouteInventory(STRIPE_ROUTE_INVENTORY, observed)).toEqual([])
  })
})

describe("Story 3.1 AC1 — kontrola negatywna z fixture'em źródeł repo", () => {
  it("mutant route Path Y bez weryfikacji podpisu ⇒ obserwacja rozjeżdża signature_verifier", () => {
    const sources = readRouteRepositorySources()
    const observed = observeRouteInventory({
      ...sources,
      path_y_route: sources.path_y_route.replace("verifyStripeSignature(", "verifySignatureRemoved("),
    })
    expect(
      diffRouteInventory(STRIPE_ROUTE_INVENTORY, observed).some((diff) =>
        /^\/webhooks\/stripe\/payment-intent\.signature_verifier:/.test(diff)
      )
    ).toBe(true)
  })

  it("mutant retired route z 410 na 200 ⇒ obserwacja rozjeżdża status i nominal_http", () => {
    const sources = readRouteRepositorySources()
    const observed = observeRouteInventory({
      ...sources,
      retired_route: sources.retired_route.replace("res.status(410)", "res.status(200)"),
    })
    const diffs = diffRouteInventory(STRIPE_ROUTE_INVENTORY, observed)
    expect(diffs.some((diff) => /^\/webhooks\/stripe\.status:/.test(diff))).toBe(true)
    expect(diffs.some((diff) => /^\/webhooks\/stripe\.nominal_http:/.test(diff))).toBe(true)
  })

  it("mutant bez źródła native hooka ⇒ obserwacja rozjeżdża owner i status", () => {
    const sources = readRouteRepositorySources()
    const observed = observeRouteInventory({ ...sources, native_route: "" })
    const diffs = diffRouteInventory(STRIPE_ROUTE_INVENTORY, observed)
    expect(diffs.some((diff) => /^\/hooks\/payment\/stripe\.owner:/.test(diff))).toBe(true)
    expect(diffs.some((diff) => /^\/hooks\/payment\/stripe\.status:/.test(diff))).toBe(true)
  })

  it("mutant bez constructEvent providera natywnego ⇒ obserwacja rozjeżdża signature_verifier", () => {
    const sources = readRouteRepositorySources()
    const observed = observeRouteInventory({
      ...sources,
      native_stripe_provider: sources.native_stripe_provider.replace(
        "webhooks.constructEvent(",
        "webhooks.constructEventRemoved("
      ),
    })
    expect(
      diffRouteInventory(STRIPE_ROUTE_INVENTORY, observed).some((diff) =>
        /^\/hooks\/payment\/stripe\.signature_verifier:/.test(diff)
      )
    ).toBe(true)
  })
})

describe("Story 3.1 AC1 — czysty komparator (zmutowany inwentarz ⇒ niepusty diff)", () => {
  it("usunięta trasa wycofana ⇒ diff nazywa brak", () => {
    const mutated = STRIPE_ROUTE_INVENTORY.filter((r) => r.path !== "/webhooks/stripe")
    const diffs = diffRouteInventory(STRIPE_ROUTE_INVENTORY, mutated)
    expect(diffs).toEqual(["brak trasy w obserwacji: /webhooks/stripe"])
  })

  it("trasa Path Y oznaczona jako wycofana ⇒ diff na `status`", () => {
    const mutated = STRIPE_ROUTE_INVENTORY.map((r) =>
      r.path === "/webhooks/stripe/payment-intent" ? { ...r, status: "retired" as const } : r
    )
    const diffs = diffRouteInventory(STRIPE_ROUTE_INVENTORY, mutated)
    expect(diffs).toHaveLength(1)
    expect(diffs[0]).toMatch(/^\/webhooks\/stripe\/payment-intent\.status:/)
  })

  it("ten sam `provider` na obu trasach żywych ⇒ diff na `barrier` (bariera przestałaby być rozłączna)", () => {
    const mutated = STRIPE_ROUTE_INVENTORY.map((r) =>
      r.path === "/hooks/payment/stripe"
        ? { ...r, barrier: { table: WEBHOOK_DELIVERY_BARRIER_TABLE, provider: STRIPE_PATH_Y_WEBHOOK_PROVIDER } }
        : r
    )
    const diffs = diffRouteInventory(STRIPE_ROUTE_INVENTORY, mutated)
    expect(diffs).toHaveLength(1)
    expect(diffs[0]).toMatch(/^\/hooks\/payment\/stripe\.barrier:/)
  })

  it("czwarta trasa spoza inwentarza ⇒ diff ją nazywa", () => {
    const mutated = [
      ...STRIPE_ROUTE_INVENTORY,
      { ...STRIPE_ROUTE_INVENTORY[1], path: "/store/stripe/webhook" },
    ]
    expect(diffRouteInventory(STRIPE_ROUTE_INVENTORY, mutated)).toEqual([
      "trasa spoza inwentarza: /store/stripe/webhook",
    ])
  })
})
