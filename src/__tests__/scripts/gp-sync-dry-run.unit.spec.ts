import {
  computeFieldDiffs,
  DryRunCollector,
  normalizeHtml,
  parseDryRunFlag,
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