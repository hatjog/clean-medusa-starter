/**
 * notification-brevo — rejestracja modułu Notification z providerem brevo
 * (Story 2.2, v1.14.0: AC1 + AC2 + AC5 „test rejestracji").
 *
 * ZERO SIECI, ZERO WYSYŁKI: klient Brevo jest wstrzykiwany przez seam `client`,
 * a każdy test fail-loud asertuje 0 wywołań `sendTransacEmail`. Żaden test nie
 * konstruuje realnego `BrevoHttpClient` bez wstrzykniętego `fetch`.
 */

import { existsSync, readFileSync } from "node:fs"
import path from "node:path"

import { NOTIFICATION_TEMPLATE_KEYS } from "@gp/messaging"

import notificationBrevoProvider, {
  BREVO_API_KEY_ENV,
  BREVO_SENDERS_ENV,
  BrevoNotificationProviderService,
  resolveBrevoSenders,
  toNotificationIntent,
} from "../../modules/notification-brevo"

// __dirname = packages/api/src/__tests__/modules → 5 poziomów do GP/backend.
const BACKEND_ROOT = path.resolve(__dirname, "..", "..", "..", "..", "..")
const SENDERS_JSON = JSON.stringify({
  bonbeauty: { email: "no-reply@example.test", name: "BonBeauty" },
})

function baseNotification(overrides: Record<string, unknown> = {}) {
  return {
    to: "buyer@example.test",
    channel: "email",
    template: NOTIFICATION_TEMPLATE_KEYS.VOUCHER_PURCHASE_CONFIRMATION as string,
    data: {
      template_key: NOTIFICATION_TEMPLATE_KEYS.VOUCHER_PURCHASE_CONFIRMATION,
      market_id: "bonbeauty",
      locale: "pl",
      voucher_code: "ABC-123",
    },
    ...overrides,
  }
}

function makeService(env: Record<string, string | undefined> = {}) {
  const sendTransacEmail = jest.fn()
  const logger = { warn: jest.fn(), error: jest.fn(), info: jest.fn() }
  const service = new BrevoNotificationProviderService(
    { logger: logger as never },
    { channels: ["email"] },
    {
      client: { sendTransacEmail },
      env: { [BREVO_SENDERS_ENV]: SENDERS_JSON, ...env } as NodeJS.ProcessEnv,
    },
  )
  return { service, sendTransacEmail, logger }
}

// ---------------------------------------------------------------------------
// AC1 — rejestracja modułu i identyfikator providera
// ---------------------------------------------------------------------------

describe("AC1 — rejestracja modułu Notification z providerem brevo", () => {
  it("medusa-config.ts rejestruje moduł notification z pinowanym id providera", () => {
    const config = readFileSync(path.join(BACKEND_ROOT, "medusa-config.ts"), "utf8")
    const moduleBlock = config.slice(config.indexOf('key: "notification"'))

    expect(moduleBlock).toContain('resolve: "@medusajs/notification"')
    expect(moduleBlock).toContain('moduleRoot("notification-brevo")')
    // Pinowany `id` → runtime key `np_brevo`; bez tego powstałby identyfikator
    // pochodny od nazwy pluginu (regresja klasy `pp_stripe` vs `pp_stripe_stripe`).
    expect(moduleBlock).toContain('id: "brevo"')
    expect(moduleBlock).toContain('channels: ["email"]')
    // Sekret NIGDY w configu — rozwiązywany leniwie z env w wrapperze.
    expect(moduleBlock).not.toContain(BREVO_API_KEY_ENV)
    // Jawny wpis modułu zastępuje default Medusy — provider `local` na kanale
    // `feed` MUSI zostać zachowany, inaczej kanał feed cicho znika.
    expect(moduleBlock).toContain('"@medusajs/medusa/notification-local"')
    expect(moduleBlock).toContain('channels: ["feed"]')
  })

  it("wpis configu wskazuje ISTNIEJĄCY katalog modułu (nie tylko podłańcuch)", () => {
    // R-2.2-L4: asercja na tekście configu wyłapie usunięcie wpisu, ale nie
    // dowodzi, że `moduleRoot("notification-brevo")` w ogóle się rozwiązuje.
    // Literówka w ścieżce dawała zielony test i czerwony boot.
    const moduleDir = path.join(
      BACKEND_ROOT,
      "packages",
      "api",
      "src",
      "modules",
      "notification-brevo",
    )
    expect(existsSync(moduleDir)).toBe(true)
    expect(existsSync(path.join(moduleDir, "index.ts"))).toBe(true)
  })

  it("default export to ModuleProvider modułu notification z serwisem brevo", () => {
    // R-2.2-L4: sprawdzamy STRUKTURĘ tego, czego oczekuje loader providerów
    // (`@medusajs/notification/dist/loaders/providers.js`): `services[]`
    // z klasą, której `identifier` daje runtime key `np_brevo`.
    const provider = notificationBrevoProvider as unknown as {
      services?: unknown[]
    }
    expect(Array.isArray(provider.services)).toBe(true)
    expect(provider.services).toContain(BrevoNotificationProviderService)
    expect(BrevoNotificationProviderService.identifier).toBe("brevo")
    // Runtime key = NotificationProviderRegistrationPrefix + pinowany `id`.
    expect(`np_${BrevoNotificationProviderService.identifier}`).toBe("np_brevo")
  })

  it("boot BEZ BREVO_API_KEY nie rzuca — konstrukcja providera jest leniwa", () => {
    const env = { ...process.env }
    delete env[BREVO_API_KEY_ENV]

    expect(
      () =>
        new BrevoNotificationProviderService({}, { channels: ["email"] }, {
          env: env as NodeJS.ProcessEnv,
        }),
    ).not.toThrow()
    // validateOptions też nie może wywrócić bootu przy braku sekretu.
    expect(() =>
      BrevoNotificationProviderService.validateOptions({ channels: ["email"] }),
    ).not.toThrow()
  })

  it("brak BREVO_API_KEY → fail-loud dopiero przy wysyłce, nigdy cichy no-op", async () => {
    const logger = { warn: jest.fn() }
    const service = new BrevoNotificationProviderService(
      { logger: logger as never },
      {},
      { env: { [BREVO_SENDERS_ENV]: SENDERS_JSON } as NodeJS.ProcessEnv },
    )

    // Klucz spoza rejestru — allowlist zatrzymuje wysyłkę zanim klient w ogóle
    // zostanie użyty, więc nie ma szans na ruch sieciowy.
    await expect(
      service.send(
        baseNotification({
          data: {
            template_key: "klucz_spoza_rejestru",
            market_id: "bonbeauty",
            locale: "pl",
          },
        }) as never,
      ),
    ).rejects.toThrow(/BREVO_TEMPLATE_NOT_CONFIGURED/)
    expect(logger.warn).toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// AC2 / AC5 — allowlista i „zero wysyłki spoza rejestru"
// ---------------------------------------------------------------------------

describe("AC2/AC5 — allowlista rejestru i zero wysyłki spoza niej", () => {
  it("klucz spoza rejestru → rzuca i NIE dotyka klienta Brevo", async () => {
    const { service, sendTransacEmail } = makeService({ [BREVO_API_KEY_ENV]: "x" })

    await expect(
      service.send(
        baseNotification({
          template: "klucz_spoza_rejestru",
          data: { market_id: "bonbeauty", locale: "pl" },
        }) as never,
      ),
    ).rejects.toThrow(/BREVO_TEMPLATE_NOT_CONFIGURED/)
    expect(sendTransacEmail).not.toHaveBeenCalled()
  })

  it("klucz Z rejestru z brevo: not_configured → ten sam fail-loud, zero wysyłki", async () => {
    const { service, sendTransacEmail } = makeService({ [BREVO_API_KEY_ENV]: "x" })

    await expect(service.send(baseNotification() as never)).rejects.toThrow(
      /BREVO_TEMPLATE_NOT_CONFIGURED/,
    )
    expect(sendTransacEmail).not.toHaveBeenCalled()
  })

  it("brak sendera dla rynku → BREVO_SENDER_NOT_CONFIGURED, zero wysyłki", async () => {
    const sendTransacEmail = jest.fn()
    const service = new BrevoNotificationProviderService(
      {},
      {},
      { client: { sendTransacEmail }, env: {} as NodeJS.ProcessEnv },
    )

    await expect(service.send(baseNotification() as never)).rejects.toThrow(
      /BREVO_SENDER_NOT_CONFIGURED/,
    )
    expect(sendTransacEmail).not.toHaveBeenCalled()
  })

  it("cały rejestr przechodzi przez wrapper bez ANI JEDNEJ wysyłki (stan v1.14.0)", async () => {
    const { service, sendTransacEmail } = makeService({ [BREVO_API_KEY_ENV]: "x" })

    for (const templateKey of Object.values(NOTIFICATION_TEMPLATE_KEYS)) {
      await expect(
        service.send(
          baseNotification({
            template: templateKey,
            data: { template_key: templateKey, market_id: "bonbeauty", locale: "pl" },
          }) as never,
        ),
      ).rejects.toThrow(/BREVO_TEMPLATE_NOT_CONFIGURED/)
    }

    expect(sendTransacEmail).toHaveBeenCalledTimes(0)
  })
})

// ---------------------------------------------------------------------------
// Mapowanie payload Medusy → NotificationIntent
// ---------------------------------------------------------------------------

describe("toNotificationIntent", () => {
  it("data.template_key ma pierwszeństwo nad polem kontraktu Medusy `template`", () => {
    const intent = toNotificationIntent({
      to: "b@example.test",
      channel: "email",
      template: "legacy-name",
      data: { template_key: "kanoniczny", market_id: "bonbeauty", locale: "pl" },
    })

    expect(intent.template_key).toBe("kanoniczny")
  })

  it("normalizuje locale i przepuszcza tylko zmienne szablonu", () => {
    const intent = toNotificationIntent({
      to: "b@example.test",
      channel: "email",
      template: "t",
      data: {
        market_id: "bonbeauty",
        locale: "UA",
        flow_id: "voucher_delivery",
        idempotency_key: "idem-7",
        voucher_code: "XYZ",
      },
    })

    expect(intent.locale).toBe("uk-UA")
    expect(intent.flow_id).toBe("voucher_delivery")
    expect(intent.idempotency_key).toBe("idem-7")
    expect(intent.variables).toEqual({ voucher_code: "XYZ" })
    expect(intent.consent_basis).toBe("transactional_critical")
  })

  it.each([
    ["brak market_id", { locale: "pl" }, "GP_NOTIFICATION_MARKET_ID_REQUIRED"],
    ["nieznane locale", { market_id: "bonbeauty", locale: "xx" }, "GP_NOTIFICATION_LOCALE_UNSUPPORTED"],
    ["brak locale", { market_id: "bonbeauty" }, "GP_NOTIFICATION_LOCALE_UNSUPPORTED"],
  ])("fail-loud: %s", (_label, data, expectedCode) => {
    let thrown: unknown
    try {
      toNotificationIntent({
        to: "b@example.test",
        channel: "email",
        template: "t",
        data: data as Record<string, unknown>,
      })
    } catch (error) {
      thrown = error
    }

    expect((thrown as { error_code?: string })?.error_code).toBe(expectedCode)
  })
})

// ---------------------------------------------------------------------------
// Senders z env (bez hardcodowanych adresów)
// ---------------------------------------------------------------------------

describe("resolveBrevoSenders", () => {
  it("parsuje mapę market → sender", () => {
    const { senders, warning } = resolveBrevoSenders({
      [BREVO_SENDERS_ENV]: SENDERS_JSON,
    } as NodeJS.ProcessEnv)

    expect(senders.bonbeauty).toEqual({ email: "no-reply@example.test", name: "BonBeauty" })
    expect(warning).toBeUndefined()
  })

  it.each([
    ["brak zmiennej", {}],
    ["niepoprawny JSON", { [BREVO_SENDERS_ENV]: "{nope" }],
    ["JSON nie-obiekt", { [BREVO_SENDERS_ENV]: "[]" }],
  ])("degraduje się bez wyjątku: %s", (_label, env) => {
    const { senders, warning } = resolveBrevoSenders(env as NodeJS.ProcessEnv)
    expect(senders).toEqual({})
    expect(warning).toBeTruthy()
  })
})

// ---------------------------------------------------------------------------
// Review 2.2 — envelope audytowy, seam gatewaya, załączniki
// ---------------------------------------------------------------------------

describe("R-2.2-H1 — envelope audytowy jest KONSUMOWANY, nie wyrzucany", () => {
  function makeServiceWithSink(gatewayResult: "ok" | "failed") {
    const audited: Array<Record<string, unknown>> = []
    const gateway = {
      send: jest.fn(async () => ({
        dispatch_id: "dispatch-1",
        provider: "brevo" as const,
        status: gatewayResult === "ok" ? ("queued" as const) : ("failed" as const),
        provider_message_id: gatewayResult === "ok" ? "brevo-1" : undefined,
        audit_event: {
          audit_id: "audit-1",
          event_type: "notification.dispatch",
          status: gatewayResult === "ok" ? "queued" : "failed",
          dispatch_id: "dispatch-1",
          provider: "brevo",
          flow_id: "voucher_purchase_delivery",
          template_key: "voucher_purchase_confirmation",
          channel: "email",
          market_id: "bonbeauty",
          locale: "pl-PL",
          consent_basis: "transactional_critical",
          idempotency_key: "idem-1",
          hashed_recipient: "hash",
          occurred_at: "2026-07-26T00:00:00.000Z",
          ...(gatewayResult === "failed"
            ? { error_code: "BREVO_TEMPLATE_NOT_CONFIGURED" }
            : {}),
        },
      })),
    }
    const service = new BrevoNotificationProviderService({}, {}, {
      gateway: gateway as never,
      auditSink: (envelope) => audited.push(envelope as never),
      env: {} as NodeJS.ProcessEnv,
    })
    return { service, audited, gateway }
  }

  it("ścieżka sukcesu oddaje envelope do sinka", async () => {
    const { service, audited } = makeServiceWithSink("ok")

    await expect(service.send(baseNotification() as never)).resolves.toEqual({
      id: "brevo-1",
    })
    expect(audited).toHaveLength(1)
    expect(audited[0]).toMatchObject({
      status: "queued",
      template_key: "voucher_purchase_confirmation",
      hashed_recipient: "hash",
    })
    // Envelope jest PII-free z konstrukcji — adres NIGDY w audycie (D-70).
    expect(JSON.stringify(audited[0])).not.toContain("buyer@example.test")
  })

  it("ścieżka błędu oddaje envelope ZANIM wrapper rzuci", async () => {
    const { service, audited } = makeServiceWithSink("failed")

    await expect(service.send(baseNotification() as never)).rejects.toThrow(
      /BREVO_TEMPLATE_NOT_CONFIGURED/,
    )
    expect(audited).toHaveLength(1)
    expect(audited[0]).toMatchObject({ status: "failed" })
  })

  it("awaria sinka nie zmienia wyniku wysyłki", async () => {
    const { gateway } = makeServiceWithSink("ok")
    const service = new BrevoNotificationProviderService({}, {}, {
      gateway: gateway as never,
      auditSink: () => {
        throw new Error("sink down")
      },
      env: {} as NodeJS.ProcessEnv,
    })

    await expect(service.send(baseNotification() as never)).resolves.toEqual({
      id: "brevo-1",
    })
  })

  it("wstrzyknięty gateway izoluje w pełni — provider/klient NIE powstają (R-2.2-L3)", async () => {
    const logger = { warn: jest.fn(), info: jest.fn() }
    const gateway = {
      send: jest.fn(async () => {
        throw new Error("nie powinno dojść do wysyłki w tym teście")
      }),
    }
    const service = new BrevoNotificationProviderService(
      { logger: logger as never },
      {},
      {
        gateway: gateway as never,
        // Celowo POPSUTA mapa senderów: gdyby wrapper budował providera mimo
        // wstrzykniętego gatewaya, `resolveBrevoSenders` zalogowałby warning.
        env: { [BREVO_SENDERS_ENV]: "{nope", [BREVO_API_KEY_ENV]: "x" } as NodeJS.ProcessEnv,
      },
    )

    await expect(service.send(baseNotification() as never)).rejects.toThrow()
    expect(logger.warn).not.toHaveBeenCalled()
  })
})

describe("R-2.2-M1 — załączniki nie giną w mapowaniu", () => {
  it("top-level `attachments` (kontrakt Medusy) trafia do intentu jako base64", () => {
    const intent = toNotificationIntent({
      to: "b@example.test",
      channel: "email",
      template: "t",
      data: { market_id: "bonbeauty", locale: "pl" },
      attachments: [{ filename: "wizyta.ics", content: "BEGIN:VCALENDAR" }],
    } as never)

    expect(intent.attachments).toEqual([
      {
        name: "wizyta.ics",
        content_base64: Buffer.from("BEGIN:VCALENDAR", "utf8").toString("base64"),
      },
    ])
  })

  it("`data.attachments` (zastana forma call-site'u) działa tak samo i NIE zasila params", () => {
    const intent = toNotificationIntent({
      to: "b@example.test",
      channel: "email",
      template: "t",
      data: {
        market_id: "bonbeauty",
        locale: "pl",
        attachments: [
          { filename: "wizyta.ics", content: "QkVHSU4=", encoding: "base64" },
        ],
        voucher_code: "ABC",
      },
    } as never)

    expect(intent.attachments).toEqual([
      { name: "wizyta.ics", content_base64: "QkVHSU4=" },
    ])
    expect(intent.variables).toEqual({ voucher_code: "ABC" })
  })

  it("załącznik bez nazwy albo bez treści jest pomijany (zero pustego attachment[])", () => {
    const intent = toNotificationIntent({
      to: "b@example.test",
      channel: "email",
      template: "t",
      data: { market_id: "bonbeauty", locale: "pl" },
      attachments: [{ content: "x" }, { filename: "pusty.ics" }],
    } as never)

    expect(intent.attachments).toBeUndefined()
  })
})
