import {
  computeFieldDiffs,
  DryRunCollector,
  normalizeHtml,
  parseDryRunFlag,
  resolveForceVendorOverwrite,
  resolveForceVendorOverwriteRelay,
  FORCE_VENDOR_OVERWRITE_POSITIONAL,
} from '../../scripts/gp-sync-dry-run'

describe('parseDryRunFlag', () => {
  const originalEnv = process.env

  beforeEach(() => {
    process.env = { ...originalEnv }
    delete process.env.GP_DRY_RUN
  })

  afterAll(() => {
    process.env = originalEnv
  })

  it('detects --dry-run flag and GP_DRY_RUN env var', () => {
    expect(parseDryRunFlag(['gp-dev', 'bonbeauty', '--dry-run'])).toBe(true)

    process.env.GP_DRY_RUN = 'true'
    expect(parseDryRunFlag()).toBe(true)
    expect(parseDryRunFlag([])).toBe(true)
  })
})

describe('normalizeHtml', () => {
  it('decodes named and numeric HTML entities', () => {
    expect(normalizeHtml('Masa&#380; &amp; piel&#281;gnacja&nbsp;')).toBe('Masaż & pielęgnacja ')
  })
})

describe('computeFieldDiffs', () => {
  it('ignores differences caused only by HTML entity encoding', () => {
    const diffs = computeFieldDiffs(
      { description: 'A &amp; B' },
      { description: 'A & B' }
    )

    expect(diffs).toEqual([])
  })

  it('returns diffs for actual value changes', () => {
    const diffs = computeFieldDiffs(
      { description: 'Old copy', gallery: ['a.jpg'] },
      { description: 'New copy', gallery: ['a.jpg', 'b.jpg'] }
    )

    expect(diffs).toEqual([
      { field: 'description', current: 'Old copy', incoming: 'New copy' },
      { field: 'gallery', current: '["a.jpg"]', incoming: '["a.jpg","b.jpg"]' },
    ])
  })
})

describe('DryRunCollector', () => {
  it('renders an ASCII table for planned operations', () => {
    const collector = new DryRunCollector()
    collector.add({ entityType: 'product', handle: 'nail-art', action: 'update', note: 'status=draft' })

    const table = collector.renderTable()

    expect(table).toContain('entity_type')
    expect(table).toContain('product')
    expect(table).toContain('nail-art')
    expect(table).toContain('status=draft')
  })
})

// ---- Verify-B5 V1: kanał destrukcyjny ADR-165 jest DWUSTRONNY ----

describe('resolveForceVendorOverwrite', () => {
  const originalEnv = process.env

  beforeEach(() => {
    process.env = { ...originalEnv }
    delete process.env.GP_FORCE_VENDOR_OVERWRITE
  })

  afterAll(() => {
    process.env = originalEnv
  })

  it('włącza kanał tylko przy koniunkcji argv + env', () => {
    process.env.GP_FORCE_VENDOR_OVERWRITE = 'true'

    const decision = resolveForceVendorOverwrite(['gp-dev', 'bonbeauty', '--force-vendor-overwrite'])

    expect(decision.enabled).toBe(true)
    expect(decision.ignoredReason).toBeUndefined()
  })

  it('IGNORUJE samą odziedziczoną zmienną środowiskową i mówi o tym głośno', () => {
    // sanitizeEnv nie strippuje GP_*, więc env dociera do dziecka verbatim
    process.env.GP_FORCE_VENDOR_OVERWRITE = 'true'

    const decision = resolveForceVendorOverwrite(['gp-dev', 'bonbeauty'])

    expect(decision.enabled).toBe(false)
    expect(decision.ignoredReason).toMatch(/ZIGNOROWANE/)
    expect(decision.ignoredReason).toMatch(/--force-vendor-overwrite/)
  })

  it('IGNORUJE sam argument bez potwierdzenia w env i mówi o tym głośno', () => {
    const decision = resolveForceVendorOverwrite(['gp-dev', 'bonbeauty', '--force-vendor-overwrite'])

    expect(decision.enabled).toBe(false)
    expect(decision.ignoredReason).toMatch(/GP_FORCE_VENDOR_OVERWRITE/)
  })

  it('milczy, gdy nikt kanału nie dotknął', () => {
    expect(resolveForceVendorOverwrite(['gp-dev', 'bonbeauty'])).toEqual({ enabled: false })
  })

  it('jawne GP_FORCE_VENDOR_OVERWRITE=false wyłącza kanał mimo argumentu', () => {
    process.env.GP_FORCE_VENDOR_OVERWRITE = 'false'

    const decision = resolveForceVendorOverwrite(['gp-dev', 'bonbeauty', '--force-vendor-overwrite'])

    expect(decision.enabled).toBe(false)
    expect(decision.ignoredReason).toMatch(/ZIGNOROWANE/)
  })
})

// ---- Cykl 6 R3: token intencji nie dzieli przestrzeni nazw z argv pozycyjnym ----

describe('resolveForceVendorOverwriteRelay — slot tokenu intencji', () => {
  const originalEnv = process.env

  beforeEach(() => {
    process.env = { ...originalEnv }
    process.env.GP_FORCE_VENDOR_OVERWRITE = 'true'
  })

  afterAll(() => {
    process.env = originalEnv
  })

  it('włącza kanał, gdy token stoi w swoim slocie (args[2])', () => {
    const decision = resolveForceVendorOverwriteRelay([
      'gp-dev',
      'bonbeauty',
      FORCE_VENDOR_OVERWRITE_POSITIONAL,
    ])

    expect(decision.enabled).toBe(true)
  })

  it('market o nazwie tokenu NIE jest intencją zniszczenia treści', () => {
    // `force-vendor-overwrite` przechodzi MARKET_INSTANCE_ID_REGEX, więc do
    // cyklu 6 market (albo instancja) o tej nazwie pełniłby rolę intencji —
    // przy odziedziczonym GP_FORCE_VENDOR_OVERWRITE=true wystarczyło to,
    // żeby zwykły sync skasował treść vendorów.
    const asMarket = resolveForceVendorOverwriteRelay([
      'gp-dev',
      FORCE_VENDOR_OVERWRITE_POSITIONAL,
    ])
    expect(asMarket.enabled).toBe(false)
    expect(asMarket.ignoredReason).toMatch(/ZIGNOROWANE/)

    const asInstance = resolveForceVendorOverwriteRelay([
      FORCE_VENDOR_OVERWRITE_POSITIONAL,
      'bonbeauty',
    ])
    expect(asInstance.enabled).toBe(false)
  })
})
