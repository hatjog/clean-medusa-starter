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
 * ── DWA klucze w JEDNYM stwierdzeniu (ADR-185 D8) ──────────────────────────
 * Bariera zajmuje NA RAZ dwa klucze: `bodyKey` (z AD-20: sprzedawca, ts, nonce,
 * skrót treści) oraz `nonceKey` (sprzedawca, ts, nonce — BEZ treści). Powód jest
 * konkretny: podpis 5.2 NIE obejmuje ciała, więc gdyby jedynym kluczem był
 * `bodyKey`, jeden przechwycony nagłówek dałby się użyć DOWOLNIE WIELE RAZY —
 * wystarczyłoby za każdym razem zmienić ciało, żeby dostać inny klucz. `nonceKey`
 * przywraca to, co dawała stara `NonceLru` (nonce jednorazowy niezależnie od
 * ciała), a `bodyKey` zostaje, bo wymaga go AD-20.
 *
 * Oba klucze idą jako DWA WIERSZE tego samego `INSERT … ON CONFLICT … RETURNING`,
 * więc AD-23 („jedna operacja atomowa, nie sekwencja") jest nadal spełnione
 * literalnie: jedna wysyłka, jedno stwierdzenie, jeden werdykt z liczby wierszy.
 *
 * @module vendor-replay-guard
 */
import { createHash } from "crypto"

import { toKnexPositionalSql } from "../knex-positional-sql"
import {
  requireMarketContext,
  type SystemExecutionOrigin,
} from "../system-market-context"

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
  return hashKeyMaterial("body", [sellerId, ts, nonce, bodyDigest])
}

/**
 * Buduje WĘŻSZY klucz bariery: sprzedawca + `ts` + `nonce`, BEZ skrótu treści.
 *
 * ── Po co drugi klucz, skoro AD-20 wymienia skrót treści ───────────────────
 * Bo w tej konfiguracji sam `bodyKey` NIE JEST barierą — jest jej rozluźnieniem.
 * Złóż trzy fakty: (1) podpis 5.2 obejmuje `sellerId.ts.nonce`, ale NIE ciało;
 * (2) nagłówek jest przyjmowany przez całe `±drift`; (3) `bodyKey` zależy od
 * ciała. Napastnik z JEDNYM przechwyconym nagłówkiem wysyła N żądań o RÓŻNYCH
 * ciałach — każde dostaje inny `bodyKey`, więc każde przechodzi. Realna trasa,
 * na której to boli: `POST /vendor/training-cert/upload` niesie plik w ciele.
 * Stara `NonceLru` (klucz `seller:nonce`) odbijała je wszystkie.
 *
 * `nonceKey` przywraca dokładnie tę własność: **nonce jest jednorazowy
 * niezależnie od ciała**. `bodyKey` zostaje obok, bo wymaga go AD-20 i bo zawęża
 * klucz tam, gdzie ciało faktycznie różnicuje żądania.
 *
 * Oba klucze są liczone tą samą konstrukcją (prefiks długości, wersja),
 * ale z RÓŻNYM znacznikiem dziedziny (`body` vs `nonce`), więc nie mogą się
 * zejść do jednej wartości nawet przy identycznych członach.
 */
export function buildNonceScopeKey(params: {
  sellerId: string
  ts: string
  nonce: string
}): string {
  const { sellerId, ts, nonce } = params
  return hashKeyMaterial("nonce", [sellerId, ts, nonce])
}

function hashKeyMaterial(scope: "body" | "nonce", parts: readonly string[]): string {
  const material = `vrg1|${scope}|${parts
    .map((p) => `${Buffer.byteLength(p, "utf8")}:${p}`)
    .join("|")}`
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
 * JEDNA operacja atomowa: zajmuje WSZYSTKIE podane klucze albo stwierdza
 * powtórzenie.
 *
 * @returns `true` gdy KAŻDY z kluczy był ŚWIEŻY (żądanie przechodzi),
 *          `false` gdy CHOĆBY JEDEN jest już zajęty i wciąż w oknie
 *          (POWTÓRZENIE).
 *
 * Werdykt „wszystkie albo nic" jest celowy i jest ZAOSTRZAJĄCY: klucze zajmowane
 * są w jednym stwierdzeniu, więc żądanie odrzucone mogło mimochodem zająć ten
 * drugi klucz. To nigdy nie przepuszcza powtórzenia — najwyżej spala nonce,
 * który i tak już był spalony (ta sama klasa skutku, co „spalone żądanie" z
 * ADR-185 D5).
 *
 * Wołający MUSI wywołać to DOPIERO PO udanej weryfikacji podpisu (AD-20) —
 * inaczej dowolny nadawca zatruwa tabelę cudzymi kluczami (DoS na sprzedawcę
 * i oraculum czasowe). Kolejność egzekwuje `vendor-auth.ts`.
 */
export async function claimReplayGuardKey(
  db: ReplayGuardDb,
  params: {
    guardKeys: readonly string[]
    sellerId: string
    nowSec: number
    windowSec: number
  }
): Promise<boolean> {
  const { sellerId, nowSec, windowSec } = params

  // Deduplikacja jest OBRONNA, nie kosmetyczna: `ON CONFLICT DO UPDATE` w
  // Postgresie rzuca „cannot affect row a second time", gdy jedno stwierdzenie
  // dwa razy trafi w ten sam wiersz. Znaczniki dziedziny czynią to praktycznie
  // niemożliwym, ale bariera nie ma prawa paść na kształcie wejścia.
  const guardKeys = [...new Set(params.guardKeys)]
  if (guardKeys.length === 0) {
    throw new Error("claimReplayGuardKey: pusty zbiór kluczy — bariera nie ma czego zająć")
  }

  const nowIso = new Date(nowSec * 1000).toISOString()
  const expiresIso = new Date((nowSec + windowSec) * 1000).toISOString()

  // Każdy wiersz dostaje WŁASNE, kolejne placeholdery — bez powtarzania `$N`.
  // Dzięki temu lista bindingów jest regularna (grupy po cztery w kolejności
  // kolumn, na końcu próg predykatu) i czytelna dla każdego, kto ją ogląda
  // w logu sterownika albo w teście.
  const values = guardKeys
    .map((_key, i) => `($${i * 4 + 1}, $${i * 4 + 2}, $${i * 4 + 3}, $${i * 4 + 4})`)
    .join(", ")
  const nowPlaceholder = `$${guardKeys.length * 4 + 1}`
  const bindingValues = [
    ...guardKeys.flatMap((key) => [key, sellerId, expiresIso, nowIso]),
    nowIso,
  ]

  // Jedno stwierdzenie. Werdykt = liczba wierszy z `RETURNING`.
  // `WHERE` na `DO UPDATE` to CAŁE egzekwowanie okna — wygasły wpis jest
  // odnawiany (i przepuszcza), żyjący nie jest ruszany (i blokuje).
  const { text, bindings } = toKnexPositionalSql(
    `INSERT INTO ${VENDOR_REPLAY_GUARD_TABLE} (guard_key, seller_id, expires_at, created_at)
     VALUES ${values}
     ON CONFLICT (guard_key) DO UPDATE
       SET expires_at = EXCLUDED.expires_at,
           seller_id  = EXCLUDED.seller_id,
           created_at = EXCLUDED.created_at
     WHERE ${VENDOR_REPLAY_GUARD_TABLE}.expires_at <= ${nowPlaceholder}
     RETURNING guard_key`,
    bindingValues
  )

  const result = await db.raw(text, bindings)
  // „Wszystkie albo nic": brakujący wiersz = któryś klucz żyje = POWTÓRZENIE.
  return countReturnedRows(result) === guardKeys.length
}

/**
 * Wyrażenie przypisujące WIERSZ BARIERY do rynku (AD-21).
 *
 * Wiersz bariery nie niesie własnej kolumny rynku i to jest decyzja, nie
 * przeoczenie: `/vendor/*` NIE ma kontekstu rynku (kontekst ustawia wyłącznie
 * łańcuch `/store/*`, `api/middlewares.ts`), więc jedynym sposobem na kolumnę
 * byłoby DOŁOŻENIE ODCZYTU sprzedawcy do gorącej ścieżki uwierzytelnienia —
 * czyli drugiej wysyłki do bazy na żądanie, dokładnie tego, czego zabrania AC1
 * (AD-23: bariera to JEDNA operacja). Atrybucja jest więc wyliczana DOPIERO
 * przy sprzątaniu, gdzie kosztuje raz na 15 minut, a nie raz na żądanie.
 *
 * Wyrażenie jest tym samym, którym repo już posługuje się dla sprzedawców
 * (`lib/review-market-scope.ts:66`): `seller.metadata->'gp'->>'market_id'`.
 * Rozjazd tych dwóch miejsc oznaczałby dwie prawdy o tym, do jakiego rynku
 * należy sprzedawca.
 */
export const REPLAY_GUARD_SELLER_MARKET_EXPR =
  "seller.metadata->'gp'->>'market_id'"

/** Opcje diagnostyczne sprzątania — trafiają do logu i metryki ODMOWY (NFR-2). */
export type ReplayGuardPurgeOptions = {
  origin?: SystemExecutionOrigin
  logger?: {
    warn?: (message: string, meta?: Record<string, unknown>) => void
    error?: (message: string, meta?: Record<string, unknown>) => void
  }
}

/**
 * HIGIENA, NIE POPRAWNOŚĆ — odzyskuje miejsce po wygasłych wpisach
 * ZADEKLAROWANEGO rynku.
 *
 * Świadomie NIE jest wołane ze ścieżki żądania i świadomie nie ma tu żadnego
 * harmonogramu. Werdykt bariery nie zależy od tego, czy ta funkcja kiedykolwiek
 * się wykona (okno siedzi w predykacie `claimReplayGuardKey`); zatrzymanie
 * sprzątania powoduje wyłącznie wzrost tabeli.
 *
 * ── Dlaczego to WOŁA NOŚNIK, a nie tylko przyjmuje `marketId` (AD-21) ──────
 * To jest POWIERZCHNIA ZAPISU poza żądaniem HTTP: `DELETE` bez zadeklarowanego
 * rynku skasowałby wiersze WSZYSTKICH rynków, a hook RLS przy braku kontekstu
 * oddaje połączenie NIETKNIĘTE (rola aplikacyjna, dla której RLS nie
 * obowiązuje) — czyli cichy zapis poza izolacją. Dlatego rynek pochodzi
 * z `requireMarketContext`, a nie z argumentu: gdyby był argumentem, wołający,
 * który go pominie (albo poda „wszystko"), obchodziłby kontrolę bez śladu.
 * Brak kontekstu = ODMOWA GŁOŚNA (wyjątek + log + metryka), nie „skasuj wszystko".
 * Wołający deklaruje rynki przez `runInSystemMarketContext` —
 * `jobs/vendor-replay-guard-purge.ts`.
 *
 * ── Konsekwencja, która musi być nazwana ───────────────────────────────────
 * Wiersze sprzedawców SPOZA zadeklarowanych rynków — oraz sprzedawców BEZ
 * `metadata.gp.market_id` — NIE są kasowane. To jest wprost semantyka AD-21
 * („kontekst bez rynku jest odmową, nie dostępem do wszystkiego"), a nie
 * przeoczenie: ich retencja wymaga DEKLARACJI ich rynku, nie rozszerzenia
 * uprawnień sprzątacza. Skutkiem jest wyłącznie wzrost tabeli (higiena),
 * nigdy zmiana werdyktu bariery.
 *
 * Właściciel zobowiązania operacyjnego: Platform Ops (retencja tabel
 * technicznych backendu), tak jak dla pozostałych tabel-ledgerów `api`.
 *
 * NOŚNIK tego zobowiązania to `jobs/vendor-replay-guard-purge.ts` — sam
 * komentarz nim NIE JEST. Bez odpalanego joba tabela w gorącej ścieżce
 * uwierzytelnienia rośnie o `86400 × R` wierszy dziennie i nigdy nie maleje.
 *
 * @throws SystemMarketContextError gdy wywołanie leci poza kontekstem rynku —
 *         PRZED jakąkolwiek wysyłką do bazy (zero wysyłek jest mierzalne).
 * @returns liczba skasowanych wierszy (do zalogowania przez job), albo `null`
 *          gdy sterownik nie podał licznika — brak licznika NIE jest błędem,
 *          bo sprzątanie nie decyduje o poprawności.
 */
export async function purgeExpiredReplayGuardRows(
  db: ReplayGuardDb,
  nowSec: number,
  options?: ReplayGuardPurgeOptions
): Promise<number | null> {
  const { market_id: marketId } = requireMarketContext(
    `${VENDOR_REPLAY_GUARD_TABLE}.purge`,
    { origin: options?.origin, logger: options?.logger }
  )

  const nowIso = new Date(nowSec * 1000).toISOString()
  const { text, bindings } = toKnexPositionalSql(
    `DELETE FROM ${VENDOR_REPLAY_GUARD_TABLE}
      WHERE expires_at <= $1
        AND seller_id IN (
          SELECT seller.id
            FROM seller
           WHERE ${REPLAY_GUARD_SELLER_MARKET_EXPR} = $2
        )`,
    [nowIso, marketId]
  )
  const result = await db.raw(text, bindings)
  return countDeletedRows(result)
}

/** `DELETE` bez `RETURNING` niesie licznik w `rowCount`; Knex bywa oszczędny. */
function countDeletedRows(result: unknown): number | null {
  if (result && typeof result === "object") {
    const rowCount = (result as { rowCount?: unknown }).rowCount
    if (typeof rowCount === "number") {
      return rowCount
    }
  }
  return null
}
