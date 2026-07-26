/**
 * customer-notification-email-sanitizer — retest patcha z REALNIE zarejestrowanym
 * modułem Notification (Story 2.2, AC5 poz. 4).
 *
 * Inwentaryzacja 2.1 sklasyfikowała `lib/customer-scoped-email.ts` jako
 * infrastrukturę (monkey-patch `createNotifications`/`send`), z otwartym pytaniem:
 * czy patch nadal działa, gdy moduł Notification jest zarejestrowany. Ten test
 * odpowiada testem, nie założeniem:
 *   - kolejność: loader patchuje instancję z kontenera (klasa z metodami na
 *     prototypie — dokładnie tak wygląda `NotificationModuleService` Medusy),
 *   - `bind`: `this` wewnątrz oryginalnej metody pozostaje instancją serwisu,
 *   - pass-through błędów: patch NIE zmienia semantyki (błąd providera leci dalej),
 *   - idempotencja: dwukrotne załadowanie loadera nie nakłada patcha dwa razy.
 */

import { Modules } from "@medusajs/framework/utils"

import customerNotificationEmailSanitizerLoader from "../../loaders/customer-notification-email-sanitizer"

/** Kształt zbliżony do NotificationModuleService: metody na prototypie + stan. */
class FakeNotificationModuleService {
  public received: unknown[] = []
  public failWith: Error | null = null

  async createNotifications(data: unknown): Promise<{ id: string }> {
    // `this` MUSI być instancją — inaczej bind w patchu jest zepsuty.
    this.received.push(data)
    if (this.failWith) {
      throw this.failWith
    }
    return { id: "notif_1" }
  }

  async send(data: unknown): Promise<{ id: string }> {
    this.received.push(data)
    return { id: "notif_send" }
  }
}

function containerWith(service: unknown) {
  return {
    resolve: (key: string) => (key === Modules.NOTIFICATION ? service : undefined),
  } as never
}

describe("customer-notification-email-sanitizer + zarejestrowany moduł Notification", () => {
  it("strippuje prefiks scoped-email na obu metodach dispatchu", async () => {
    const service = new FakeNotificationModuleService()
    await customerNotificationEmailSanitizerLoader({ container: containerWith(service) })

    await service.createNotifications({
      to: "bonbeauty::anna@example.test",
      channel: "email",
      data: { cc: ["bonbeauty::ops@example.test"] },
    })
    await service.send({ to: "bonbeauty::bob@example.test", channel: "email" })

    expect(service.received).toEqual([
      {
        to: "anna@example.test",
        channel: "email",
        data: { cc: ["ops@example.test"] },
      },
      { to: "bob@example.test", channel: "email" },
    ])
  })

  it("zachowuje bind — `this` w oryginalnej metodzie to instancja serwisu", async () => {
    const service = new FakeNotificationModuleService()
    await customerNotificationEmailSanitizerLoader({ container: containerWith(service) })

    const detached = service.createNotifications
    await expect(
      detached({ to: "bonbeauty::anna@example.test", channel: "email" }),
    ).resolves.toEqual({ id: "notif_1" })
    expect(service.received).toHaveLength(1)
  })

  it("pass-through błędów providera — patch nie zmienia semantyki (AD-6)", async () => {
    const service = new FakeNotificationModuleService()
    service.failWith = Object.assign(new Error("brevo says no"), {
      error_code: "BREVO_TEMPLATE_NOT_CONFIGURED",
    })
    await customerNotificationEmailSanitizerLoader({ container: containerWith(service) })

    await expect(
      service.createNotifications({ to: "bonbeauty::anna@example.test", channel: "email" }),
    ).rejects.toMatchObject({ error_code: "BREVO_TEMPLATE_NOT_CONFIGURED" })
  })

  it("dwukrotne uruchomienie loadera nie nakłada patcha podwójnie", async () => {
    const service = new FakeNotificationModuleService()
    await customerNotificationEmailSanitizerLoader({ container: containerWith(service) })
    const afterFirst = service.createNotifications
    await customerNotificationEmailSanitizerLoader({ container: containerWith(service) })

    expect(service.createNotifications).toBe(afterFirst)

    // Sanityzacja nadal jednokrotna (podwójny patch dałby ten sam wynik, ale
    // rosnący łańcuch wywołań — pilnujemy referencji powyżej).
    await service.createNotifications({ to: "bonbeauty::anna@example.test", channel: "email" })
    expect((service.received[0] as { to: string }).to).toBe("anna@example.test")
  })
})
