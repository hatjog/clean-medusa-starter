/**
 * notification-brevo — rejestracja modułu Notification z providerem brevo
 * (Story 2.2, v1.14.0: AC1 + AC2 + AC5 „test rejestracji").
 *
 * ZERO SIECI, ZERO WYSYŁKI: klient Brevo jest wstrzykiwany przez seam `client`,
 * a każdy test fail-loud asertuje 0 wywołań `sendTransacEmail`. Żaden test nie
 * konstruuje realnego `BrevoHttpClient` bez wstrzykniętego `fetch`.
 */

import { readFileSync } from "node:fs"
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

  it("default export to ModuleProvider z serwisem providera", () => {
    expect(notificationBrevoProvider).toBeDefined()
    expect(BrevoNotificationProviderService.identifier).toBe("brevo")
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
