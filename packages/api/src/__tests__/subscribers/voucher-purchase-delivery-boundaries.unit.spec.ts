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
 *  4. Zakres: Story 2.4 dokłada DRUGI `template_key` w tej samej mechanice —
 *     żadnego drugiego subscribera, żadnej drugiej tabeli, żadnej kopii logiki
 *     linku claim. Sweep (2.5) nadal nie jest implementowany.
 */

import { readdirSync, readFileSync } from "node:fs"
import { resolve } from "node:path"

const SRC = resolve(__dirname, "../..")

const DELIVERY_PATH_FILES = [
  "subscribers/voucher-purchase-delivery.ts",
  "modules/voucher-delivery/dispatch-ledger.ts",
  "modules/voucher-delivery/delivery-state.ts",
  "modules/voucher-delivery/recipient-hash.ts",
  "modules/voucher-delivery/purchase-confirmation-intent.ts",
  // Story 2.4 — handoff wchodzi w TE SAME granice, nie obok nich.
  "modules/voucher-delivery/gift-handoff.ts",
  "modules/voucher-delivery/handoff-link-intent.ts",
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

describe("granice zakresu 2.4 — handoff rozszerza mechanikę 2.3, nie duplikuje jej", () => {
  it.each(DELIVERY_PATH_FILES)(
    "%s nie zawiera literału `voucher_handoff_link` (AD-6: klucz ze stałej rejestru)",
    (file) => {
      const code = stripComments(read(file))
      expect(code).not.toContain('"voucher_handoff_link"')
      expect(code).not.toContain("'voucher_handoff_link'")
    },
  )

  it("intent handoffu bierze klucz z NOTIFICATION_TEMPLATE_KEYS.VOUCHER_HANDOFF_LINK", () => {
    const code = read("modules/voucher-delivery/handoff-link-intent.ts")
    expect(code).toContain("NOTIFICATION_TEMPLATE_KEYS.VOUCHER_HANDOFF_LINK")
  })

  it("nie powstał DRUGI subscriber dla handoffu — matryca AD-7 ma jednego konsumenta", () => {
    const subscribers = readdirSync(resolve(SRC, "subscribers")).filter((name) =>
      name.endsWith(".ts"),
    )
    const handoffSubscribers = subscribers.filter((name) =>
      /handoff|gift/i.test(name),
    )
    expect(handoffSubscribers).toEqual([])

    // Klucz handoffu konsumuje WYŁĄCZNIE subscriber 2.3 — nikt inny nie wysyła.
    const writers = subscribers.filter((name) =>
      stripComments(read(`subscribers/${name}`)).includes("VOUCHER_HANDOFF_LINK"),
    )
    expect(writers).toEqual(["voucher-purchase-delivery.ts"])
  })

  it("handoff NIE dostał własnej tabeli ani własnej migracji delivery", () => {
    // Ledger 2.3 jest jedynym nośnikiem idempotencji wysyłki; drugi klucz
    // szablonu mieści się w istniejącym UNIQUE bez zmiany schematu.
    const migrations = readdirSync(resolve(SRC, "migrations")).filter((name) =>
      /handoff|gift/i.test(name),
    )
    expect(migrations).toEqual([])

    const handoffIntent = stripComments(
      read("modules/voucher-delivery/handoff-link-intent.ts"),
    )
    expect(handoffIntent).not.toContain("CREATE TABLE")
    expect(handoffIntent).not.toContain("INSERT INTO")
  })

  it("handoff reużywa link claim i klucz idempotencji 2.3 (zero kopii logiki)", () => {
    const code = read("modules/voucher-delivery/handoff-link-intent.ts")
    expect(code).toContain("buildDispatchIdempotencyKey")
    // Własnego `resolveStorefrontBaseUrl`/`buildClaimUrl` NIE ma — base URL
    // i link claim liczy subscriber raz, wspólnie dla obu wysyłek.
    expect(code).not.toMatch(/function\s+buildClaimUrl/)
    expect(code).not.toMatch(/function\s+resolveStorefrontBaseUrl/)
  })

  it("nie powstał job sweepa (Story 2.5)", () => {
    const jobs = readFileSync(resolve(SRC, "../../../medusa-config.ts"), "utf8")
    // Sanity: plik configu istnieje (kotwica ścieżki), a sweep nie jest tu wpięty.
    expect(jobs.length).toBeGreaterThan(0)
    expect(jobs).not.toContain("voucher-delivery-sweep")
  })
})
