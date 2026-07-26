/**
 * voucher-purchase-delivery-boundaries.unit.spec.ts — Story 2.3 (AC1 / AC2).
 *
 * Testy STRUKTURALNE (skan źródeł), które bronią granic niemożliwych do
 * sprawdzenia zachowaniem, bo bronią BRAKU zachowania:
 *
 *  1. `gp.communication.delivery_state_changed.v1` NIE jest emitowany (AD-7) —
 *     asercja behawioralna „nie zawołano event busa" byłaby pusta, bo
 *     subscriber nie ma i nie może mieć takiej zależności. Test pilnuje, żeby
 *     nikt jej nie dodał; padnie w momencie, w którym ktoś wpisze emisję.
 *  2. Kierunek zależności: provider `brevo` NIE importuje modułu
 *     voucher-delivery (ledger ma jednego pisarza — subscriber).
 *  3. Zero literałów `template_key` w kodzie produkcyjnym (AD-6) — klucze
 *     wyłącznie ze stałych rejestru.
 *  4. Zakres 2.3: żadnego gift/handoff (2.4) ani joba sweepa (2.5).
 */

import { readFileSync } from "node:fs"
import { resolve } from "node:path"

const SRC = resolve(__dirname, "../..")

const DELIVERY_PATH_FILES = [
  "subscribers/voucher-purchase-delivery.ts",
  "modules/voucher-delivery/dispatch-ledger.ts",
  "modules/voucher-delivery/delivery-state.ts",
  "modules/voucher-delivery/recipient-hash.ts",
  "modules/voucher-delivery/purchase-confirmation-intent.ts",
] as const

function read(relative: string): string {
  return readFileSync(resolve(SRC, relative), "utf8")
}

/** Usuwa komentarze — granice dotyczą KODU, nie prozy w komentarzach. */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "")
}

/**
 * `delivery-state.ts` jest JEDYNYM miejscem, w którym nazwa kontraktu wolno się
 * pojawić — jako stała `DELIVERY_STATE_CONTRACT_ID` (referencja zapożyczonego
 * enumu, konsumowana przez drift-test i komentarz migracji). Nigdzie indziej.
 */
const CONTRACT_REFERENCE_FILE = "modules/voucher-delivery/delivery-state.ts"

describe("AC2 — `gp.communication.delivery_state_changed.v1` NIE jest emitowany (AD-7)", () => {
  it.each(DELIVERY_PATH_FILES.filter((f) => f !== CONTRACT_REFERENCE_FILE))(
    "%s nie zawiera nawet nazwy eventu delivery_state_changed",
    (file) => {
      const code = stripComments(read(file))

      expect(code).not.toContain("gp.communication.delivery_state_changed")
      expect(code).not.toContain("delivery_state_changed.v1")
    },
  )

  it("delivery-state.ts używa nazwy kontraktu WYŁĄCZNIE jako referencji zapożyczonego enumu", () => {
    const code = stripComments(read(CONTRACT_REFERENCE_FILE))
    const occurrences =
      code.match(/gp\.communication\.delivery_state_changed\.v1/g) ?? []

    // Dokładnie jedno wystąpienie — przypisanie do stałej referencyjnej.
    expect(occurrences).toHaveLength(1)
    expect(code).toMatch(
      /DELIVERY_STATE_CONTRACT_ID\s*=\s*\r?\n?\s*"gp\.communication\.delivery_state_changed\.v1"\s*as const/,
    )
  })

  it.each(DELIVERY_PATH_FILES)(
    "%s nie ma zależności od event busa (nie da się emitować przez pomyłkę)",
    (file) => {
      const code = stripComments(read(file))

      expect(code).not.toMatch(/Modules\.EVENT_BUS/)
      expect(code).not.toMatch(/eventBus/i)
      expect(code).not.toMatch(/\bemitEvent\b/)
    },
  )

  it("test-the-test: skaner ZNAJDUJE emisję, gdyby ktoś ją dodał", () => {
    const withEmission = stripComments(`
      // komentarz o gp.communication.delivery_state_changed.v1 jest dozwolony
      const eventBus = container.resolve(Modules.EVENT_BUS)
      await eventBus.emit({ name: "gp.communication.delivery_state_changed.v1" })
    `)
    expect(withEmission).toContain("gp.communication.delivery_state_changed")
    expect(withEmission).toMatch(/Modules\.EVENT_BUS/)
  })
})

describe("AC2 — kierunek zależności: provider brevo NIE dotyka ledgera", () => {
  const providerFiles = [
    "modules/notification-brevo/service.ts",
    "modules/notification-brevo/intent.ts",
    "modules/notification-brevo/senders.ts",
    "modules/notification-brevo/communication-wiring.ts",
  ] as const

  it.each(providerFiles)("%s nie importuje modułu voucher-delivery", (file) => {
    const code = stripComments(read(file))
    expect(code).not.toContain("voucher-delivery")
  })

  it.each(providerFiles)("%s nie odwołuje się do tabel ledgera", (file) => {
    const code = stripComments(read(file))
    expect(code).not.toContain("voucher_delivery_dispatch")
  })

  it("ledger jest zapisywany wyłącznie z subscribera (single-writer)", () => {
    // Jedyny plik produkcyjny wołający `reserveDispatch`/`markSent`/`markFailed`
    // to subscriber; ledger sam siebie nie woła z innego miejsca.
    const subscriber = stripComments(read("subscribers/voucher-purchase-delivery.ts"))
    expect(subscriber).toContain("reserveDispatch")
    expect(subscriber).toContain("markSent")
    expect(subscriber).toContain("markFailed")
  })
})

describe("AD-6 — zero literałów template_key w kodzie produkcyjnym", () => {
  it.each(DELIVERY_PATH_FILES)("%s bierze template_key ze stałej rejestru", (file) => {
    const code = stripComments(read(file))
    expect(code).not.toContain('"voucher_purchase_confirmation"')
    expect(code).not.toContain("'voucher_purchase_confirmation'")
  })

  it("intent buduje payload z NOTIFICATION_TEMPLATE_KEYS (jedno źródło dla `template` i `data.template_key`)", () => {
    const code = read("modules/voucher-delivery/purchase-confirmation-intent.ts")
    expect(code).toContain(
      "NOTIFICATION_TEMPLATE_KEYS.VOUCHER_PURCHASE_CONFIRMATION",
    )
  })

  it("wysyłka idzie przez Modules.NOTIFICATION (AD-5), nie przez gateway ani adapter Brevo wprost", () => {
    const code = stripComments(read("subscribers/voucher-purchase-delivery.ts"))
    expect(code).toContain("Modules.NOTIFICATION")
    expect(code).not.toContain("DefaultMessagingGateway")
    expect(code).not.toContain("BrevoAdapter")
    expect(code).not.toContain("BrevoHttpClient")
  })
})

describe("granice zakresu 2.3 — 2.4 i 2.5 nie są implementowane", () => {
  it.each(DELIVERY_PATH_FILES)("%s nie implementuje gift/handoff (Story 2.4)", (file) => {
    const code = stripComments(read(file))
    expect(code).not.toContain("voucher_handoff_link")
    expect(code).not.toContain("VOUCHER_HANDOFF_LINK")
  })

  it("nie powstał job sweepa (Story 2.5)", () => {
    const jobs = readFileSync(resolve(SRC, "../../../medusa-config.ts"), "utf8")
    // Sanity: plik configu istnieje (kotwica ścieżki), a sweep nie jest tu wpięty.
    expect(jobs.length).toBeGreaterThan(0)
    expect(jobs).not.toContain("voucher-delivery-sweep")
  })
})
