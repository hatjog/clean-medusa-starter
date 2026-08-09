const { MetadataStorage } = require("@medusajs/framework/mikro-orm/core")

if (process.env.DATABASE_URL) {
	const databaseUrl = new URL(process.env.DATABASE_URL)

	process.env.DB_HOST ||= databaseUrl.hostname
	process.env.DB_PORT ||= databaseUrl.port
	process.env.DB_USERNAME ||= decodeURIComponent(databaseUrl.username)
	process.env.DB_PASSWORD ||= decodeURIComponent(databaseUrl.password)
}

/**
 * BRAMKA IZOLACJI BAZY — reguła przestaje być komentarzem.
 *
 * Siedem suit PG (`*-pg`) oraz `stripe-multi-order` ZAKŁADAJĄ I KASUJĄ tabele:
 * `vendor_replay_guard`, `messaging_dispatch_barrier`,
 * `money_path_compensation_failure`, tabele modułu voucher. Każda z nich niesie
 * w `jest.config.js` zdanie „DATABASE_URL musi wskazywać IZOLOWANĄ DB testową".
 *
 * Do 2026-08-09 było to zdanie i nic więcej — żaden kod tego nie sprawdzał.
 * Skutek zmierzony na maszynie PO: przebiegi odpalone z domyślnym
 * `DATABASE_URL` skasowały z `gp_mercur` cztery tabele (dwie z nich to nośniki
 * ścieżki pieniędzy: rejestr alarmów kompensacji i bariera dostawy), a przy
 * okazji wyczyściły `entitlement_instance` (15 → 0) i `seller` (9 → 2).
 * Rejestr migracji nadal twierdził, że tabele istnieją, więc żadne
 * `db:migrate` ich nie przywracało — odtwarzanie szło ręcznie, cztery razy.
 *
 * DLACZEGO KONWENCJA `-pg`, A NIE LISTA: przepisana lista typów byłaby DRUGĄ
 * KOPIĄ zakresu obok `jest.config.js` i rozjechałaby się przy pierwszej nowej
 * suicie. Sufiks `-pg` niosą dziś WSZYSTKIE siedem suit kasujących tabele,
 * więc nowa suita PG jest objęta bramką automatycznie, bez edycji tego pliku.
 * `stripe-multi-order` jest jedynym wyjątkiem spoza konwencji (gate ADR-166).
 *
 * Bramka jest TWARDA (rzuca przed jakimkolwiek połączeniem), bo cichy przebieg
 * na złej bazie kasuje dane bez śladu. Jedyne przejście to JAWNY opt-out.
 */
const TEST_TYPE = process.env.TEST_TYPE ?? ""
const requiresIsolatedDb = /-pg$/.test(TEST_TYPE) || TEST_TYPE === "stripe-multi-order"

if (requiresIsolatedDb && process.env.DATABASE_URL) {
	if (process.env.GP_ALLOW_NON_TEST_DB === "1") {
		// Pominięcie ZADEKLAROWANE jest dopuszczalne; ciche nie jest.
		console.warn(
			`[test-db-guard] GP_ALLOW_NON_TEST_DB=1 — bramka izolacji bazy POMINIĘTA dla TEST_TYPE=${TEST_TYPE}`
		)
	} else {
		const dbName = decodeURIComponent(new URL(process.env.DATABASE_URL).pathname).replace(/^\//, "")
		// Nazwa bazy jest jedynym nośnikiem, jaki mamy przed połączeniem.
		// Dodatkowe nazwy (np. baza szablonowa CI) idą przez zmienną, żeby nie
		// trzeba było ruszać tego pliku.
		const extraAllowed = (process.env.GP_TEST_DATABASE_NAMES ?? "")
			.split(",")
			.map((entry) => entry.trim())
			.filter(Boolean)
		const isTestDb = /_test$/.test(dbName) || extraAllowed.includes(dbName)

		if (!isTestDb) {
			throw new Error(
				`[test-db-guard] TEST_TYPE=${TEST_TYPE} ZAKLADA I KASUJE tabele, a DATABASE_URL wskazuje baze ` +
					`'${dbName}', ktora nie wyglada na testowa (oczekiwany sufiks '_test' albo wpis ` +
					`w GP_TEST_DATABASE_NAMES).\n` +
					`Uruchomienie na tej bazie skasowaloby z niej tabele i dane — 2026-08-09 dokladnie tak ` +
					`zniknely 4 tabele i zawartosc 'entitlement_instance' oraz 'seller' z bazy deweloperskiej.\n` +
					`Wskaz izolowana baze: DATABASE_URL=postgres://.../<nazwa>_test\n` +
					`Swiadome pominiecie (wiesz, ze ta baza jest do skasowania): GP_ALLOW_NON_TEST_DB=1`
			)
		}
	}
}

MetadataStorage.clear()
