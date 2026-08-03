/**
 * ADR-165 — model własności treści sellera po doprecyzowaniu PO (2026-07-28).
 *
 * Story 4.6, review-fix cykl 4. Doprecyzowanie PO (Robert): *„musi być możliwość
 * wprowadzenia zmian przy pomocy gp-cli, ale potem powinna być możliwość
 * aktualizacji tych danych przy pomocy admin, storefront powinien czytać dane
 * z bazy"*.
 *
 * Trzy reguły egzekwowane przez ten plik:
 *   1. KOLUMNA encji (`seller.name/description/logo`) jest wartością kanoniczną —
 *      to ją czyta API, to ją edytuje admin, i to do niej pisze seed.
 *   2. gp-cli seeduje DO KOLUMNY, nie obok niej.
 *   3. `metadata.gp.<pole>` + `seeded_fields` to REJESTR POCHODZENIA — służy
 *      wyłącznie rozstrzygnięciu własności, nigdy odczytowi treści.
 *
 * Wykrywanie własności sprowadza się wtedy do:
 *   kolumna === rejestr            ⇒ vendor nie tknął ⇒ gp-cli może odświeżyć
 *   kolumna !== rejestr            ⇒ vendor edytował  ⇒ NIGDY nie nadpisuj
 *   kolumna niepusta, brak w rejestrze ⇒ treść vendora od początku ⇒ nie nadpisuj
 *   kolumna pusta                  ⇒ nie ma czego chronić ⇒ seeduj (także backfill)
 *
 * RED-FIRST (cykl 4): przed fixem wołający podawał `dbValue = metadata.gp.<pole>
 * ?? kolumna`, czyli porównywał LUSTRO zamiast prawdy. Skutkiem były dwa defekty
 * ćwiczone niżej wprost:
 *   - W0 — seed nigdy nie trafiał do kolumny `description` (`createPayload` jej
 *     nie zawierał), więc `GET /store/seller/:handle` zwracał `null`;
 *   - W1 — logo wgrane przez vendora DO KOLUMNY było kasowane przez zwykłe
 *     `--overwrite`, bo `deepEqual(lustro, config)` wychodziło prawdziwe
 *     i bramka własności w ogóle się nie odzywała.
 *
 * Bez realnego DB — in-memory mock sellerService (wzorzec z
 * sync-vendors-ownership.test.ts / gp-config-sync-vendors.idempotency.spec.ts).
 */

import * as fs from 'fs/promises'
import * as os from 'os'
import * as path from 'path'

import gpConfigSyncVendors, { upsertSeller } from '../../scripts/gp-config-sync-vendors'

const CONFIG_DESCRIPTION = 'Opis z gp-config (seed)'
const VENDOR_DESCRIPTION = 'Opis napisany przez sprzedawczynię'
const CONFIG_LOGO = 'https://cdn.example/gp-config/studio-nova.png'
const VENDOR_LOGO = 'https://cdn.example/vendor-upload/studio-nova.png'

function makeSellerService(existingSellers: any[] = []) {
  return {
    list: jest.fn().mockResolvedValue(existingSellers),
    update: jest.fn().mockImplementation(async (id: string, payload: any) => ({ id, ...payload })),
    create: jest
      .fn()
      .mockImplementation(async (payload: any) => ({ id: 'seller-new-001', ...payload })),
  }
}

function baseVendor(overrides: Record<string, unknown> = {}) {
  return {
    vendor_id: 'studio-nova',
    slug: 'studio-nova',
    status: 'onboarded',
    description: CONFIG_DESCRIPTION,
    ...overrides,
  }
}

/**
 * Istniejący seller z ROZDZIELONYMI rolami: `column` to wartość kanoniczna
 * (to, co widzi storefront), `registry` to `metadata.gp.<pole>` (zapis, co
 * zasialiśmy). Rozdzielenie jest sednem tego cyklu — dopóki test podawał jedną
 * wartość w obu miejscach, defekt W1 był niewidoczny.
 */
function existingSellerWith(opts: {
  seededFields?: string[]
  column?: string | null
  registry?: string | null
  logoColumn?: string | null
  logoRegistry?: string | null
}) {
  const gp: Record<string, unknown> = {
    market_id: 'bonbeauty',
    seeded_fields: opts.seededFields ?? [],
  }
  if (opts.registry !== undefined && opts.registry !== null) gp.description = opts.registry
  if (opts.logoRegistry !== undefined && opts.logoRegistry !== null) {
    gp.photo_url = opts.logoRegistry
  }

  return {
    id: 'seller-studio-nova',
    handle: 'studio-nova',
    name: 'Studio Nova',
    description: opts.column ?? null,
    logo: opts.logoColumn ?? null,
    metadata: { gp },
  }
}

/** Payload zapisu — czyli KOLUMNY encji. To on rozstrzyga, co zobaczy API. */
function updatedColumns(sellerService: ReturnType<typeof makeSellerService>) {
  return sellerService.update.mock.calls[0][1] as Record<string, unknown>
}

/** Rejestr pochodzenia po zapisie. NIE jest wartością — jest zapisem seeda. */
function updatedGp(sellerService: ReturnType<typeof makeSellerService>) {
  return (updatedColumns(sellerService).metadata as any).gp as Record<string, unknown>
}

// ---- W0: seed MUSI dojechać do kolumny, bo to ją czyta storefront ----

describe('W0 — seed pisze do KOLUMNY encji, nie tylko do lustra', () => {
  it('CREATE zapisuje `description` w kolumnie encji', async () => {
    const sellerService = makeSellerService([])

    await upsertSeller(sellerService, baseVendor(), false, 'bonbeauty')

    const payload = sellerService.create.mock.calls[0][0]
    expect(payload.description).toBe(CONFIG_DESCRIPTION)
    // ...a lustro zostaje rejestrem pochodzenia, nie jedynym miejscem wartości
    expect(payload.metadata.gp.description).toBe(CONFIG_DESCRIPTION)
    expect(payload.metadata.gp.seeded_fields).toContain('description')
  })

  it('UPDATE pustej kolumny zapisuje `description` w kolumnie encji', async () => {
    const sellerService = makeSellerService([
      existingSellerWith({ seededFields: [], column: null }),
    ])

    await upsertSeller(sellerService, baseVendor(), false, 'bonbeauty')

    expect(updatedColumns(sellerService).description).toBe(CONFIG_DESCRIPTION)
  })

  it('BACKFILL: seeded + kolumna pusta + lustro z treścią → uzupełnia kolumnę', async () => {
    // Realny stan 4 sellerów bazy dev sprzed tego fixu. Pusta kolumna nie
    // zawiera niczyjej treści, więc to nie jest nadpisanie pracy vendora.
    const sellerService = makeSellerService([
      existingSellerWith({
        seededFields: ['description'],
        column: null,
        registry: CONFIG_DESCRIPTION,
      }),
    ])

    const result = await upsertSeller(sellerService, baseVendor(), false, 'bonbeauty')

    expect(updatedColumns(sellerService).description).toBe(CONFIG_DESCRIPTION)
    expect(result.ownershipProtectedFields ?? []).toEqual([])
  })
})

// ---- W1: własność rozstrzyga KOLUMNA vs REJESTR, nie rejestr vs config ----

describe('W1 — vendor edytował KOLUMNĘ, lustro zostało stare', () => {
  it('`--overwrite` NIE nadpisuje logo wgranego przez vendora', async () => {
    // RED-FIRST: przed fixem `dbValue = existingGp.photo_url ?? existingSeller.logo`
    // nigdy nie oglądało kolumny, dopóki lustro było niepuste. `deepEqual(lustro,
    // config)` = true ⇒ `vendorOwned = false` ⇒ bramka przepuszczała, a
    // `--overwrite-prune` kasowało wgrane logo bez jednego słowa.
    const sellerService = makeSellerService([
      existingSellerWith({
        seededFields: ['photo_url'],
        logoColumn: VENDOR_LOGO,
        logoRegistry: CONFIG_LOGO,
      }),
    ])

    const result = await upsertSeller(
      sellerService,
      baseVendor({ description: undefined, photo_url: CONFIG_LOGO }),
      false,
      'bonbeauty',
      'pln',
      true
    )

    expect(updatedColumns(sellerService).logo).toBeUndefined()
    expect(result.ownershipProtectedFields).toEqual(['photo_url'])
  })

  it('`--overwrite` NIE nadpisuje nazwy zmienionej przez vendora', async () => {
    const sellerService = makeSellerService([
      {
        ...existingSellerWith({ seededFields: ['name'] }),
        name: 'Studio Nova — Salon Kosmetyczny',
        metadata: {
          gp: { market_id: 'bonbeauty', seeded_fields: ['name'], name: 'Studio Nova' },
        },
      },
    ])

    const result = await upsertSeller(
      sellerService,
      baseVendor({ description: undefined, display_name: 'Studio Nova' }),
      false,
      'bonbeauty',
      'pln',
      true
    )

    expect(updatedColumns(sellerService).name).toBeUndefined()
    expect(result.ownershipProtectedFields).toEqual(['name'])
  })

  it('gdy kolumna == rejestr, `--overwrite` odświeża seed w kolumnie', async () => {
    const sellerService = makeSellerService([
      existingSellerWith({
        seededFields: ['photo_url'],
        logoColumn: CONFIG_LOGO,
        logoRegistry: CONFIG_LOGO,
      }),
    ])

    const nextLogo = 'https://cdn.example/gp-config/studio-nova-v2.png'
    const result = await upsertSeller(
      sellerService,
      baseVendor({ description: undefined, photo_url: nextLogo }),
      false,
      'bonbeauty',
      'pln',
      true
    )

    expect(updatedColumns(sellerService).logo).toBe(nextLogo)
    expect(updatedGp(sellerService).photo_url).toBe(nextLogo)
    expect(result.ownershipProtectedFields ?? []).toEqual([])
  })
})

// ---- Case 1: seeded + kolumna == rejestr → overwrite może pisać ----

describe('ADR-165 Case 1 — pole seeded i NIEtknięte przez vendora', () => {
  it('--overwrite zapisuje wartość z configu (własność nadal po stronie seeda)', async () => {
    const sellerService = makeSellerService([
      existingSellerWith({
        seededFields: ['description'],
        column: 'Stary opis z poprzedniego seeda',
        registry: 'Stary opis z poprzedniego seeda',
      }),
    ])

    const result = await upsertSeller(
      sellerService,
      baseVendor(),
      false,
      'bonbeauty',
      'pln',
      true
    )

    expect(result.action).toBe('updated')
    expect(updatedColumns(sellerService).description).toBe(CONFIG_DESCRIPTION)
    expect(updatedGp(sellerService).description).toBe(CONFIG_DESCRIPTION)
    expect(result.ownershipProtectedFields ?? []).toEqual([])
  })

  it('BEZ --overwrite nie odświeża istniejącego seeda', async () => {
    const sellerService = makeSellerService([
      existingSellerWith({
        seededFields: ['description'],
        column: 'Stary opis z poprzedniego seeda',
        registry: 'Stary opis z poprzedniego seeda',
      }),
    ])

    const result = await upsertSeller(sellerService, baseVendor(), false, 'bonbeauty')

    // „seed if empty" znaczy empty — pełna kolumna nie jest odświeżana bez flagi
    expect(updatedColumns(sellerService).description).toBeUndefined()
    expect(result.ownershipProtectedFields ?? []).toEqual([])
  })
})

// ---- Case 2: seeded + vendor edytował kolumnę → overwrite NIE MOŻE pisać ----

describe('ADR-165 Case 2 — pole seeded, ale vendor je edytował', () => {
  function case2Service() {
    return makeSellerService([
      existingSellerWith({
        seededFields: ['description'],
        column: VENDOR_DESCRIPTION,
        registry: CONFIG_DESCRIPTION,
      }),
    ])
  }

  it('--overwrite NIE nadpisuje treści vendora', async () => {
    const sellerService = case2Service()

    await upsertSeller(sellerService, baseVendor(), false, 'bonbeauty', 'pln', true)

    expect(updatedColumns(sellerService).description).toBeUndefined()
  })

  it('raportuje pominięcie JAWNIE w ownershipProtectedFields i w note', async () => {
    const sellerService = case2Service()

    const result = await upsertSeller(
      sellerService,
      baseVendor(),
      false,
      'bonbeauty',
      'pln',
      true
    )

    expect(result.ownershipProtectedFields).toEqual(['description'])
    expect(result.note).toContain('description')
  })

  it('zachowuje description w seeded_fields (znacznik własności nie znika)', async () => {
    const sellerService = case2Service()

    await upsertSeller(sellerService, baseVendor(), false, 'bonbeauty', 'pln', true)

    expect(updatedGp(sellerService).seeded_fields).toContain('description')
  })
})

// ---- Case 3: nie-seeded + kolumna pusta → overwrite może zasiać ----

describe('ADR-165 Case 3 — pole nie-seeded i puste w kolumnie', () => {
  it('--overwrite zasiewa wartość i dopisuje pole do seeded_fields', async () => {
    const sellerService = makeSellerService([
      existingSellerWith({ seededFields: [], column: null }),
    ])

    const result = await upsertSeller(
      sellerService,
      baseVendor(),
      false,
      'bonbeauty',
      'pln',
      true
    )

    expect(updatedColumns(sellerService).description).toBe(CONFIG_DESCRIPTION)
    expect(updatedGp(sellerService).seeded_fields).toContain('description')
    expect(result.ownershipProtectedFields ?? []).toEqual([])
  })
})

// ---- Case 4: nie-seeded + kolumna niepusta → overwrite NIE MOŻE pisać ----

describe('ADR-165 Case 4 — pole vendor-owned od początku (nigdy nie seedowane)', () => {
  it('--overwrite NIE nadpisuje treści vendora', async () => {
    const sellerService = makeSellerService([
      existingSellerWith({ seededFields: [], column: VENDOR_DESCRIPTION }),
    ])

    await upsertSeller(sellerService, baseVendor(), false, 'bonbeauty', 'pln', true)

    expect(updatedColumns(sellerService).description).toBeUndefined()
  })

  it('raportuje pominięcie i NIE dopisuje pola do seeded_fields', async () => {
    const sellerService = makeSellerService([
      existingSellerWith({ seededFields: [], column: VENDOR_DESCRIPTION }),
    ])

    const result = await upsertSeller(
      sellerService,
      baseVendor(),
      false,
      'bonbeauty',
      'pln',
      true
    )

    expect(result.ownershipProtectedFields).toEqual(['description'])
    expect(updatedGp(sellerService).seeded_fields).not.toContain('description')
  })
})

// ---- Regresja: bez flag zachowanie legacy jest niezmienione ----

describe('ADR-165 — brak flag: zachowanie sprzed fixu bez zmian', () => {
  it('Case 2 bez --overwrite nadal zachowuje treść vendora', async () => {
    const sellerService = makeSellerService([
      existingSellerWith({
        seededFields: ['description'],
        column: VENDOR_DESCRIPTION,
        registry: CONFIG_DESCRIPTION,
      }),
    ])

    const result = await upsertSeller(sellerService, baseVendor(), false, 'bonbeauty')

    expect(updatedColumns(sellerService).description).toBeUndefined()
    // bez --overwrite nie ma czego raportować: nikt nie prosił o nadpisanie
    expect(result.ownershipProtectedFields ?? []).toEqual([])
  })

  it('Case 3 bez --overwrite nadal zasiewa pustą kolumnę', async () => {
    const sellerService = makeSellerService([
      existingSellerWith({ seededFields: [], column: null }),
    ])

    await upsertSeller(sellerService, baseVendor(), false, 'bonbeauty')

    expect(updatedColumns(sellerService).description).toBe(CONFIG_DESCRIPTION)
  })
})

// ---- Macierz 4 Case'ów × `--overwrite` on/off ----
//
// Kontrakt: `--overwrite` MA wpływ na Case 1 (odświeżenie istniejącego seeda)
// i NIE MA wpływu na Case 2, 3 i 4.

describe('ADR-165 — `--overwrite` a decyzja o zapisie (4 Case × flaga)', () => {
  /** Zwraca wartość `description`, którą sync REALNIE zapisał do KOLUMNY. */
  async function writtenColumn(
    opts: Parameters<typeof existingSellerWith>[0],
    overwrite: boolean
  ) {
    const sellerService = makeSellerService([existingSellerWith(opts)])
    await upsertSeller(sellerService, baseVendor(), false, 'bonbeauty', 'pln', overwrite)
    return updatedColumns(sellerService).description
  }

  const CASE_1 = {
    seededFields: ['description'],
    column: 'Stary seed',
    registry: 'Stary seed',
  }
  const CASE_2 = {
    seededFields: ['description'],
    column: VENDOR_DESCRIPTION,
    registry: CONFIG_DESCRIPTION,
  }
  const CASE_3 = { seededFields: [], column: null }
  const CASE_4 = { seededFields: [], column: VENDOR_DESCRIPTION }

  it('Case 1 (seeded, vendor nietknięty): flaga decyduje o odświeżeniu', async () => {
    expect(await writtenColumn(CASE_1, false)).toBeUndefined()
    expect(await writtenColumn(CASE_1, true)).toBe(CONFIG_DESCRIPTION)
  })

  it('Case 2 (seeded, vendor edytował): --overwrite NIE zmienia decyzji', async () => {
    expect(await writtenColumn(CASE_2, false)).toBeUndefined()
    expect(await writtenColumn(CASE_2, true)).toBeUndefined()
  })

  it('Case 3 (nie-seeded, kolumna pusta): zasiewa z flagą i bez niej', async () => {
    expect(await writtenColumn(CASE_3, false)).toBe(CONFIG_DESCRIPTION)
    expect(await writtenColumn(CASE_3, true)).toBe(CONFIG_DESCRIPTION)
  })

  it('Case 4 (nie-seeded, kolumna niepusta): --overwrite NIE zmienia decyzji', async () => {
    expect(await writtenColumn(CASE_4, false)).toBeUndefined()
    expect(await writtenColumn(CASE_4, true)).toBeUndefined()
  })
})

// ---- GP_FORCE_VENDOR_OVERWRITE: osobny, mocniejszy kanał ----

describe('ADR-165 — GP_FORCE_VENDOR_OVERWRITE jako jedyny kanał niszczący', () => {
  it('nadpisuje Case 2 (vendor edytował) sam, bez --overwrite', async () => {
    const sellerService = makeSellerService([
      existingSellerWith({
        seededFields: ['description'],
        column: VENDOR_DESCRIPTION,
        registry: CONFIG_DESCRIPTION,
      }),
    ])

    const result = await upsertSeller(
      sellerService,
      baseVendor(),
      false,
      'bonbeauty',
      'pln',
      false,
      true
    )

    expect(updatedColumns(sellerService).description).toBe(CONFIG_DESCRIPTION)
    expect(result.ownershipProtectedFields ?? []).toEqual([])
  })

  it('nadpisuje Case 4 (vendor-owned od początku) i przejmuje pole na seed', async () => {
    const sellerService = makeSellerService([
      existingSellerWith({ seededFields: [], column: VENDOR_DESCRIPTION }),
    ])

    await upsertSeller(sellerService, baseVendor(), false, 'bonbeauty', 'pln', false, true)

    expect(updatedColumns(sellerService).description).toBe(CONFIG_DESCRIPTION)
    expect(updatedGp(sellerService).seeded_fields).toContain('description')
  })
})

// ---- Realna ścieżka: entrypoint skryptu, realny YAML, realne parsowanie flag ----

/** Chainable knex-like mock: każde zapytanie kończy się pustym wynikiem. */
function makeDbMock() {
  const builder: any = new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === 'first') return async () => undefined
        if (prop === 'then') return undefined
        return () => builder
      },
    }
  )
  const db: any = () => builder
  return db
}

function makeContainer(sellerService: ReturnType<typeof makeSellerService>) {
  return {
    resolve: (key: string) => {
      if (key === 'seller') return sellerService
      if (key === 'product') return { list: async () => [], listProducts: async () => [] }
      if (key === 'sellerProductLink') return { create: async () => ({}) }
      return makeDbMock()
    },
  }
}

describe('ADR-165 — realna ścieżka: gpConfigSyncVendors z GP_OVERWRITE=true', () => {
  const envBackup = { ...process.env }
  let tmpRoot: string
  let logSpy: jest.SpyInstance

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'gp-adr165-'))
    const marketDir = path.join(tmpRoot, 'gp-dev', 'markets', 'bonbeauty')
    await fs.mkdir(path.join(marketDir, 'vendors', 'studio-nova'), { recursive: true })
    await fs.writeFile(
      path.join(marketDir, 'market.yaml'),
      [
        'market_id: bonbeauty',
        'currency: PLN',
        'vendors:',
        '  - vendor_id: studio-nova',
        '    slug: studio-nova',
        '    status: onboarded',
        `    description: "${CONFIG_DESCRIPTION}"`,
      ].join('\n'),
      'utf8'
    )
    await fs.writeFile(
      path.join(marketDir, 'vendors', 'studio-nova', 'products.yaml'),
      'products: []\n',
      'utf8'
    )
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined)
  })

  afterEach(async () => {
    logSpy.mockRestore()
    process.env = { ...envBackup }
    process.exitCode = undefined
    await fs.rm(tmpRoot, { recursive: true, force: true })
  })

  function readSummary() {
    const payloads = logSpy.mock.calls
      .map((c) => c[0])
      .filter((line): line is string => typeof line === 'string' && line.trimStart().startsWith('{'))
    return JSON.parse(payloads[payloads.length - 1])
  }

  function vendorEditedSeller() {
    return makeSellerService([
      existingSellerWith({
        seededFields: ['description'],
        column: VENDOR_DESCRIPTION,
        registry: CONFIG_DESCRIPTION,
      }),
    ])
  }

  it('NIE kasuje opisu vendora i zgłasza pominięcie w summary.warnings', async () => {
    process.env.GP_CONFIG_ROOT = tmpRoot
    process.env.GP_OVERWRITE = 'true'
    delete process.env.GP_FORCE_VENDOR_OVERWRITE

    const sellerService = vendorEditedSeller()

    await gpConfigSyncVendors({
      container: makeContainer(sellerService),
      args: ['gp-dev', 'bonbeauty'],
    } as any)

    expect(updatedColumns(sellerService).description).toBeUndefined()

    const summary = readSummary()
    const ownershipWarnings = summary.warnings.filter(
      (w: string) => w.includes('studio-nova') && w.includes('description')
    )
    expect(ownershipWarnings).toHaveLength(1)
    // Cykl 5: warning wskazuje INTERFEJS OPERATORSKI (`--force`), a nie nazwę
    // zmiennej środowiskowej — operator ma sięgnąć po flagę, nie po `export`.
    expect(ownershipWarnings[0]).toMatch(/--force/)
  })

  it('pominięcie własności trafia do typowanego kanału summary.ownership_protected', async () => {
    // W2 — to JEDYNA klasa warningu, która eskaluje run. Musi być rozpoznawalna
    // maszynowo, nie przez dopasowanie tekstu warninga.
    process.env.GP_CONFIG_ROOT = tmpRoot
    process.env.GP_OVERWRITE = 'true'
    delete process.env.GP_FORCE_VENDOR_OVERWRITE

    await gpConfigSyncVendors({
      container: makeContainer(vendorEditedSeller()),
      args: ['gp-dev', 'bonbeauty'],
    } as any)

    expect(readSummary().ownership_protected).toEqual([
      {
        vendor_id: 'studio-nova',
        fields: ['description'],
        // Cykl 5 — przyczyna per pole. Preflight `--force` musi umieć powiedzieć
        // operatorowi, że wartość na encji rozjechała się z zapisanym seedem,
        // a nie tylko „pole chronione".
        details: [{ field: 'description', reason: 'vendor-edited-seeded-field' }],
      },
    ])
    expect(process.exitCode).toBe(1)
  })

  it('zastany, nieszkodliwy warning NIE podnosi kodu wyjścia', async () => {
    // RED-FIRST (W2): do cyklu 3 `warnings.length > 0` ustawiało `exitCode = 1`,
    // a orchestrator (po V4) przestał ten kod połykać — więc „vendor suspended;
    // skipping seller-product linking" wywracało w pełni udany `gp catalog sync`.
    process.env.GP_CONFIG_ROOT = tmpRoot
    delete process.env.GP_OVERWRITE
    delete process.env.GP_FORCE_VENDOR_OVERWRITE

    const marketDir = path.join(tmpRoot, 'gp-dev', 'markets', 'bonbeauty')
    await fs.writeFile(
      path.join(marketDir, 'market.yaml'),
      [
        'market_id: bonbeauty',
        'currency: PLN',
        'vendors:',
        '  - vendor_id: studio-nova',
        '    slug: studio-nova',
        '    status: suspended',
        `    description: "${CONFIG_DESCRIPTION}"`,
      ].join('\n'),
      'utf8'
    )

    await gpConfigSyncVendors({
      container: makeContainer(makeSellerService([existingSellerWith({ column: null })])),
      args: ['gp-dev', 'bonbeauty'],
    } as any)

    const summary = readSummary()
    expect(summary.warnings.some((w: string) => w.includes('suspended'))).toBe(true)
    expect(summary.ownership_protected).toEqual([])
    expect(process.exitCode).toBeUndefined()
  })

  it('sam odziedziczony GP_FORCE_VENDOR_OVERWRITE=true NIE nadpisuje treści vendora (kanał dwustronny)', async () => {
    // Verify-B5 V1: `sanitizeEnv` kopiuje każdą niesekretną zmienną rodzica do
    // dziecka, a `GP_*` nie pasuje do żadnego wzorca sekretu. Przy semantyce
    // OR(argv, env) odziedziczona zmienna kasowała opisy salonów bez żadnej
    // intencji w wywołaniu.
    process.env.GP_CONFIG_ROOT = tmpRoot
    process.env.GP_FORCE_VENDOR_OVERWRITE = 'true'
    delete process.env.GP_OVERWRITE
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined)

    const sellerService = vendorEditedSeller()

    // BEZ `--force-vendor-overwrite` w argv — tak wygląda odziedziczone env
    // bez jawnej intencji wywołania.
    await gpConfigSyncVendors({
      container: makeContainer(sellerService),
      args: ['gp-dev', 'bonbeauty'],
    } as any)

    expect(updatedColumns(sellerService).description).toBeUndefined()

    // ...i nie po cichu: ignorowany kanał destrukcyjny musi być głośny.
    const warnText = warnSpy.mock.calls.flat().join(' ')
    expect(warnText).toMatch(/ZIGNOROWANE/)
    expect(warnText).toMatch(/--force-vendor-overwrite/)

    const summary = readSummary()
    expect(summary.warnings.some((w: string) => w.includes('ZIGNOROWANE'))).toBe(true)
    warnSpy.mockRestore()
  })

  it('sam argument --force-vendor-overwrite bez env też jest ZIGNOROWANY i głośny', async () => {
    process.env.GP_CONFIG_ROOT = tmpRoot
    delete process.env.GP_OVERWRITE
    delete process.env.GP_FORCE_VENDOR_OVERWRITE
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined)

    const sellerService = vendorEditedSeller()

    await gpConfigSyncVendors({
      container: makeContainer(sellerService),
      args: ['gp-dev', 'bonbeauty', '--force-vendor-overwrite'],
    } as any)

    expect(updatedColumns(sellerService).description).toBeUndefined()
    expect(warnSpy.mock.calls.flat().join(' ')).toMatch(/ZIGNOROWANE/)
    warnSpy.mockRestore()
  })

  it('dwustronnie (argv + env) nadpisuje kolumnę i ostrzega fail-loud', async () => {
    process.env.GP_CONFIG_ROOT = tmpRoot
    process.env.GP_FORCE_VENDOR_OVERWRITE = 'true'
    delete process.env.GP_OVERWRITE
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined)

    const sellerService = vendorEditedSeller()

    await gpConfigSyncVendors({
      container: makeContainer(sellerService),
      args: ['gp-dev', 'bonbeauty', '--force-vendor-overwrite'],
    } as any)

    expect(updatedColumns(sellerService).description).toBe(CONFIG_DESCRIPTION)
    const warnText = warnSpy.mock.calls.flat().join(' ')
    expect(warnText).toMatch(/GP_FORCE_VENDOR_OVERWRITE/)
    expect(warnText).not.toMatch(/ZIGNOROWANE/)
    warnSpy.mockRestore()
  })

  // ---- Cykl 5: rejestr TEGO, CO FORCE ZNISZCZYŁ (ADR-165 §4) ----
  //
  // RED-FIRST: do cyklu 4 raport miał wyłącznie kanał „odmówiłem"
  // (`ownership_protected`). Run z force przechodził bramkę, kasował treść
  // vendora i kończył się dokładnie takim samym raportem jak run, który nie
  // miał czego kasować — więc `gp catalog sync` nie miał z czego zbudować ani
  // raportu po wykonaniu, ani rozróżnienia wyniku.

  it('force nadpisujący Case 2 zapisuje się w summary.vendor_overwritten', async () => {
    process.env.GP_CONFIG_ROOT = tmpRoot
    process.env.GP_OVERWRITE = 'true'
    process.env.GP_FORCE_VENDOR_OVERWRITE = 'true'
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined)

    const sellerService = vendorEditedSeller()

    await gpConfigSyncVendors({
      container: makeContainer(sellerService),
      args: ['gp-dev', 'bonbeauty', '--force-vendor-overwrite'],
    } as any)

    expect(updatedColumns(sellerService).description).toBe(CONFIG_DESCRIPTION)

    const summary = readSummary()
    expect(summary.vendor_overwritten).toEqual([
      { vendor_id: 'studio-nova', fields: ['description'] },
    ])
    // Odmowy nie było — bramka została przełamana, nie uruchomiona.
    expect(summary.ownership_protected).toEqual([])
    expect(
      summary.warnings.some((w: string) => w.includes('NADPISAŁ') && w.includes('studio-nova'))
    ).toBe(true)
    // Nadpisanie NIE jest porażką runu: operator o nie prosił.
    expect(process.exitCode).toBeUndefined()
    warnSpy.mockRestore()
  })

  it('force nadpisujący Case 4 (nigdy nie seedowane) też trafia do rejestru', async () => {
    process.env.GP_CONFIG_ROOT = tmpRoot
    process.env.GP_OVERWRITE = 'true'
    process.env.GP_FORCE_VENDOR_OVERWRITE = 'true'
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined)

    const sellerService = makeSellerService([
      existingSellerWith({ seededFields: [], column: VENDOR_DESCRIPTION }),
    ])

    await gpConfigSyncVendors({
      container: makeContainer(sellerService),
      args: ['gp-dev', 'bonbeauty', '--force-vendor-overwrite'],
    } as any)

    expect(updatedColumns(sellerService).description).toBe(CONFIG_DESCRIPTION)
    expect(readSummary().vendor_overwritten).toEqual([
      { vendor_id: 'studio-nova', fields: ['description'] },
    ])
    warnSpy.mockRestore()
  })

  it('bez force TE SAME przypadki są chronione i rejestr zostaje pusty', async () => {
    process.env.GP_CONFIG_ROOT = tmpRoot
    process.env.GP_OVERWRITE = 'true'
    delete process.env.GP_FORCE_VENDOR_OVERWRITE

    const case4Service = makeSellerService([
      existingSellerWith({ seededFields: [], column: VENDOR_DESCRIPTION }),
    ])

    await gpConfigSyncVendors({
      container: makeContainer(case4Service),
      args: ['gp-dev', 'bonbeauty'],
    } as any)

    expect(updatedColumns(case4Service).description).toBeUndefined()
    const summary = readSummary()
    expect(summary.vendor_overwritten).toEqual([])
    expect(summary.ownership_protected).toEqual([
      {
        vendor_id: 'studio-nova',
        fields: ['description'],
        details: [{ field: 'description', reason: 'never-seeded-vendor-content' }],
      },
    ])
  })

  it('preflight `gp catalog sync --force` widzi konflikty w dry-runie, nic nie pisząc', async () => {
    // To jest dokładnie zapytanie, które zadaje `collectVendorOwnedConflicts`:
    // dry-run + GP_OVERWRITE, force WYŁĄCZONY. Odpowiedź pochodzi z tej samej
    // bramki, która potem realnie decyduje — nie z jej kopii w CLI.
    process.env.GP_CONFIG_ROOT = tmpRoot
    process.env.GP_OVERWRITE = 'true'
    process.env.GP_DRY_RUN = 'true'
    delete process.env.GP_FORCE_VENDOR_OVERWRITE

    const sellerService = vendorEditedSeller()

    await gpConfigSyncVendors({
      container: makeContainer(sellerService),
      args: ['gp-dev', 'bonbeauty'],
    } as any)

    // Zero zapisów — asercja na spy usługi, nie na treści raportu.
    expect(sellerService.update).not.toHaveBeenCalled()
    expect(readSummary().ownership_protected).toEqual([
      {
        vendor_id: 'studio-nova',
        fields: ['description'],
        details: [{ field: 'description', reason: 'vendor-edited-seeded-field' }],
      },
    ])
    // Dry-run niczego nie zapisał, więc nie ma czego eskalować.
    expect(process.exitCode).toBeUndefined()
  })
})
