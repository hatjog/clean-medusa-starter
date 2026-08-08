/**
 * DOWÓD PO STRONIE DOSTAWCY — okno wysyłka↔potwierdzenie.
 *
 * v1.15.0 Story 4.5 (FR-9f, NFR-1, AD-23), AC4.
 *
 * ── Co ta suita mierzy, a czego NIE ────────────────────────────────────────
 * Mierzy LICZBĘ WIADOMOŚCI PO STRONIE BREVO — odczytem z konta dostawcy dla
 * konkretnej tożsamości wysyłki. NIE liczy wywołań atrapy providera, NIE
 * czyta wiersza bariery i NIE zagląda do ledgera dostarczeń. AC źródłowe
 * zabrania tego wprost: „mierzone po stronie dostawcy, nie po cache". Licznik
 * wywołań mierzy nasz kod, a pytanie brzmi, ile maili dostała klientka.
 *
 * Nośnikiem jest PRODUKCYJNA ścieżka: `BrevoHttpClient` (realne HTTP) →
 * `BrevoAdapter` → `DefaultMessagingGateway`. Żadnego mocka providera.
 *
 * ── Czego ta suita świadomie NIE obejmuje ─────────────────────────────────
 * Bariera jest tu odwzorowana w pamięci (`LocalBarrier`), a nie na Postgresie.
 * To jest ROZDZIELENIE PRZEDMIOTU POMIARU, nie skrót: sam SQL bariery jest
 * dowiedziony przebiegiem na realnej bazie w
 * `messaging-dispatch-barrier-pg.integration.test.ts` (Story 4.1) i bramce
 * `dispatch-barrier-pg-suite`. Tutaj przedmiotem jest wyłącznie to, czy po
 * awarii w oknie do klientki idzie JEDEN mail czy DWA.
 *
 * ── Bez poświadczeń: SKIP Z POWODEM, nigdy zieleń ─────────────────────────
 * Brak `BREVO_API_KEY` / `BREVO_LIVE_PROOF_RECIPIENT` pomija suitę. Zielony
 * przebieg jednostkowy w miejscu tego dowodu byłby maskowaniem, nie
 * ograniczeniem.
 *
 * ── Ta suita WYSYŁA REALNE MAILE ──────────────────────────────────────────
 * Wyłącznie na adres z `BREVO_LIVE_PROOF_RECIPIENT` (w przebiegu dowodowym
 * 2026-08-08: adres właściciela konta). Nigdy na adres klientki.
 */
import {
  BrevoAdapter,
  BrevoHttpClient,
  DEFAULT_BARRIER_IN_FLIGHT_WINDOW_MS,
  DefaultMessagingGateway,
  buildBarrierKey,
  buildDispatchIdentityTag,
} from "@gp/messaging"
import type {
  BarrierClaim,
  BarrierClaimInput,
  BarrierSettleInput,
  DispatchIdempotencyBarrier,
  NotificationDispatch,
  NotificationIntent,
} from "@gp/messaging"

const API_KEY = (process.env.BREVO_API_KEY ?? "").trim()
const RECIPIENT = (process.env.BREVO_LIVE_PROOF_RECIPIENT ?? "").trim()
const SENDERS_RAW = (process.env.BREVO_SENDERS ?? "").trim()
const TEMPLATE_ID = Number(process.env.BREVO_LIVE_PROOF_TEMPLATE_ID ?? "")
const MARKET = (process.env.BREVO_LIVE_PROOF_MARKET ?? "bonbeauty").trim()

const LIVE =
  Boolean(API_KEY) &&
  Boolean(RECIPIENT) &&
  Boolean(SENDERS_RAW) &&
  Number.isFinite(TEMPLATE_ID) &&
  TEMPLATE_ID > 0

/**
 * Latencja indeksacji tagu po stronie dostawcy. ZMIERZONA 2026-08-08 sondą co
 * 8 s: trafienie między 16 s a 24 s. 90 s to zapas, a nie zgadywanka.
 *
 * W produkcji ta latencja nie ma znaczenia: odczyt jest wołany dopiero po
 * wygaśnięciu okna `in_flight` (15 min), czyli o dwa rzędy wielkości później.
 */
const PROVIDER_INDEXING_BUDGET_MS = 90_000
const POLL_INTERVAL_MS = 6_000

const TEMPLATE_KEY = "voucher_purchase_confirmation"

/** Bariera w pamięci — semantyka `WHERE` z `PgDispatchIdempotencyBarrier`. */
class LocalBarrier implements DispatchIdempotencyBarrier {
  readonly rows = new Map<
    string,
    {
      state: "in_flight" | "settled"
      dispatch: NotificationDispatch | null
      expires_at_ms: number | null
      claim_token: string
      claim_count: number
    }
  >()

  async claim(input: BarrierClaimInput): Promise<BarrierClaim> {
    const nowMs = input.now.getTime()
    const existing = this.rows.get(input.barrier_key)
    const reclaimable =
      existing === undefined ||
      (existing.expires_at_ms !== null && existing.expires_at_ms <= nowMs)

    if (!reclaimable) {
      return {
        outcome: "blocked",
        dispatch: existing!.state === "settled" ? existing!.dispatch : null,
        claim_count: 0,
      }
    }

    const claimCount = (existing?.claim_count ?? 0) + 1
    this.rows.set(input.barrier_key, {
      state: "in_flight",
      dispatch: null,
      expires_at_ms: nowMs + input.in_flight_window_ms,
      claim_token: input.claim_token,
      claim_count: claimCount,
    })
    return { outcome: "claimed", dispatch: null, claim_count: claimCount }
  }

  async settle(input: BarrierSettleInput): Promise<void> {
    const existing = this.rows.get(input.barrier_key)
    if (existing?.claim_token !== input.claim_token) return
    this.rows.set(input.barrier_key, {
      ...existing,
      state: "settled",
      dispatch: input.dispatch,
      expires_at_ms: input.expires_at ? input.expires_at.getTime() : null,
    })
  }

  async release(input: { barrier_key: string; claim_token: string }): Promise<void> {
    const existing = this.rows.get(input.barrier_key)
    if (existing?.state !== "in_flight") return
    if (existing.claim_token !== input.claim_token) return
    this.rows.delete(input.barrier_key)
  }
}

function makeClient(): BrevoHttpClient {
  return new BrevoHttpClient({ apiKey: API_KEY, timeoutMs: 20_000 })
}

function makeAdapter(): BrevoAdapter {
  return new BrevoAdapter(makeClient(), {
    senders: JSON.parse(SENDERS_RAW) as Record<
      string,
      { email: string; name?: string }
    >,
    templates: { [TEMPLATE_KEY]: TEMPLATE_ID },
  })
}

function makeIntent(idempotencyKey: string): NotificationIntent {
  return {
    flow_id: "voucher_delivery_recipient",
    channel: "email",
    template_key: TEMPLATE_KEY,
    recipient: { email: RECIPIENT, market_id: MARKET },
    variables: {},
    locale: "pl-PL",
    consent_basis: "transactional_critical",
    idempotency_key: idempotencyKey,
  }
}

/**
 * LICZBA WIADOMOŚCI PO STRONIE DOSTAWCY dla danej tożsamości.
 *
 * Dopasowanie po `tags` na zwróconych wierszach, a NIE po serwerowym filtrze
 * `tags` — ten jest zmierzonym no-opem (zapytanie o nieistniejący tag oddaje
 * komplet). Bramka licząca po serwerowym filtrze zawsze widziałaby „jest"
 * i przechodziłaby na zepsutym kodzie.
 */
async function countAtProvider(identity: string): Promise<number> {
  const client = makeClient()
  const now = new Date()
  const rows = await client.findTransactionalMessages({
    email: RECIPIENT,
    templateId: TEMPLATE_ID,
    startDate: new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000),
    endDate: now,
    limit: 500,
  })
  return rows.filter((row) => (row.tags ?? []).includes(identity)).length
}

/** Czeka, aż dostawca zaindeksuje CO NAJMNIEJ `expected` wiadomości. */
async function waitForProvider(identity: string, expected: number): Promise<number> {
  const deadline = Date.now() + PROVIDER_INDEXING_BUDGET_MS
  let seen = 0
  while (Date.now() < deadline) {
    seen = await countAtProvider(identity)
    if (seen >= expected) return seen
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS))
  }
  return seen
}

const suite = LIVE ? describe : describe.skip

suite("Story 4.5 AC4 — dowód PO STRONIE DOSTAWCY", () => {
  jest.setTimeout(10 * 60 * 1000)

  /** Unikalny sufiks przebiegu — żeby dwa przebiegi dowodowe się nie mieszały. */
  const run = `p${Date.now().toString(36)}`

  it("wariant (ii): proces GINIE po wysyłce ⇒ ponowienie daje JEDEN mail u dostawcy", async () => {
    const barrier = new LocalBarrier()
    const adapter = makeAdapter()
    const intent = makeIntent(`${run}-dead`)
    const identity = buildDispatchIdentityTag(buildBarrierKey(intent))
    const t0 = new Date()

    // ── Martwy przebieg: zajmuje barierę, wysyła REALNY mail, i znika ──────
    // Nic więcej: ani `settle`, ani `catch`, ani logu. Dokładnie to, co
    // zostawia po sobie `kill -9` między dwiema liniami gatewaya.
    const claim = await barrier.claim({
      barrier_key: buildBarrierKey(intent),
      now: t0,
      in_flight_window_ms: DEFAULT_BARRIER_IN_FLIGHT_WINDOW_MS,
      claim_token: "token-martwego-przebiegu",
    })
    expect(claim.outcome).toBe("claimed")
    await adapter.send(intent)

    expect(await waitForProvider(identity, 1)).toBe(1)

    // ── Ponowienie w nowym procesie, PO wygaśnięciu okna `in_flight` ───────
    const tRetry = new Date(t0.getTime() + DEFAULT_BARRIER_IN_FLIGHT_WINDOW_MS + 1)
    const gateway = new DefaultMessagingGateway({ brevo: adapter }, "brevo", {
      barrier,
      clock: () => tRetry,
    })
    const dispatch = await gateway.send(intent)
    expect(dispatch.status).toBe("sent")

    // Gdyby mimo wszystko poszedł drugi mail, dostawca pokazałby go w tym
    // samym oknie indeksacji, co pierwszy.
    await new Promise((resolve) => setTimeout(resolve, PROVIDER_INDEXING_BUDGET_MS))
    expect(await countAtProvider(identity)).toBe(1)
  })

  it("wariant (i): `settle` RZUCA ⇒ ponowienie daje JEDEN mail u dostawcy", async () => {
    // Wariant ŁATWIEJSZY od (ii) — tu blok `catch` gatewaya się wykonuje i
    // log powstaje. Mierzony osobno, bo AC4 wymaga obu, a nie „jednego przez
    // podobieństwo": ścieżka przez `catch` domyka barierę inaczej niż śmierć
    // procesu i mogłaby się rozejść przy zmianie `settleBarrier`.
    const barrier = new LocalBarrier()
    let settleCalls = 0
    const failingSettle: DispatchIdempotencyBarrier = {
      claim: (input) => barrier.claim(input),
      release: (input) => barrier.release(input),
      settle: async (input) => {
        settleCalls += 1
        if (settleCalls === 1) {
          throw new Error("magazyn bariery odmówił domknięcia")
        }
        return barrier.settle(input)
      },
    }
    const adapter = makeAdapter()
    const intent = makeIntent(`${run}-settlefail`)
    const identity = buildDispatchIdentityTag(buildBarrierKey(intent))
    const t0 = new Date()

    await new DefaultMessagingGateway({ brevo: adapter }, "brevo", {
      barrier: failingSettle,
      clock: () => t0,
    }).send(intent)
    expect(settleCalls).toBe(1)
    expect(await waitForProvider(identity, 1)).toBe(1)

    const tRetry = new Date(t0.getTime() + DEFAULT_BARRIER_IN_FLIGHT_WINDOW_MS + 1)
    const dispatch = await new DefaultMessagingGateway(
      { brevo: adapter },
      "brevo",
      { barrier: failingSettle, clock: () => tRetry },
    ).send(intent)
    expect(dispatch.status).toBe("sent")

    await new Promise((resolve) => setTimeout(resolve, PROVIDER_INDEXING_BUDGET_MS))
    expect(await countAtProvider(identity)).toBe(1)
  })

  it("KONTROLA KONTROLI: bez mechanizmu ten sam przebieg daje DWA maile u dostawcy", async () => {
    // Topologia sprzed Story 4.5: bariera nie raportuje przejęcia zajęcia,
    // więc gateway nie ma sygnału, żeby zapytać dostawcę, i wysyła w ciemno.
    // Test, który przechodzi w OBU stanach świata, nie mierzy niczego.
    const barrier = new LocalBarrier()
    const preStory45: DispatchIdempotencyBarrier = {
      claim: async (input) => ({ ...(await barrier.claim(input)), claim_count: 1 }),
      settle: (input) => barrier.settle(input),
      release: (input) => barrier.release(input),
    }
    const adapter = makeAdapter()
    const intent = makeIntent(`${run}-baseline`)
    const identity = buildDispatchIdentityTag(buildBarrierKey(intent))
    const t0 = new Date()

    await preStory45.claim({
      barrier_key: buildBarrierKey(intent),
      now: t0,
      in_flight_window_ms: DEFAULT_BARRIER_IN_FLIGHT_WINDOW_MS,
      claim_token: "token-martwego-przebiegu",
    })
    await adapter.send(intent)
    expect(await waitForProvider(identity, 1)).toBe(1)

    const tRetry = new Date(t0.getTime() + DEFAULT_BARRIER_IN_FLIGHT_WINDOW_MS + 1)
    await new DefaultMessagingGateway({ brevo: adapter }, "brevo", {
      barrier: preStory45,
      clock: () => tRetry,
    }).send(intent)

    expect(await waitForProvider(identity, 2)).toBe(2)
  })

  it("KONTROLA DODATNIA: inne zdarzenie przechodzi u dostawcy normalnie", async () => {
    const barrier = new LocalBarrier()
    const adapter = makeAdapter()
    const intent = makeIntent(`${run}-legit`)
    const identity = buildDispatchIdentityTag(buildBarrierKey(intent))

    const dispatch = await new DefaultMessagingGateway(
      { brevo: adapter },
      "brevo",
      { barrier, clock: () => new Date() },
    ).send(intent)

    expect(dispatch.status).toBe("queued")
    expect(await waitForProvider(identity, 1)).toBe(1)
  })
})
