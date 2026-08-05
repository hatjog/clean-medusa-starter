/**
 * vendor-replay-guard — bariera anty-replay dla uwierzytelnienia `/vendor/*`.
 *
 * v1.15.0 Story 5.3 (FR-11 człon replay-guard, AD-20, AD-23, ADR-185).
 *
 * ── Co ta bariera zastępuje ────────────────────────────────────────────────
 * Do v1.14.0 ochronę stanowiła `NonceLru` — mapa `${sellerId}:${nonce}` →
 * `expiry` W PAMIĘCI PROCESU, a `check()` był sekwencją `Map.get` → warunek →
 * `Map.set`. To dokładnie kształt, który AD-23 nazywa defektem: „odczyt →
 * operacja → zapis to nadal dwie wysyłki przy dwóch instancjach". Przy dwóch
 * instancjach API bariera nie widziała powtórzenia w ogóle, bo każda instancja
 * miała własną mapę.
 *
 * ── Bariera jest JEDNYM stwierdzeniem wykonywalnym (AD-23) ─────────────────
 * `claimReplayGuardKey` wysyła do bazy DOKŁADNIE jedno `INSERT … ON CONFLICT
 * … DO UPDATE … WHERE …` i czyta werdykt z LICZBY ZWRÓCONYCH WIERSZY. Nie ma
 * poprzedzającego `SELECT`, nie ma „sprawdź w kodzie, potem zapisz". Trzy
 * przypadki rozstrzyga sama baza:
 *
 *   1. klucza nie ma           → `INSERT` wchodzi        → 1 wiersz → ŚWIEŻE
 *   2. klucz jest, ale wygasł  → predykat `WHERE` prawdziwy, `DO UPDATE`
 *                                odnawia wpis            → 1 wiersz → ŚWIEŻE
 *   3. klucz jest i żyje       → predykat `WHERE` fałszywy, `DO UPDATE`
 *                                nie wykonuje się        → 0 wierszy → POWTÓRZENIE
 *
 * ── Okno ważności jest W PREDYKACIE, nie w harmonogramie (AD-23) ───────────
 * Przypadek 2 to całe „wygasanie": wygasły wiersz przestaje blokować, bo mówi
 * o tym `WHERE`, a nie dlatego, że ktoś go skasował. Konsekwencja jest wprost
 * taka, jakiej wymaga AD-23: ZATRZYMANY SPRZĄTACZ NIE ZMIENIA WERDYKTU
 * BARIERY. `DELETE FROM … WHERE expires_at < now()` (patrz `purgeExpired`)
 * jest wyłącznie HIGIENĄ — odzyskuje miejsce, nie decyduje o poprawności.
 *
 * ── Baza czasu ─────────────────────────────────────────────────────────────
 * Predykat okna liczy się na czasie PODANYM PRZEZ WOŁAJĄCEGO (`nowSec`), a nie
 * na `now()` bazy. Powód jest merytoryczny, nie testowy: kontrola dryfu
 * znacznika czasu (`verifyVendorSignature`) już używa zegara procesu API, więc
 * gdyby okno liczyło się zegarem bazy, oba mechanizmy mogłyby się rozjechać i
 * okno przestałoby być wyprowadzalne z dryfu. Efektem ubocznym jest to, że
 * okno da się sterować w teście bez czekania zegarem ściennym.
 *
 * ── Klucz jest NIEZALEŻNY OD SEKRETU (AD-20) ───────────────────────────────
 * Patrz `buildReplayGuardKey`.
 *
 * @module vendor-replay-guard
 */
import { createHash } from "crypto"

import { toKnexPositionalSql } from "../knex-positional-sql"

/** Nazwa tabeli bariery. Zakładana przez `Migration20260816090000VendorReplayGuardTable`. */
export const VENDOR_REPLAY_GUARD_TABLE = "vendor_replay_guard"

/**
 * Margines na rozjazd zegarów MIĘDZY INSTANCJAMI, doliczany do okna.
 *
 * Po co: `expires_at` zapisuje instancja, która przyjęła żądanie jako pierwsza,
 * używając SWOJEGO zegara; predykat okna ocenia instancja, która dostała
 * powtórzenie, używając SWOJEGO. Jeżeli druga instancja spieszy się względem
 * pierwszej, widzi wpis jako wygasły WCZEŚNIEJ, niż powinien — czyli skraca
 * okno i otwiera szczelinę powtórzenia. Margines domyka tę szczelinę w jedyną
 * bezpieczną stronę (wpis żyje dłużej, nigdy krócej).
 *
 * Wartość: 60 s. To ta sama klasa tolerancji, którą i tak zakłada infrastruktura
 * NTP-owana; poniżej tego progu bariera zaczynałaby zależeć od jakości
 * synchronizacji zegarów, a nie od własnego predykatu.
 */
export const REPLAY_GUARD_CLOCK_SKEW_MARGIN_SEC = 60

/**
 * Wyprowadza okno ważności wpisu bariery z HORYZONTU PONOWIEŃ (AD-23:
 * „okno wywodzi się z horyzontu ponowień, nie z wygody").
 *
 * Wyprowadzenie, nie wygoda:
 *  1. Żądanie jest w ogóle ZDATNE do przyjęcia tylko wtedy, gdy
 *     `|now - ts| <= driftSeconds` — poza tym pada na
 *     `VENDOR_AUTH_TIMESTAMP_EXPIRED` jeszcze przed barierą.
 *  2. Napastnik, który przechwycił nagłówek podpisany w chwili `ts`, może więc
 *     próbować go odtworzyć w oknie `[ts - drift, ts + drift]` — czyli przez
 *     `2 × drift` sekund. Wpis MUSI przeżyć całe to okno, inaczej powtórzenie
 *     trafia na wygasły wpis i przechodzi. Stąd `2 × drift` jest DOLNĄ GRANICĄ
 *     poprawności, a nie preferencją (dzisiejsze `ttlSec = driftSeconds * 2`
 *     w `NonceLru` miało tę samą wartość — zmienia się nośnik, nie arytmetyka).
 *  3. Legalne ponowienie klienta NIE jest tu kosztem: ponowienie z tym samym
 *     `nonce` jest z definicji powtórzeniem, więc klient ponawiający żądanie
 *     losuje nowy `nonce` i nowego klucza bariery i tak nie dotyka. Horyzont
 *     ponowień nie wymusza więc okna KRÓTSZEGO.
 *  4. Do tego margines na rozjazd zegarów między instancjami (wyżej).
 *
 * Okno DŁUŻSZE niż to jest wyłącznie kosztem miejsca w tabeli (higiena),
 * nigdy błędem poprawności. Okno KRÓTSZE otwiera okno powtórzenia.
 */
export function deriveReplayGuardWindowSec(driftSeconds: number): number {
  return driftSeconds * 2 + REPLAY_GUARD_CLOCK_SKEW_MARGIN_SEC
}

/** Skrót ciała o zerowej długości — wartość dla żądań BEZ ciała (np. GET). */
export const EMPTY_BODY_DIGEST = createHash("sha256").update(Buffer.alloc(0)).digest("hex")

function sha256Hex(input: Buffer | string): string {
  return createHash("sha256").update(input).digest("hex")
}

/**
 * Kanoniczna serializacja ciała już sparsowanego przez body-parser.
 *
 * Po co kanoniczna, a nie `JSON.stringify`: klucz bariery musi być
 * DETERMINISTYCZNY dla tego samego żądania. `JSON.stringify` zachowuje
 * kolejność wstawiania kluczy, a ta zależy od kolejności bajtów w ciele —
 * czyli to samo semantycznie ciało dałoby dwa różne klucze. Klucze obiektów są
 * więc sortowane rekurencyjnie; tablice zachowują kolejność (jest znacząca).
 */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null"
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`
  }
  const entries = Object.keys(value as Record<string, unknown>)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`)
  return `{${entries.join(",")}}`
}

type RequestLike = {
  /** Obecne tylko na trasach z `bodyParser: { preserveRawBody: true }`. */
  rawBody?: Buffer | string
  body?: unknown
}

/**
 * Liczy SKRÓT TREŚCI ŻĄDANIA — po stronie serwera, z tego, co realnie przyszło.
 *
 * WAŻNE OGRANICZENIE (ADR-185, i celowo powtórzone tutaj, żeby nie umarło
 * w dokumencie): kształt podpisu jest ZAMROŻONY przez Story 5.2 AC2 —
 * `payload = ${sellerId}.${ts}.${nonce}`, BEZ ciała. Ten skrót wchodzi więc
 * wyłącznie do KLUCZA BARIERY, a nie do materiału podpisu. Skutek: skrót
 * ZAWĘŻA klucz (dwa różne ciała pod tym samym `nonce` nie sklejają się w jeden
 * wpis), ale NIE AUTORYZUJE ciała — podpis go nie obejmuje, więc ten mechanizm
 * nie jest i nie udaje kontroli integralności ładunku.
 *
 * Kolejność źródeł:
 *  1. `rawBody` (bajt w bajt) — gdy trasa je zachowuje,
 *  2. kanoniczne JSON sparsowanego `body`,
 *  3. brak ciała → {@link EMPTY_BODY_DIGEST}.
 *
 * Wariant 3 jest ODRÓŻNIALNY od `POST {}`: puste ciało to skrót zera bajtów,
 * a `{}` to skrót dwóch bajtów `{}`. Gdyby oba dawały tę samą wartość, dwa
 * różne żądania dzieliłyby jeden klucz.
 */
export function computeBodyDigest(req: RequestLike): string {
  const raw = req.rawBody
  if (Buffer.isBuffer(raw)) {
    return sha256Hex(raw)
  }
  if (typeof raw === "string") {
    return sha256Hex(Buffer.from(raw, "utf8"))
  }

  const body = req.body
  if (body === undefined || body === null) {
    return EMPTY_BODY_DIGEST
  }
  return sha256Hex(Buffer.from(canonicalJson(body), "utf8"))
}

/**
 * Buduje klucz anty-replay (AD-20).
 *
 * ── Klucz jest funkcją WYŁĄCZNIE materiału jawnego ─────────────────────────
 * `sellerId` + `ts` + `nonce` + skrót treści. Nie wchodzi tu ani sekret, ani
 * nic z niego wywiedzionego — w szczególności NIE WCHODZI `sig`. Powód jest
 * dokładnie tym defektem, przed którym ta story chroni: `sig` jest funkcją
 * sekretu, więc klucz oparty na podpisie ZMIENIA SIĘ przy rotacji sekretu, a
 * zmiana klucza to nowy wpis — czyli rotacja sekretu otwierałaby okno, w którym
 * przechwycone żądanie da się powtórzyć.
 *
 * ── Odporność na sklejenie członów ─────────────────────────────────────────
 * Każdy człon jest poprzedzony swoją DŁUGOŚCIĄ, więc `("a", "bc")` i
 * `("ab", "c")` nie mogą dać tej samej reprezentacji — sam separator by tego
 * nie zagwarantował, bo `sellerId` i `nonce` są materiałem z żądania.
 *
 * Zwracany klucz to skrót o stałej długości (64 znaki hex): dzięki temu indeks
 * unikalności ma ograniczoną szerokość niezależnie od długości `nonce`.
 */
export function buildReplayGuardKey(params: {
  sellerId: string
  ts: string
  nonce: string
  bodyDigest: string
}): string {
  const { sellerId, ts, nonce, bodyDigest } = params
  const parts = [sellerId, ts, nonce, bodyDigest]
  const material = `vrg1|${parts.map((p) => `${Buffer.byteLength(p, "utf8")}:${p}`).join("|")}`
  return sha256Hex(Buffer.from(material, "utf8"))
}

/** Minimalny kontrakt, jakiego bariera potrzebuje od `PG_CONNECTION` (instancja Knexa). */
export type ReplayGuardDb = {
  raw: (sql: string, bindings?: readonly unknown[]) => Promise<unknown>
}

/**
 * Odczytuje liczbę wierszy zwróconych przez `RETURNING` niezależnie od tego,
 * czy sterownik oddał kształt `pg` (`{ rows }`), czy „gołą" tablicę Knexa.
 */
function countReturnedRows(result: unknown): number {
  if (Array.isArray(result)) {
    return result.length
  }
  if (result && typeof result === "object") {
    const rows = (result as { rows?: unknown }).rows
    if (Array.isArray(rows)) {
      return rows.length
    }
    const rowCount = (result as { rowCount?: unknown }).rowCount
    if (typeof rowCount === "number") {
      return rowCount
    }
  }
  return 0
}

/**
 * JEDNA operacja atomowa: zajmuje klucz albo stwierdza powtórzenie.
 *
 * @returns `true` gdy klucz był ŚWIEŻY (żądanie przechodzi),
 *          `false` gdy klucz jest już zajęty i wciąż w oknie (POWTÓRZENIE).
 *
 * Wołający MUSI wywołać to DOPIERO PO udanej weryfikacji podpisu (AD-20) —
 * inaczej dowolny nadawca zatruwa tabelę cudzymi kluczami (DoS na sprzedawcę
 * i oraculum czasowe). Kolejność egzekwuje `vendor-auth.ts`.
 */
export async function claimReplayGuardKey(
  db: ReplayGuardDb,
  params: {
    guardKey: string
    sellerId: string
    nowSec: number
    windowSec: number
  }
): Promise<boolean> {
  const { guardKey, sellerId, nowSec, windowSec } = params

  const nowIso = new Date(nowSec * 1000).toISOString()
  const expiresIso = new Date((nowSec + windowSec) * 1000).toISOString()

  // Jedno stwierdzenie. Werdykt = liczba wierszy z `RETURNING`.
  // `WHERE` na `DO UPDATE` to CAŁE egzekwowanie okna — wygasły wpis jest
  // odnawiany (i przepuszcza), żyjący nie jest ruszany (i blokuje).
  const { text, bindings } = toKnexPositionalSql(
    `INSERT INTO ${VENDOR_REPLAY_GUARD_TABLE} (guard_key, seller_id, expires_at, created_at)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (guard_key) DO UPDATE
       SET expires_at = EXCLUDED.expires_at,
           seller_id  = EXCLUDED.seller_id,
           created_at = EXCLUDED.created_at
     WHERE ${VENDOR_REPLAY_GUARD_TABLE}.expires_at <= $5
     RETURNING guard_key`,
    [guardKey, sellerId, expiresIso, nowIso, nowIso]
  )

  const result = await db.raw(text, bindings)
  return countReturnedRows(result) > 0
}

/**
 * HIGIENA, NIE POPRAWNOŚĆ — odzyskuje miejsce po wygasłych wpisach.
 *
 * Świadomie NIE jest wołane ze ścieżki żądania i świadomie nie ma tu żadnego
 * harmonogramu. Werdykt bariery nie zależy od tego, czy ta funkcja kiedykolwiek
 * się wykona (okno siedzi w predykacie `claimReplayGuardKey`); zatrzymanie
 * sprzątania powoduje wyłącznie wzrost tabeli.
 *
 * Właściciel zobowiązania operacyjnego: Platform Ops (retencja tabel
 * technicznych backendu), tak jak dla pozostałych tabel-ledgerów `api`.
 */
export async function purgeExpiredReplayGuardRows(
  db: ReplayGuardDb,
  nowSec: number
): Promise<void> {
  const nowIso = new Date(nowSec * 1000).toISOString()
  const { text, bindings } = toKnexPositionalSql(
    `DELETE FROM ${VENDOR_REPLAY_GUARD_TABLE} WHERE expires_at <= $1`,
    [nowIso]
  )
  await db.raw(text, bindings)
}
