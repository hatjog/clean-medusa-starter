/**
 * notification-brevo-communication-wiring.unit.spec.ts — Story 2.3 (AC6a).
 *
 * Dowodzi, że wiring `flagResolver` / `flowKpiTelemetry` DZIAŁA, a nie tylko
 * istnieje jako gniazdo:
 *   - kill-switch (`enabled: false`) BLOKUJE wysyłkę z `FLOW_DISABLED`,
 *   - override rynku ma pierwszeństwo nad defaultem,
 *   - KPI `sent` jest EMITOWANE dla flow z zielonymi 5 rolami,
 *   - flow bez approvala jest gated (`gp.messaging.flow_kpi.gated`) — poprawne
 *     zachowanie kontraktu 5-8, nie luka wiringu,
 *   - flow bez wpisu w defaults jest niebramkowany + `warn` (fail-open),
 *   - wpis override bez `enabled` (FR-E.7 extended-only) NIE wywraca loadera.
 *
 * Zero sieci: klient Brevo nigdy nie powstaje, klient PostHog jest atrapą.
 */

import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  UnknownFlowError,
  DefaultMessagingGateway,
  createFlowKpiTelemetryHook,
  loadCommunicationDefaults,
  loadMarketFlows,
  StaticCommunicationFlowFlagResolver,
  type IMessagingProvider,
  type NotificationIntent,
  type PostHogCaptureClient,
} from "@gp/messaging"

import {
  createHotReloadingFlagResolver,
  GovernedFlowFlagResolver,
  loadFlowApprovalLookup,
  resolveCommunicationWiring,
  __resetCommunicationWiringForTests,
} from "../../modules/notification-brevo/communication-wiring"

const FLOW_ID = "voucher_purchase_delivery"
const MARKET_ID = "bonbeauty"

const DEFAULTS_YAML = `
version: 1
flows:
  ${FLOW_ID}:
    enabled: true
    consent_basis: transactional_critical
  voucher_reminder_t7:
    enabled: false
    consent_basis: lifecycle_consented
`

function writeTempTree(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "gp-comm-wiring-"))
  for (const [relative, content] of Object.entries(files)) {
    const path = join(dir, relative)
    mkdirSync(join(path, ".."), { recursive: true })
    writeFileSync(path, content, "utf8")
  }
  return dir
}

function fakeProvider(): IMessagingProvider & { sent: NotificationIntent[] } {
  const sent: NotificationIntent[] = []
  return {
    sent,
    provider: "brevo",
    async send(intent: NotificationIntent) {
      sent.push(intent)
      return {
        provider_message_id: "brevo-msg-1",
        status: "sent" as const,
      }
    },
  } as unknown as IMessagingProvider & { sent: NotificationIntent[] }
}

function intent(overrides: Partial<NotificationIntent> = {}): NotificationIntent {
  return {
    flow_id: FLOW_ID,
    template_key: "voucher_purchase_confirmation",
    channel: "email",
    locale: "pl-PL",
    consent_basis: "transactional_critical",
    idempotency_key: "idem-1",
    recipient: { email: "kupujaca@example.test", market_id: MARKET_ID },
    ...overrides,
  } as NotificationIntent
}

function makeResolver(defaultsYaml: string, marketYaml?: string) {
  const files: Record<string, string> = { "defaults.yaml": defaultsYaml }
  if (marketYaml) files["market.yaml"] = marketYaml
  const dir = writeTempTree(files)

  const defaults = loadCommunicationDefaults(join(dir, "defaults.yaml"))
  const overrides = new Map<string, ReturnType<typeof loadMarketFlows>>()
  if (marketYaml) {
    overrides.set(MARKET_ID, loadMarketFlows(MARKET_ID, join(dir, "market.yaml")))
  }
  return new StaticCommunicationFlowFlagResolver(defaults, overrides)
}

describe("AC6a — kill-switch per rynek/flow realnie BLOKUJE wysyłkę", () => {
  it("flow `enabled: true` przepuszcza wysyłkę", async () => {
    const provider = fakeProvider()
    const gateway = new DefaultMessagingGateway({ brevo: provider }, "brevo", {
      flagResolver: makeResolver(DEFAULTS_YAML),
    })

    const dispatch = await gateway.send(intent())

    expect(dispatch.status).not.toBe("failed")
    expect(provider.sent).toHaveLength(1)
  })

  it("flow `enabled: false` w defaults → dispatch `failed` z FLOW_DISABLED, provider NIE wołany", async () => {
    const provider = fakeProvider()
    const gateway = new DefaultMessagingGateway({ brevo: provider }, "brevo", {
      flagResolver: makeResolver(
        DEFAULTS_YAML.replace(
          `  ${FLOW_ID}:\n    enabled: true`,
          `  ${FLOW_ID}:\n    enabled: false`,
        ),
      ),
    })

    const dispatch = await gateway.send(intent())

    expect(dispatch.status).toBe("failed")
    expect(dispatch.audit_event.error_code).toBe("FLOW_DISABLED")
    expect(dispatch.audit_event.gate_source).toBe("feature_flag")
    expect(provider.sent).toHaveLength(0)
  })

  it("override rynku `enabled: false` wygrywa nad defaultem `true` (kill-switch per rynek)", async () => {
    const provider = fakeProvider()
    const gateway = new DefaultMessagingGateway({ brevo: provider }, "brevo", {
      flagResolver: makeResolver(
        DEFAULTS_YAML,
        `version: 1\nmarket_id: ${MARKET_ID}\noverrides:\n  ${FLOW_ID}:\n    enabled: false\n`,
      ),
    })

    const dispatch = await gateway.send(intent())

    expect(dispatch.status).toBe("failed")
    expect(dispatch.audit_event.error_code).toBe("FLOW_DISABLED")
    expect(provider.sent).toHaveLength(0)
  })

  it("blokada dotyczy TYLKO rynku z override (inny rynek nadal wysyła)", async () => {
    const provider = fakeProvider()
    const gateway = new DefaultMessagingGateway({ brevo: provider }, "brevo", {
      flagResolver: makeResolver(
        DEFAULTS_YAML,
        `version: 1\nmarket_id: ${MARKET_ID}\noverrides:\n  ${FLOW_ID}:\n    enabled: false\n`,
      ),
    })

    const dispatch = await gateway.send(
      intent({
        recipient: { email: "b@example.test", market_id: "bongarden" },
        idempotency_key: "idem-2",
      }),
    )

    expect(dispatch.status).not.toBe("failed")
    expect(provider.sent).toHaveLength(1)
  })
})

describe("AC6a — loader override rynku toleruje wpisy FR-E.7 bez `enabled`", () => {
  it("wpis `sender_identity`-only NIE wywraca loadera i nie tworzy override flagi", () => {
    const dir = writeTempTree({
      "market.yaml":
        `version: 1\nmarket_id: ${MARKET_ID}\noverrides:\n` +
        `  ${FLOW_ID}:\n    sender_identity: bonbeauty_no-reply\n` +
        `    copy_variant: holiday_pl\n`,
    })

    const config = loadMarketFlows(MARKET_ID, join(dir, "market.yaml"))

    expect(config.overrides[FLOW_ID]).toBeUndefined()
  })

  it("`enabled` obecne, ale nie-boolean, POZOSTAJE błędem walidacji", () => {
    const dir = writeTempTree({
      "market.yaml":
        `version: 1\nmarket_id: ${MARKET_ID}\noverrides:\n` +
        `  ${FLOW_ID}:\n    enabled: "tak"\n`,
    })

    expect(() => loadMarketFlows(MARKET_ID, join(dir, "market.yaml"))).toThrow(
      /enabled must be boolean/,
    )
  })

  it("override nadal NIE może zmieniać consent_basis (inwariant governance FR-E.8)", () => {
    const dir = writeTempTree({
      "market.yaml":
        `version: 1\nmarket_id: ${MARKET_ID}\noverrides:\n` +
        `  ${FLOW_ID}:\n    enabled: true\n    consent_basis: marketing\n`,
    })

    expect(() => loadMarketFlows(MARKET_ID, join(dir, "market.yaml"))).toThrow(
      /consent_basis is not allowed/,
    )
  })
})

describe("AC6a — GovernedFlowFlagResolver: flow bez wpisu = fail-open + warn", () => {
  it("nieznany flow jest PRZEPUSZCZANY i logowany (nie cicha blokada)", () => {
    const warnings: Array<{ message: string; meta?: Record<string, unknown> }> = []
    const resolver = new GovernedFlowFlagResolver(makeResolver(DEFAULTS_YAML), {
      warn: (message, meta) => warnings.push({ message, meta }),
    })

    const state = resolver.resolve({ flow_id: "flow_ktorego_nie_ma", market_id: MARKET_ID })

    expect(state.enabled).toBe(true)
    expect(warnings).toHaveLength(1)
    expect(warnings[0].message).toContain("nie ma wpisu w")
    expect(warnings[0].meta).toMatchObject({
      flow_id: "flow_ktorego_nie_ma",
      market_id: MARKET_ID,
    })
  })

  it("ostrzeżenie leci RAZ na parę (rynek, flow) — nie zalewa logów", () => {
    const warnings: string[] = []
    const resolver = new GovernedFlowFlagResolver(makeResolver(DEFAULTS_YAML), {
      warn: (message) => warnings.push(message),
    })

    resolver.resolve({ flow_id: "x_flow", market_id: MARKET_ID })
    resolver.resolve({ flow_id: "x_flow", market_id: MARKET_ID })
    resolver.resolve({ flow_id: "x_flow", market_id: "bongarden" })

    expect(warnings).toHaveLength(2)
  })

  it("znany flow przechodzi bez zmian (dekorator nie maskuje decyzji)", () => {
    const resolver = new GovernedFlowFlagResolver(makeResolver(DEFAULTS_YAML))

    expect(
      resolver.resolve({ flow_id: "voucher_reminder_t7", market_id: MARKET_ID }).enabled,
    ).toBe(false)
  })
})

describe("AC6a — telemetria KPI `sent` jest realnie emitowana", () => {
  function greenApprovals() {
    const role = {
      status: "green" as const,
      approver: "robert",
      approved_at: "2026-07-26",
    }
    return () => ({
      roles: {
        business: role,
        copy: role,
        platform: role,
        compliance: role,
        market: role,
      },
    })
  }

  it("dispatch przez gateway emituje KPI `sent` (denominator delivered_rate)", async () => {
    const captured: Array<{ event: string; properties: Record<string, unknown> }> = []
    const client: PostHogCaptureClient = {
      capture: (input) => captured.push({ event: input.event, properties: input.properties }),
    }

    const gateway = new DefaultMessagingGateway({ brevo: fakeProvider() }, "brevo", {
      flagResolver: makeResolver(DEFAULTS_YAML),
      flowKpiTelemetry: createFlowKpiTelemetryHook({
        client,
        approvalLookup: greenApprovals(),
      }),
    })

    await gateway.send(intent())

    const deliveredRate = captured.find(
      (e) => e.event === "gp.messaging.flow_kpi.delivered_rate",
    )
    expect(deliveredRate).toBeDefined()
    expect(deliveredRate?.properties).toMatchObject({
      outcome: "sent",
      flow_id: FLOW_ID,
      market: MARKET_ID,
    })
  })

  it("KPI nie zawierają surowego adresu — wyłącznie recipient_hash", async () => {
    const captured: Array<Record<string, unknown>> = []
    const client: PostHogCaptureClient = {
      capture: (input) => captured.push(input.properties),
    }

    const gateway = new DefaultMessagingGateway({ brevo: fakeProvider() }, "brevo", {
      flagResolver: makeResolver(DEFAULTS_YAML),
      flowKpiTelemetry: createFlowKpiTelemetryHook({
        client,
        approvalLookup: greenApprovals(),
      }),
    })

    await gateway.send(intent())

    const serialized = JSON.stringify(captured)
    expect(serialized).not.toContain("kupujaca@example.test")
    expect(captured.length).toBeGreaterThan(0)
  })

  it("flow BEZ approvala jest gated (`flow_kpi.gated`) — kontrakt 5-8, nie luka wiringu", async () => {
    const captured: Array<{ event: string; properties: Record<string, unknown> }> = []
    const client: PostHogCaptureClient = {
      capture: (input) => captured.push({ event: input.event, properties: input.properties }),
    }

    const gateway = new DefaultMessagingGateway({ brevo: fakeProvider() }, "brevo", {
      flagResolver: makeResolver(DEFAULTS_YAML),
      flowKpiTelemetry: createFlowKpiTelemetryHook({
        client,
        // Brak wpisu approvala dla tego flow — dokładnie stan produkcyjny 2.3.
        approvalLookup: () => null,
      }),
    })

    await gateway.send(intent())

    expect(captured.map((e) => e.event)).toContain("gp.messaging.flow_kpi.gated")
    expect(captured.map((e) => e.event)).not.toContain(
      "gp.messaging.flow_kpi.delivered_rate",
    )
  })

  it("gated dispatch NIE blokuje wysyłki — telemetria jest obserwacją, nie bramką", async () => {
    const provider = fakeProvider()
    const gateway = new DefaultMessagingGateway({ brevo: provider }, "brevo", {
      flagResolver: makeResolver(DEFAULTS_YAML),
      flowKpiTelemetry: createFlowKpiTelemetryHook({
        client: { capture: () => undefined },
        approvalLookup: () => null,
      }),
    })

    await gateway.send(intent())
    expect(provider.sent).toHaveLength(1)
  })
})

describe("AC6a — loadFlowApprovalLookup czyta rejestr 5-8 (nie tworzy approvali)", () => {
  it("zwraca wpis dla (rynek, flow) obecnego w rejestrze", () => {
    const dir = writeTempTree({
      "approvals.yaml": `version: 1
approvals:
  ${MARKET_ID}:
    order_confirmation:
      governed_fields_digest: "abc"
      roles:
        business: { status: green, approver: robert, approved_at: "2026-05-27" }
`,
    })

    const lookup = loadFlowApprovalLookup(join(dir, "approvals.yaml"))
    expect(lookup?.(MARKET_ID, "order_confirmation")).toMatchObject({
      governed_fields_digest: "abc",
    })
  })

  it("zwraca null dla flow bez wpisu (brak approvala ≠ approval)", () => {
    const dir = writeTempTree({
      "approvals.yaml": `version: 1\napprovals:\n  ${MARKET_ID}: {}\n`,
    })

    const lookup = loadFlowApprovalLookup(join(dir, "approvals.yaml"))
    expect(lookup?.(MARKET_ID, FLOW_ID)).toBeNull()
    expect(lookup?.("nieistniejacy-rynek", FLOW_ID)).toBeNull()
  })

  it("nieczytelny plik nie wywraca wiringu (zwraca undefined)", () => {
    expect(loadFlowApprovalLookup("/tmp/gp-nie-ma-tego-pliku.yaml")).toBeUndefined()
  })
})

describe("AC6a — resolveCommunicationWiring: brak konfiguracji degraduje GŁOŚNO", () => {
  beforeEach(() => {
    __resetCommunicationWiringForTests()
  })

  it("wskazane env-em, nieistniejące ścieżki → gniazda undefined + ostrzeżenia", () => {
    const warnings: string[] = []
    const wiring = resolveCommunicationWiring({
      fresh: true,
      logger: { warn: (message) => warnings.push(message) },
      env: {
        GP_COMMUNICATION_DEFAULTS_PATH: "/tmp/gp-nie-ma/defaults.yaml",
        GP_COMMUNICATION_MARKET_FLOWS_DIR: "/tmp/gp-nie-ma/markets",
        GP_COMMUNICATION_FLOW_APPROVALS_PATH: "/tmp/gp-nie-ma/approvals.yaml",
      },
    })

    expect(wiring.flagResolver).toBeUndefined()
    expect(wiring.flowKpiTelemetry).toBeUndefined()
    // Degradacja NIE jest cicha — to cały sens tego testu.
    expect(warnings.some((w) => w.includes("kill-switch per rynek/flow NIEAKTYWNY"))).toBe(
      true,
    )
    expect(warnings.some((w) => w.includes("telemetria KPI flow NIEAKTYWNA"))).toBe(true)
  })

  it("z realnymi ścieżkami buduje resolver + hook i raportuje źródła", () => {
    const dir = writeTempTree({
      "gp-config/gp-dev/communication-defaults.yaml": DEFAULTS_YAML,
      [`gp-ops/markets/${MARKET_ID}/communication-flows.yaml`]:
        `version: 1\nmarket_id: ${MARKET_ID}\noverrides:\n  ${FLOW_ID}:\n    enabled: false\n`,
      "gp-ops/markets/_ratification/communication-flow-approvals.yaml":
        `version: 1\napprovals:\n  ${MARKET_ID}: {}\n`,
    })

    const wiring = resolveCommunicationWiring({
      fresh: true,
      env: {
        GP_COMMUNICATION_DEFAULTS_PATH: join(
          dir,
          "gp-config/gp-dev/communication-defaults.yaml",
        ),
        GP_COMMUNICATION_MARKET_FLOWS_DIR: join(dir, "gp-ops/markets"),
        GP_COMMUNICATION_FLOW_APPROVALS_PATH: join(
          dir,
          "gp-ops/markets/_ratification/communication-flow-approvals.yaml",
        ),
      },
    })

    expect(wiring.flagResolver).toBeDefined()
    expect(wiring.flowKpiTelemetry).toBeDefined()
    expect(wiring.sources.market_flows_loaded).toEqual([MARKET_ID])
    expect(wiring.sources.market_flows_skipped).toEqual([])
    // Override rynku jest realnie wczytany — kill-switch działa end-to-end.
    expect(
      wiring.flagResolver?.resolve({ flow_id: FLOW_ID, market_id: MARKET_ID }).enabled,
    ).toBe(false)
  })

  it("zepsuty plik JEDNEGO rynku nie pozbawia kill-switcha pozostałych", () => {
    const warnings: string[] = []
    const dir = writeTempTree({
      "gp-config/gp-dev/communication-defaults.yaml": DEFAULTS_YAML,
      [`gp-ops/markets/${MARKET_ID}/communication-flows.yaml`]:
        `version: 1\nmarket_id: ${MARKET_ID}\noverrides:\n  ${FLOW_ID}:\n    enabled: false\n`,
      "gp-ops/markets/bongarden/communication-flows.yaml":
        `version: 1\nmarket_id: zly-market-id\noverrides: {}\n`,
    })

    const wiring = resolveCommunicationWiring({
      fresh: true,
      logger: { warn: (message) => warnings.push(message) },
      env: {
        GP_COMMUNICATION_DEFAULTS_PATH: join(
          dir,
          "gp-config/gp-dev/communication-defaults.yaml",
        ),
        GP_COMMUNICATION_MARKET_FLOWS_DIR: join(dir, "gp-ops/markets"),
      },
    })

    expect(wiring.sources.market_flows_loaded).toEqual([MARKET_ID])
    expect(wiring.sources.market_flows_skipped).toEqual(["bongarden"])
    expect(warnings.some((w) => w.includes("pominięto override rynku"))).toBe(true)
    expect(
      wiring.flagResolver?.resolve({ flow_id: FLOW_ID, market_id: MARKET_ID }).enabled,
    ).toBe(false)
  })
})

// ── Findingi review 2.3 (R-2.3-M5 / L8) ────────────────────────────────────

describe("R-2.3-L8 — fail-open dotyczy WYŁĄCZNIE nieznanego flow", () => {
  it("inny błąd resolvera NIE włącza wysyłki — propaguje zamiast otwierać bramkę", () => {
    const warnings: string[] = []
    const broken = {
      resolve() {
        throw new Error("zły kształt wpisu override")
      },
    }
    const resolver = new GovernedFlowFlagResolver(broken, {
      warn: (message) => warnings.push(message),
    })

    expect(() => resolver.resolve({ flow_id: FLOW_ID, market_id: MARKET_ID })).toThrow(
      "zły kształt wpisu override",
    )
    // Żadnego „fail-open + warn" dla defektu, który nie jest nieznanym flow.
    expect(warnings).toHaveLength(0)
  })

  it("UnknownFlowError nadal daje fail-open (decyzja ADR-161 pkt 3 zachowana)", () => {
    const unknown = {
      resolve() {
        throw new UnknownFlowError("flow spoza rejestru", {
          error_code: "FLOW_UNKNOWN",
        })
      },
    }
    const resolver = new GovernedFlowFlagResolver(unknown)

    expect(resolver.resolve({ flow_id: "x_flow", market_id: MARKET_ID }).enabled).toBe(
      true,
    )
  })
})

describe("R-2.3-M5 — kill-switch działa BEZ restartu procesu (ADR-161)", () => {
  beforeEach(() => {
    __resetCommunicationWiringForTests()
  })

  function envFor(dir: string): NodeJS.ProcessEnv {
    return {
      GP_COMMUNICATION_DEFAULTS_PATH: join(dir, "defaults.yaml"),
      GP_COMMUNICATION_MARKET_FLOWS_DIR: join(dir, "markets"),
    }
  }

  it("edycja override rynku jest widoczna po TTL — bez restartu", () => {
    const dir = writeTempTree({
      "defaults.yaml": DEFAULTS_YAML,
      [`markets/${MARKET_ID}/communication-flows.yaml`]:
        `version: 1\nmarket_id: ${MARKET_ID}\noverrides:\n  ${FLOW_ID}:\n    enabled: true\n`,
    })
    const env = { ...envFor(dir), GP_COMMUNICATION_WIRING_TTL_MS: "1000" }

    // Zegar wiringu jest wstrzykiwany, żeby TTL był deterministyczny.
    let clock = 0
    expect(
      resolveCommunicationWiring({ env, now: () => clock }).flagResolver?.resolve({
        flow_id: FLOW_ID,
        market_id: MARKET_ID,
      }).enabled,
    ).toBe(true)

    // Operator ustawia kill-switch w trakcie incydentu.
    writeFileSync(
      join(dir, "markets", MARKET_ID, "communication-flows.yaml"),
      `version: 1\nmarket_id: ${MARKET_ID}\noverrides:\n  ${FLOW_ID}:\n    enabled: false\n`,
      "utf8",
    )

    // Przed upływem TTL nadal obowiązuje poprzedni odczyt (cache jest celowy).
    clock = 500
    expect(
      resolveCommunicationWiring({ env, now: () => clock }).flagResolver?.resolve({
        flow_id: FLOW_ID,
        market_id: MARKET_ID,
      }).enabled,
    ).toBe(true)

    // Po TTL — bez restartu procesu — wysyłka jest zablokowana.
    clock = 2000
    expect(
      resolveCommunicationWiring({ env, now: () => clock }).flagResolver?.resolve({
        flow_id: FLOW_ID,
        market_id: MARKET_ID,
      }).enabled,
    ).toBe(false)
  })

  it("hot-reloading resolver nie zamraża decyzji z bootu (gateway trzyma jedną instancję)", () => {
    const dir = writeTempTree({
      "defaults.yaml": DEFAULTS_YAML,
      [`markets/${MARKET_ID}/communication-flows.yaml`]:
        `version: 1\nmarket_id: ${MARKET_ID}\noverrides:\n  ${FLOW_ID}:\n    enabled: true\n`,
    })
    // TTL = 0 → zawsze świeży odczyt (deterministyczne w teście).
    const env = { ...envFor(dir), GP_COMMUNICATION_WIRING_TTL_MS: "0" }
    const resolver = createHotReloadingFlagResolver({ env })

    expect(resolver.resolve({ flow_id: FLOW_ID, market_id: MARKET_ID }).enabled).toBe(
      true,
    )

    writeFileSync(
      join(dir, "markets", MARKET_ID, "communication-flows.yaml"),
      `version: 1\nmarket_id: ${MARKET_ID}\noverrides:\n  ${FLOW_ID}:\n    enabled: false\n`,
      "utf8",
    )

    expect(resolver.resolve({ flow_id: FLOW_ID, market_id: MARKET_ID }).enabled).toBe(
      false,
    )
  })

  it("zniknięcie konfiguracji po starcie = brak bramki, ale GŁOŚNO", () => {
    const warnings: string[] = []
    const resolver = createHotReloadingFlagResolver({
      env: {
        GP_COMMUNICATION_DEFAULTS_PATH: "/tmp/gp-nie-ma/defaults.yaml",
        GP_COMMUNICATION_WIRING_TTL_MS: "0",
      },
      logger: { warn: (message) => warnings.push(message) },
    })

    expect(resolver.resolve({ flow_id: FLOW_ID, market_id: MARKET_ID }).enabled).toBe(
      true,
    )
    expect(warnings.some((w) => w.includes("NIE jest"))).toBe(true)
  })
})
