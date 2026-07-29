/**
 * `gp-config-backfill-seller-columns` — ścieżka naprawcza dla sellerów, którym
 * seed trafił do lustra zamiast do kolumny encji (review cykl 4, W0).
 *
 * Kontrakt, którego pilnują te testy:
 *   - przepisujemy rejestr → kolumna WYŁĄCZNIE gdy pole jest w `seeded_fields`,
 *     kolumna jest pusta, a rejestr ma treść;
 *   - niepusta kolumna jest NIETYKALNA (może być treścią vendora);
 *   - bez `--apply` skrypt niczego nie zapisuje;
 *   - drugi przebieg jest no-opem (idempotencja).
 *
 * Ta ścieżka NIE była uruchamiana na bazie dev — story 5.2/5.3 robią na niej
 * realny checkout. Skrypt jest zaimplementowany i przetestowany; uruchomienie
 * należy do orkiestratora.
 */

import path from 'node:path'

import gpConfigBackfillSellerColumns, {
  BACKFILL_APPLY_ENV,
  BACKFILL_APPLY_POSITIONAL,
  planSellerColumnBackfill,
} from '../../scripts/gp-config-backfill-seller-columns'

const SEEDED_DESCRIPTION = 'Opis zasiany przez gp-config (402 znaki w realnej bazie)'
const VENDOR_DESCRIPTION = 'Opis napisany przez sprzedawczynię'

function emptyCounters() {
  return { column_not_empty: 0, not_seeded: 0, registry_empty: 0 }
}

function seller(overrides: Record<string, unknown> = {}, gp: Record<string, unknown> = {}) {
  return {
    id: 'seller-studio-nova',
    handle: 'studio-nova',
    name: 'Studio Nova',
    description: null,
    logo: null,
    ...overrides,
    metadata: { gp: { market_id: 'bonbeauty', seeded_fields: [], ...gp } },
  }
}

describe('planSellerColumnBackfill — kontrakt własności', () => {
  it('przepisuje rejestr do pustej kolumny dla pola w seeded_fields', () => {
    const plan = planSellerColumnBackfill(
      seller({}, { seeded_fields: ['description'], description: SEEDED_DESCRIPTION }),
      emptyCounters()
    )

    expect(plan).toEqual({
      seller_id: 'seller-studio-nova',
      handle: 'studio-nova',
      columns: { description: SEEDED_DESCRIPTION },
    })
  })

  it('NIE dotyka kolumny, która ma już treść (może być vendora)', () => {
    const counters = emptyCounters()
    const plan = planSellerColumnBackfill(
      seller(
        { description: VENDOR_DESCRIPTION },
        { seeded_fields: ['description'], description: SEEDED_DESCRIPTION }
      ),
      counters
    )

    expect(plan).toBeNull()
    expect(counters.column_not_empty).toBe(1)
  })

  it('NIE rusza pola spoza seeded_fields — nigdy go nie zasialiśmy', () => {
    const counters = emptyCounters()
    const plan = planSellerColumnBackfill(
      seller({}, { seeded_fields: [], description: SEEDED_DESCRIPTION }),
      counters
    )

    expect(plan).toBeNull()
    expect(counters.not_seeded).toBeGreaterThan(0)
  })

  it('pomija pole, gdy rejestr jest pusty — nie ma czego przepisać', () => {
    const counters = emptyCounters()
    const plan = planSellerColumnBackfill(seller({}, { seeded_fields: ['description'] }), counters)

    expect(plan).toBeNull()
    expect(counters.registry_empty).toBe(1)
  })

  it('obsługuje wszystkie trzy pola z własną kolumną (name/description/logo)', () => {
    const plan = planSellerColumnBackfill(
      seller(
        { name: null, description: null, logo: null },
        {
          seeded_fields: ['name', 'description', 'photo_url'],
          name: 'Studio Nova',
          description: SEEDED_DESCRIPTION,
          photo_url: 'https://cdn.example/logo.png',
        }
      ),
      emptyCounters()
    )

    expect(plan?.columns).toEqual({
      name: 'Studio Nova',
      description: SEEDED_DESCRIPTION,
      logo: 'https://cdn.example/logo.png',
    })
  })
})

describe('gpConfigBackfillSellerColumns — entrypoint', () => {
  let logSpy: jest.SpyInstance

  beforeEach(() => {
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined)
  })

  afterEach(() => {
    logSpy.mockRestore()
    process.exitCode = undefined
    delete process.env[BACKFILL_APPLY_ENV]
  })

  function makeService(sellers: any[]) {
    return {
      list: jest.fn().mockResolvedValue(sellers),
      update: jest.fn().mockImplementation(async (id: string, payload: any) => ({ id, ...payload })),
    }
  }

  function makeContainer(service: any) {
    return { resolve: (key: string) => (key === 'seller' ? service : undefined) }
  }

  const needsBackfill = () =>
    seller({}, { seeded_fields: ['description'], description: SEEDED_DESCRIPTION })

  it('bez --apply NICZEGO nie zapisuje, ale raportuje plan', async () => {
    const service = makeService([needsBackfill()])

    const summary = await gpConfigBackfillSellerColumns({
      container: makeContainer(service),
      args: ['bonbeauty'],
    } as any)

    expect(service.update).not.toHaveBeenCalled()
    expect(summary.planned).toBe(1)
    expect(summary.applied).toBe(0)
    expect(summary.plans[0].columns).toEqual({ description: SEEDED_DESCRIPTION })
  })

  it('z obiema połówkami kanału zapisuje kolumnę', async () => {
    process.env[BACKFILL_APPLY_ENV] = 'true'
    const service = makeService([needsBackfill()])

    const summary = await gpConfigBackfillSellerColumns({
      container: makeContainer(service),
      args: ['bonbeauty', BACKFILL_APPLY_POSITIONAL],
    } as any)

    expect(service.update).toHaveBeenCalledWith('seller-studio-nova', {
      description: SEEDED_DESCRIPTION,
    })
    expect(summary.applied).toBe(1)
  })

  it('jest idempotentny — drugi przebieg nie ma nic do zrobienia', async () => {
    process.env[BACKFILL_APPLY_ENV] = 'true'
    const repaired = seller(
      { description: SEEDED_DESCRIPTION },
      { seeded_fields: ['description'], description: SEEDED_DESCRIPTION }
    )
    const service = makeService([repaired])

    const summary = await gpConfigBackfillSellerColumns({
      container: makeContainer(service),
      args: ['bonbeauty', BACKFILL_APPLY_POSITIONAL],
    } as any)

    expect(service.update).not.toHaveBeenCalled()
    expect(summary.planned).toBe(0)
  })

  it('filtruje po markecie — nie dotyka sellerów innego marketu', async () => {
    process.env[BACKFILL_APPLY_ENV] = 'true'
    const other = seller(
      {},
      { market_id: 'mercur', seeded_fields: ['description'], description: SEEDED_DESCRIPTION }
    )
    const service = makeService([other])

    const summary = await gpConfigBackfillSellerColumns({
      container: makeContainer(service),
      args: ['bonbeauty', BACKFILL_APPLY_POSITIONAL],
    } as any)

    expect(summary.scanned).toBe(0)
    expect(service.update).not.toHaveBeenCalled()
  })

  // Cykl 7 R8 — `medusa exec` odrzuca `--apply` (yargs strict: „Unknown
  // argument: apply"), więc argv NIE JEST osiągalnym kanałem operatorskim.
  // Jedyny kanał, którym operator może realnie włączyć zapis, to zmienna
  // środowiskowa — i to jego testujemy na tym samym entrypoincie, który
  // uruchamia `medusa exec`, a nie na atrapie decyzji.
  describe(`kanał zapisu ${BACKFILL_APPLY_ENV} (cykl 7 R8)`, () => {
    it('bez kanału (argv jak z `medusa exec`) — ZERO zapisów, sam plan', async () => {
      const service = makeService([needsBackfill()])

      const summary = await gpConfigBackfillSellerColumns({
        container: makeContainer(service),
        args: ['bonbeauty'],
      } as any)

      expect(service.update).not.toHaveBeenCalled()
      expect(summary.apply).toBe(false)
      expect(summary.applied).toBe(0)
      expect(summary.planned).toBe(1)
    })

    it('samo odziedziczone GP_BACKFILL_APPLY=true zostaje planem i jest głośno ignorowane', async () => {
      process.env[BACKFILL_APPLY_ENV] = 'true'
      const service = makeService([needsBackfill()])

      const summary = await gpConfigBackfillSellerColumns({
        container: makeContainer(service),
        args: ['bonbeauty'],
      } as any)

      expect(service.update).not.toHaveBeenCalled()
      expect(summary.apply).toBe(false)
      expect(summary.applied).toBe(0)
      expect(summary.warnings[0]).toContain('ZIGNOROWANE')
    })

    it('token + GP_BACKFILL_APPLY=true razem włączają zapis', async () => {
      process.env[BACKFILL_APPLY_ENV] = 'true'
      const service = makeService([needsBackfill()])

      const summary = await gpConfigBackfillSellerColumns({
        container: makeContainer(service),
        args: ['bonbeauty', BACKFILL_APPLY_POSITIONAL],
      } as any)

      expect(service.update).toHaveBeenCalledWith('seller-studio-nova', {
        description: SEEDED_DESCRIPTION,
      })
      expect(summary.apply).toBe(true)
    })

    it('wartość inna niż prawdziwościowa NIE włącza zapisu (bezpieczna domyślność)', async () => {
      process.env[BACKFILL_APPLY_ENV] = 'false'
      const service = makeService([needsBackfill()])

      const summary = await gpConfigBackfillSellerColumns({
        container: makeContainer(service),
        args: ['bonbeauty'],
      } as any)

      expect(service.update).not.toHaveBeenCalled()
      expect(summary.apply).toBe(false)
    })

    it('skrypt ma wpis w package.json — inaczej nie ma jak go uruchomić', () => {
      // Pozostałe `gp-config-sync-*` mają swój wpis; ten go nie miał, więc
      // jedyną drogą było ręczne `npx medusa exec` z pełną ścieżką.
      const pkg = require(path.resolve(__dirname, '../../../../..', 'package.json'))
      expect(pkg.scripts['gp-config-backfill-seller-columns']).toBe(
        'medusa exec ./packages/api/src/scripts/gp-config-backfill-seller-columns.ts'
      )
    })

    it('podpowiedź w planie wskazuje kanał, który realnie działa', async () => {
      const service = makeService([needsBackfill()])

      await gpConfigBackfillSellerColumns({
        container: makeContainer(service),
        args: ['bonbeauty'],
      } as any)

      const printed = logSpy.mock.calls.map((call) => String(call[0])).join('\n')
      expect(printed).toContain(`${BACKFILL_APPLY_ENV}=true`)
      expect(printed).toContain(BACKFILL_APPLY_POSITIONAL)
      expect(printed).not.toContain('Re-run with --apply')
    })
  })

  it('błąd zapisu jest głośny: warning + niezerowy kod wyjścia', async () => {
    process.env[BACKFILL_APPLY_ENV] = 'true'
    const service = makeService([needsBackfill()])
    service.update.mockRejectedValue(new Error('db down'))

    const summary = await gpConfigBackfillSellerColumns({
      container: makeContainer(service),
      args: ['bonbeauty', BACKFILL_APPLY_POSITIONAL],
    } as any)

    expect(summary.ok).toBe(false)
    expect(summary.warnings[0]).toContain('db down')
    expect(process.exitCode).toBe(1)
  })
})
