const { MetadataStorage } = require("@medusajs/framework/mikro-orm/core")

/**
 * BRAMKA IZOLACJI BAZY — DWIE WARSTWY, DWA NIEZALEŻNE NOŚNIKI.
 *
 * Historia: suity PG (`*-pg`) oraz `stripe-multi-order` ZAKŁADAJĄ I KASUJĄ
 * tabele (`vendor_replay_guard`, `messaging_dispatch_barrier`,
 * `money_path_compensation_failure`, tabele modułu voucher). Każda niesie
 * w `jest.config.js` zdanie „DATABASE_URL musi wskazywać IZOLOWANĄ DB testową",
 * a do 2026-08-09 było to zdanie i nic więcej. Skutek zmierzony na maszynie PO:
 * przebiegi z domyślnym `DATABASE_URL` skasowały z `gp_mercur` cztery tabele
 * (dwie z nich to nośniki ścieżki pieniędzy) i wyczyściły `entitlement_instance`
 * (15 → 0) oraz `seller` (9 → 2). Rejestr migracji nadal twierdził, że tabele
 * istnieją, więc żadne `db:migrate` ich nie przywracało.
 *
 * ── WARSTWA A (nazwa profilu, `TEST_TYPE`) ────────────────────────────────────
 * Zachowana bez zmian: `-pg` / `stripe-multi-order` + `DATABASE_URL` = twarde
 * sprawdzenie nazwy bazy PRZED jakimkolwiek połączeniem. Broni suit, które
 * deklarują w profilu, że kasują tabele.
 *
 * ── DLACZEGO WARSTWA A NIE WYSTARCZA (incydent 2026-08-10) ───────────────────
 * Poprzednia wersja tego komentarza twierdziła: „sufiks `-pg` niosą dziś
 * WSZYSTKIE siedem suit kasujących tabele". TO BYŁO NIEPRAWDĄ i kosztowało
 * drugi incydent. Pod profilem `TEST_TYPE=unit` biegły suity, które łączyły się
 * z realnym Postgresem i wykonywały `DROP SCHEMA` / `DROP TABLE`
 * (`packages/api/src/__tests__/modules/gp-core.unit.spec.ts` i `…gp-core-events…`).
 * Brały adres z `process.env.DATABASE_URL || "postgres://…/gp_mercur"`. Pomiar
 * 2026-08-10: w zwykłym `pnpm test:unit` `DATABASE_URL` JEST ustawione i wskazuje
 * bazę roboczą `gp_mercur` (plik `.env.test` istnieje, ale jest PUSTY, więc
 * `loadEnv("test")` nie przesłania niczego) — a gdyby było puste, wchodziłby
 * hardkodowany fallback na ten sam serwer. Obie drogi kończyły się połączeniem
 * z Postgresem dewelopera, na którym suita zakładała bazę przez `CREATE DATABASE`
 * i wykonywała `DROP`. Nazwa profilu nie jest więc nośnikiem faktu „ta suita
 * sięga po bazę"; nośnikiem jest DOPIERO REALNE POŁĄCZENIE.
 *
 * Ta sama klasa, zmierzona przy okazji: `scripts/__tests__/`
 * `content-bar-metric-truth-parity.unit.spec.ts` miała fallback
 * `GP_CONTENT_PARITY_DATABASE_URL || DATABASE_URL` i przy KAŻDYM `pnpm test:unit`
 * czytała z `gp_mercur`. Odczyt był read-only, więc nic nie skasował — ale nośnik
 * był ten sam. Naprawiony razem z tą bramką.
 *
 * ── WARSTWA B (realne połączenie, niezależna od `TEST_TYPE`) ─────────────────
 * Warstwa startowa odmawia bez wartości, z nieparsowalnym adresem i z rozpoznaną
 * bazą deweloperską. Warstwa B pozostaje potrzebna dla każdego dalszego połączenia
 * i instaluje kontrolę w
 * `Client.prototype.connect` sterownika `pg`. To jedyne miejsce, przez które
 * przechodzi KAŻDE połączenie: `new Client(...)`, `new Pool(...)` (pula tworzy
 * klientów) oraz `knex({ client: "pg" })` (dialekt pg używa tego samego
 * sterownika). Warunek jest sprawdzany dokładnie wtedy, gdy coś REALNIE sięga
 * po połączenie — bezbazowa suita nigdy go nie dotyka.
 *
 * Reguła warstwy B: baza docelowa musi WYGLĄDAĆ NA TESTOWĄ (człon `test`
 * w nazwie), być bazą utrzymaniową (`postgres` — bez niej nie da się założyć
 * izolowanej bazy testowej) albo mieć wąski, rozpoznawalny wzorzec bazy
 * jednorazowej Medusy. Zmienna środowiskowa może potwierdzić wyłącznie nazwę,
 * która sama niesie oddzielny człon `test`; nie może otworzyć dowolnej bazy.
 * Wszystko inne (w tym `gp_mercur`, `gp_core`, `gp_portal`) jest odmową Z NAZWANĄ BAZĄ.
 *
 * Obie warstwy są TWARDE (rzucają), bo cichy przebieg na złej bazie kasuje dane
 * bez śladu, a jedyny ślad w logu — zielona suita — wygląda identycznie jak
 * przebieg poprawny.
 */
const TEST_TYPE = process.env.TEST_TYPE ?? ""
const requiresIsolatedDb = /-pg$/.test(TEST_TYPE) || TEST_TYPE === "stripe-multi-order"
const DEVELOPMENT_DATABASES = new Set(["gp_mercur", "gp_core", "gp_portal"])
const MAINTENANCE_DATABASES = new Set(["postgres", "template1"])
const TEST_DATABASE_NAME_TOKEN = /(^|[_.-])test([_.-]|$)/i

/** Jawne wyjątki zachowują wyłącznie nazwy, które same deklarują cel testowy. */
function extraAllowedDatabaseNames() {
	return (process.env.GP_TEST_DATABASE_NAMES ?? "")
		.split(",")
		.map((entry) => entry.trim())
		.filter((entry) => TEST_DATABASE_NAME_TOKEN.test(entry))
}

/**
 * Czy nazwa bazy deklaruje, że baza jest do skasowania?
 *
 * Człon `test` musi być ODDZIELNYM członem nazwy (`gp_core_test`, `test`,
 * `test-db`), a nie podciągiem — inaczej `contest_prod` przechodziłby bramkę.
 */
function looksLikeTestDatabase(dbName) {
	return (
		TEST_DATABASE_NAME_TOKEN.test(dbName) ||
		EPHEMERAL_MEDUSA_DB.test(dbName)
	)
}

/**
 * Baza jednorazowa `@medusajs/test-utils`. `medusaIntegrationTestRunner` /
 * `moduleIntegrationTestRunner` budują nazwę jako
 * `medusa-<modul>-integration-<JEST_WORKER_ID>` (patrz `medusa-test-runner.js`),
 * zakładają ją i kasują w obrębie przebiegu. Nazwa nie niesie członu `test`,
 * więc bez tego wyjątku warstwa B zablokowałaby `test:integration:http`
 * i `test:integration:modules` — czyli bramka zabijałaby izolację zamiast jej
 * bronić. Wzorzec jest WĄSKI i przypięty do generatora nazw z test-utils.
 */
const EPHEMERAL_MEDUSA_DB = /^medusa-[a-z0-9._-]*integration-\d+$/i

/**
 * Profile, ktore w ogole nie siegaja po Postgresa. Dla nich brak DATABASE_URL
 * nie jest bledem konfiguracji, tylko normalnym stanem — a twarde zadanie
 * adresu bazy przy starcie kasowalo cala suite jednostkowa, ktora zadnego
 * polaczenia nie otwiera. WARSTWA B zostaje uzbrojona tak czy inaczej, wiec
 * proba polaczenia nadal jest blokowana przy `Client.connect`, czyli w
 * momencie, w ktorym fakt siegania po baze jest realny, a nie deklarowany.
 */
const DATABASE_FREE_TEST_TYPES = new Set(["unit", "patches"])
const hasDatabaseUrl =
	typeof process.env.DATABASE_URL === "string" && process.env.DATABASE_URL.trim() !== ""
const skipDatabaseTargetResolution =
	!hasDatabaseUrl && !requiresIsolatedDb && DATABASE_FREE_TEST_TYPES.has(TEST_TYPE)

function resolveDatabaseTarget() {
	const rawDatabaseUrl = process.env.DATABASE_URL
	if (typeof rawDatabaseUrl !== "string" || rawDatabaseUrl.trim() === "") {
		throw new Error(
			"[test-db-guard] DATABASE_URL jest wymagany; suita nie uruchomi sie bez rozwiazanego celu bazy."
		)
	}

	let databaseUrl
	let dbName
	try {
		databaseUrl = new URL(rawDatabaseUrl)
		dbName = decodeURIComponent(databaseUrl.pathname).replace(/^\//, "")
	} catch {
		throw new Error(
			"[test-db-guard] DATABASE_URL ma niepoprawny format; suita odmawia startu bez bezpiecznego celu bazy."
		)
	}

	if (databaseUrl.protocol !== "postgres:" && databaseUrl.protocol !== "postgresql:") {
		throw new Error(
			"[test-db-guard] DATABASE_URL musi uzywac schematu postgres albo postgresql; suita odmawia startu bez bezpiecznego celu bazy."
		)
	}

	if (!dbName) {
		throw new Error(
			"[test-db-guard] DATABASE_URL musi zawierac nazwe bazy; suita odmawia startu bez bezpiecznego celu."
		)
	}

	return { databaseUrl, dbName }
}

const resolvedDatabaseTarget = skipDatabaseTargetResolution ? null : resolveDatabaseTarget()

if (resolvedDatabaseTarget !== null) {
	if (DEVELOPMENT_DATABASES.has(resolvedDatabaseTarget.dbName)) {
		throw new Error(
			`[test-db-guard] Odmowa startu: rozwiazany DATABASE_URL wskazuje deweloperska baze '${resolvedDatabaseTarget.dbName}'. Ustaw izolowana baze testowa.`
		)
	}

	process.env.DB_HOST ||= resolvedDatabaseTarget.databaseUrl.hostname
	process.env.DB_PORT ||= resolvedDatabaseTarget.databaseUrl.port
	process.env.DB_USERNAME ||= decodeURIComponent(resolvedDatabaseTarget.databaseUrl.username)
	process.env.DB_PASSWORD ||= decodeURIComponent(resolvedDatabaseTarget.databaseUrl.password)
}

// ── WARSTWA A ────────────────────────────────────────────────────────────────
if (requiresIsolatedDb && resolvedDatabaseTarget !== null) {
	const isTestDb =
		/_test$/.test(resolvedDatabaseTarget.dbName) ||
		extraAllowedDatabaseNames().includes(resolvedDatabaseTarget.dbName)

	if (!isTestDb) {
		throw new Error(
			`[test-db-guard] TEST_TYPE=${TEST_TYPE} ZAKLADA I KASUJE tabele, a DATABASE_URL wskazuje baze ` +
				`'${resolvedDatabaseTarget.dbName}', ktora nie wyglada na testowa (oczekiwany sufiks '_test').\n` +
				`Uruchomienie na tej bazie skasowaloby z niej tabele i dane — 2026-08-09 dokladnie tak ` +
				`zniknely 4 tabele i zawartosc 'entitlement_instance' oraz 'seller' z bazy deweloperskiej.\n` +
				`Wskaz izolowana baze: DATABASE_URL=postgres://.../<nazwa>_test`
		)
	}
}

// ── WARSTWA B ────────────────────────────────────────────────────────────────
function assertConnectionTargetIsIsolated(dbName, host) {
	// Zakaz baz deweloperskich pozostaje jawny, a allowlista może potwierdzić
	// wyłącznie nazwę z oddzielnym członem `test`. W przeciwnym razie nazwa
	// produkcyjna w środowisku otwierałaby połączenie mimo bezpiecznego startu suity.
	if (DEVELOPMENT_DATABASES.has(dbName)) {
		throw new Error(
			`[test-db-guard] SUITA TESTOWA PROBUJE SIE POLACZYC Z DEWELOPERSKA BAZA '${dbName}' (host: ${host || "?"}). Odmowa przed polaczeniem.`
		)
	}

	if (!dbName || MAINTENANCE_DATABASES.has(dbName) || looksLikeTestDatabase(dbName)) {
		return
	}

	throw new Error(
		`[test-db-guard] SUITA TESTOWA PROBUJE SIE POLACZYC Z BAZA '${dbName}' (host: ${host || "?"}), ` +
			`ktora nie wyglada na testowa.\n` +
			`Bramka nie patrzy juz na TEST_TYPE (=${TEST_TYPE || "<pusty>"}) — nazwa profilu NIE jest nosnikiem ` +
			`faktu, ze suita siega po baze. 2026-08-09 i 2026-08-10 dwa razy skonczylo sie to skasowaniem ` +
			`danych z bazy deweloperskiej przez suity biegnace pod profilem, ktory tego nie deklarowal.\n` +
			`Testy dotykajace Postgresa maja brac adres z DEDYKOWANEJ zmiennej (wzorzec: ` +
			`GP_CORE_RLS_TEST_DATABASE_URL) i POMIJAC sie, gdy jej nie ma — nigdy z fallbacku na DATABASE_URL.\n` +
			`Wskaz izolowana baze z czlonem 'test' w nazwie albo jawnie potwierdz taka nazwe w GP_TEST_DATABASE_NAMES.`
	)
}

/**
 * Punkt przechwycenia: `Client.prototype.connect`. Świadomie NIE opakowujemy
 * konstruktorów `Pool`/`Client` — test może zbudować pulę i nigdy jej nie użyć
 * (wtedy nie ma czego bronić), a `Pool` i tak schodzi do `Client.connect`.
 * Dzięki temu jeden hak pokrywa `pg.Client`, `pg.Pool` i `knex({client:"pg"})`.
 */
try {
	// eslint-disable-next-line @typescript-eslint/no-var-requires
	const pg = require("pg")
	if (pg && pg.Client && pg.Client.prototype && !pg.Client.prototype.__gpTestDbGuard) {
		const originalConnect = pg.Client.prototype.connect
		function guardedConnect(...args) {
			const params = this.connectionParameters || {}
			assertConnectionTargetIsIsolated(params.database, params.host)
			return originalConnect.apply(this, args)
		}
		guardedConnect.__gpTestDbGuard = true
		pg.Client.prototype.connect = guardedConnect
		pg.Client.prototype.__gpTestDbGuard = true
	}
} catch (error) {
	// Brak sterownika `pg` w tym workspace = nie ma czego przechwytywać. To NIE
	// jest ciche pominięcie bramki: bez `pg` żadne połączenie i tak nie powstanie.
	if (!error || error.code !== "MODULE_NOT_FOUND") {
		throw error
	}
}

MetadataStorage.clear()
