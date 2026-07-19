import {
  normalizeCategoryImages,
  syncCategoryMedia,
  syncCollectionMedia,
} from '../../scripts/gp-config-sync-media'
import { DryRunCollector } from '../../scripts/gp-sync-dry-run'

function makeProductModuleService(overrides: Record<string, any> = {}) {
  return {
    listProductCollections: jest.fn().mockResolvedValue([]),
    updateProductCollections: jest.fn().mockResolvedValue({}),
    ...overrides,
  }
}

describe('syncCollectionMedia', () => {
  it('updates collection metadata.photo_url for the current market', async () => {
    const productModuleService = makeProductModuleService({
      listProductCollections: jest.fn().mockResolvedValue([
        {
          id: 'col-premium-core',
          handle: 'premium-core',
          metadata: {
            gp: {
              market_id: 'bonbeauty',
            },
          },
        },
      ]),
    })
    const warnings: string[] = []

    const counts = await syncCollectionMedia(
      productModuleService,
      [
        {
          collection_id: 'premium-core',
          handle: 'premium-core',
          photo_url: 'https://cdn.example.com/gp/bonbeauty/collections/premium-core/cover.jpg',
        },
      ],
      'bonbeauty',
      warnings
    )

    expect(counts).toEqual({ updated: 1, skipped: 0 })
    expect(productModuleService.updateProductCollections).toHaveBeenCalledWith(
      'col-premium-core',
      expect.objectContaining({
        metadata: expect.objectContaining({
          photo_url: 'https://cdn.example.com/gp/bonbeauty/collections/premium-core/cover.jpg',
        }),
      })
    )
    expect(warnings).toHaveLength(0)
  })

  it('skips and warns when collection belongs to another market', async () => {
    const productModuleService = makeProductModuleService({
      listProductCollections: jest.fn().mockResolvedValue([
        {
          id: 'col-premium-core',
          handle: 'premium-core',
          metadata: {
            gp: {
              market_id: 'mercur',
            },
          },
        },
      ]),
    })
    const warnings: string[] = []

    const counts = await syncCollectionMedia(
      productModuleService,
      [
        {
          collection_id: 'premium-core',
          handle: 'premium-core',
          photo_url: 'https://cdn.example.com/gp/bonbeauty/collections/premium-core/cover.jpg',
        },
      ],
      'bonbeauty',
      warnings
    )

    expect(counts).toEqual({ updated: 0, skipped: 1 })
    expect(productModuleService.updateProductCollections).not.toHaveBeenCalled()
    expect(warnings.some((warning) => warning.includes('cross-market guard'))).toBe(true)
  })

  it('prefers the collection already tagged for the current market when multiple handles exist', async () => {
    const productModuleService = makeProductModuleService({
      listProductCollections: jest.fn().mockResolvedValue([
        {
          id: 'col-premium-core-foreign',
          handle: 'premium-core',
          metadata: {
            gp: {
              market_id: 'mercur',
            },
          },
        },
        {
          id: 'col-premium-core-current',
          handle: 'premium-core',
          metadata: {
            gp: {
              market_id: 'bonbeauty',
            },
          },
        },
      ]),
    })
    const warnings: string[] = []

    const counts = await syncCollectionMedia(
      productModuleService,
      [
        {
          collection_id: 'premium-core',
          handle: 'premium-core',
          photo_url: 'https://cdn.example.com/gp/bonbeauty/collections/premium-core/cover.jpg',
        },
      ],
      'bonbeauty',
      warnings
    )

    expect(counts).toEqual({ updated: 1, skipped: 0 })
    expect(productModuleService.updateProductCollections).toHaveBeenCalledWith(
      'col-premium-core-current',
      expect.anything()
    )
    expect(warnings).toHaveLength(0)
  })

  it('skips and warns when multiple untagged collections share the same handle', async () => {
    const productModuleService = makeProductModuleService({
      listProductCollections: jest.fn().mockResolvedValue([
        {
          id: 'col-premium-core-a',
          handle: 'premium-core',
          metadata: {},
        },
        {
          id: 'col-premium-core-b',
          handle: 'premium-core',
          metadata: {},
        },
      ]),
    })
    const warnings: string[] = []

    const counts = await syncCollectionMedia(
      productModuleService,
      [
        {
          collection_id: 'premium-core',
          handle: 'premium-core',
          photo_url: 'https://cdn.example.com/gp/bonbeauty/collections/premium-core/cover.jpg',
        },
      ],
      'bonbeauty',
      warnings
    )

    expect(counts).toEqual({ updated: 0, skipped: 1 })
    expect(productModuleService.updateProductCollections).not.toHaveBeenCalled()
    expect(warnings.some((warning) => warning.includes('multiple untagged collections'))).toBe(true)
  })

  it('skips collections without photo_url', async () => {
    const productModuleService = makeProductModuleService()
    const warnings: string[] = []

    const counts = await syncCollectionMedia(
      productModuleService,
      [
        {
          collection_id: 'premium-core',
          handle: 'premium-core',
        },
      ],
      'bonbeauty',
      warnings
    )

    expect(counts).toEqual({ updated: 0, skipped: 1 })
    expect(productModuleService.listProductCollections).not.toHaveBeenCalled()
    expect(warnings).toHaveLength(0)
  })

  it('records planned collection media update in dry-run without touching DB', async () => {
    const productModuleService = makeProductModuleService({
      listProductCollections: jest.fn().mockResolvedValue([
        {
          id: 'col-premium-core',
          handle: 'premium-core',
          metadata: {
            gp: {
              market_id: 'bonbeauty',
            },
          },
        },
      ]),
    })
    const warnings: string[] = []
    const collector = new DryRunCollector()

    const counts = await syncCollectionMedia(
      productModuleService,
      [
        {
          collection_id: 'premium-core',
          handle: 'premium-core',
          photo_url: 'https://cdn.example.com/gp/bonbeauty/collections/premium-core/cover.jpg',
        },
      ],
      'bonbeauty',
      warnings,
      collector
    )

    expect(counts).toEqual({ updated: 1, skipped: 0 })
    expect(productModuleService.updateProductCollections).not.toHaveBeenCalled()
    expect(collector.getEntries()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ entityType: 'collection-media', handle: 'premium-core', action: 'update' }),
      ])
    )
  })
})

describe('normalizeCategoryImages', () => {
  it('preserves source order, carries alt with url, keeps is_primary only when true', () => {
    const warnings: string[] = []

    const images = normalizeCategoryImages(
      [
        { url: ' assets/envato_images/a.jpg ', alt: 'Primary alt', is_primary: true },
        { url: 'assets/envato_images/b.jpg', alt: '' },
        { url: 'assets/envato_images/c.jpg', is_primary: false },
      ],
      'grp_twarz',
      warnings
    )

    expect(images).toEqual([
      { url: 'assets/envato_images/a.jpg', alt: 'Primary alt', is_primary: true },
      { url: 'assets/envato_images/b.jpg', alt: '' },
      { url: 'assets/envato_images/c.jpg' },
    ])
    expect(warnings).toHaveLength(0)
  })

  it('returns empty array for missing images without warning', () => {
    const warnings: string[] = []

    expect(normalizeCategoryImages(undefined, 'grp_twarz', warnings)).toEqual([])
    expect(normalizeCategoryImages(null, 'grp_twarz', warnings)).toEqual([])
    expect(warnings).toHaveLength(0)
  })

  it('warns and ignores non-array images', () => {
    const warnings: string[] = []

    expect(normalizeCategoryImages('assets/a.jpg', 'grp_twarz', warnings)).toEqual([])
    expect(warnings.some((w) => w.includes('images is not an array'))).toBe(true)
  })

  it('drops elements without a usable url and warns per element', () => {
    const warnings: string[] = []

    const images = normalizeCategoryImages(
      [{ alt: 'no url' }, { url: '   ' }, { url: 'assets/ok.jpg' }, null],
      'grp_twarz',
      warnings
    )

    expect(images).toEqual([{ url: 'assets/ok.jpg' }])
    expect(warnings).toHaveLength(3)
    expect(warnings.every((w) => w.includes('missing url'))).toBe(true)
  })
})

describe('syncCategoryMedia', () => {
  function makeCategoryModuleService(overrides: Record<string, any> = {}) {
    return {
      listProductCategories: jest.fn().mockResolvedValue([
        {
          id: 'pcat-twarz',
          handle: 'twarz',
          metadata: {
            photo_url: 'assets/envato_images/old.jpg',
            gp: {
              market_id: 'bonbeauty',
              fixture_id: 'grp_twarz',
            },
          },
        },
      ]),
      updateProductCategories: jest.fn().mockResolvedValue({}),
      ...overrides,
    }
  }

  const sourceCategory = {
    category_id: 'grp_twarz',
    slug: 'twarz',
    photo_url: 'assets/envato_images/primary.jpg',
    images: [
      { url: 'assets/envato_images/primary.jpg', alt: 'Zabieg na twarz', is_primary: true },
      { url: 'assets/envato_images/second.jpg', alt: 'Oczyszczanie twarzy' },
    ],
  }

  it('materializes metadata.gp.images preserving order and alt, keeps photo_url', async () => {
    const productModuleService = makeCategoryModuleService()
    const warnings: string[] = []

    const counts = await syncCategoryMedia(
      productModuleService,
      [sourceCategory],
      'bonbeauty',
      warnings
    )

    expect(counts).toEqual({ updated: 1, skipped: 0 })
    expect(warnings).toHaveLength(0)
    expect(productModuleService.updateProductCategories).toHaveBeenCalledWith('pcat-twarz', {
      metadata: {
        photo_url: 'assets/envato_images/primary.jpg',
        gp: {
          market_id: 'bonbeauty',
          fixture_id: 'grp_twarz',
          images: [
            { url: 'assets/envato_images/primary.jpg', alt: 'Zabieg na twarz', is_primary: true },
            { url: 'assets/envato_images/second.jpg', alt: 'Oczyszczanie twarzy' },
          ],
        },
      },
    })
  })

  it('is idempotent: a second run on the same source produces the same metadata payload', async () => {
    const productModuleService = makeCategoryModuleService()
    const warnings: string[] = []

    await syncCategoryMedia(productModuleService, [sourceCategory], 'bonbeauty', warnings)
    const firstPayload = productModuleService.updateProductCategories.mock.calls[0][1]

    // Simulate the DB state after the first run and sync again.
    productModuleService.listProductCategories.mockResolvedValue([
      { id: 'pcat-twarz', handle: 'twarz', metadata: firstPayload.metadata },
    ])
    await syncCategoryMedia(productModuleService, [sourceCategory], 'bonbeauty', warnings)
    const secondPayload = productModuleService.updateProductCategories.mock.calls[1][1]

    expect(secondPayload).toEqual(firstPayload)
    expect(secondPayload.metadata.gp.images).toHaveLength(2)
    expect(warnings).toHaveLength(0)
  })

  it('updates gp.images without touching existing photo_url when source has images only', async () => {
    const productModuleService = makeCategoryModuleService()
    const warnings: string[] = []

    const counts = await syncCategoryMedia(
      productModuleService,
      [
        {
          category_id: 'grp_twarz',
          slug: 'twarz',
          images: [{ url: 'assets/envato_images/only.jpg', alt: 'Alt' }],
        },
      ],
      'bonbeauty',
      warnings
    )

    expect(counts).toEqual({ updated: 1, skipped: 0 })
    const payload = productModuleService.updateProductCategories.mock.calls[0][1]
    expect(payload.metadata.photo_url).toBe('assets/envato_images/old.jpg')
    expect(payload.metadata.gp.images).toEqual([
      { url: 'assets/envato_images/only.jpg', alt: 'Alt' },
    ])
  })

  it('clears stale metadata.gp.images when source declares an empty images[] (3-1-F1)', async () => {
    const productModuleService = makeCategoryModuleService({
      listProductCategories: jest.fn().mockResolvedValue([
        {
          id: 'pcat-twarz',
          handle: 'twarz',
          metadata: {
            photo_url: 'assets/envato_images/old.jpg',
            gp: {
              market_id: 'bonbeauty',
              fixture_id: 'grp_twarz',
              images: [
                { url: 'assets/envato_images/stale.jpg', alt: 'Stale', is_primary: true },
              ],
            },
          },
        },
      ]),
    })
    const warnings: string[] = []

    const counts = await syncCategoryMedia(
      productModuleService,
      [{ category_id: 'grp_twarz', slug: 'twarz', photo_url: 'assets/envato_images/old.jpg', images: [] }],
      'bonbeauty',
      warnings
    )

    expect(counts).toEqual({ updated: 1, skipped: 0 })
    const payload = productModuleService.updateProductCategories.mock.calls[0][1]
    expect(payload.metadata.gp.images).toEqual([])
    expect(warnings.some((w) => w.includes('clearing metadata.gp.images'))).toBe(true)
  })

  it('clears stale metadata.gp.images when all source images[] entries are dropped as invalid', async () => {
    const productModuleService = makeCategoryModuleService({
      listProductCategories: jest.fn().mockResolvedValue([
        {
          id: 'pcat-twarz',
          handle: 'twarz',
          metadata: {
            gp: {
              market_id: 'bonbeauty',
              images: [{ url: 'assets/envato_images/stale.jpg' }],
            },
          },
        },
      ]),
    })
    const warnings: string[] = []

    const counts = await syncCategoryMedia(
      productModuleService,
      [
        {
          category_id: 'grp_twarz',
          slug: 'twarz',
          photo_url: 'assets/envato_images/old.jpg',
          images: [{ alt: 'no url here' } as any],
        },
      ],
      'bonbeauty',
      warnings
    )

    expect(counts).toEqual({ updated: 1, skipped: 0 })
    const payload = productModuleService.updateProductCategories.mock.calls[0][1]
    expect(payload.metadata.gp.images).toEqual([])
  })

  it('leaves existing metadata.gp.images untouched when source omits images entirely (undeclared, not empty)', async () => {
    const productModuleService = makeCategoryModuleService({
      listProductCategories: jest.fn().mockResolvedValue([
        {
          id: 'pcat-twarz',
          handle: 'twarz',
          metadata: {
            gp: {
              market_id: 'bonbeauty',
              images: [{ url: 'assets/envato_images/kept.jpg', is_primary: true }],
            },
          },
        },
      ]),
    })
    const warnings: string[] = []

    const counts = await syncCategoryMedia(
      productModuleService,
      [{ category_id: 'grp_twarz', slug: 'twarz', photo_url: 'assets/envato_images/new.jpg' }],
      'bonbeauty',
      warnings
    )

    expect(counts).toEqual({ updated: 1, skipped: 0 })
    const payload = productModuleService.updateProductCategories.mock.calls[0][1]
    expect(payload.metadata.gp.images).toEqual([
      { url: 'assets/envato_images/kept.jpg', is_primary: true },
    ])
  })

  it('skips categories with neither photo_url nor images', async () => {
    const productModuleService = makeCategoryModuleService()
    const warnings: string[] = []

    const counts = await syncCategoryMedia(
      productModuleService,
      [{ category_id: 'grp_pusta', slug: 'pusta' }],
      'bonbeauty',
      warnings
    )

    expect(counts).toEqual({ updated: 0, skipped: 1 })
    expect(productModuleService.listProductCategories).not.toHaveBeenCalled()
    expect(productModuleService.updateProductCategories).not.toHaveBeenCalled()
  })

  it('skips and warns when category belongs to another market', async () => {
    const productModuleService = makeCategoryModuleService({
      listProductCategories: jest.fn().mockResolvedValue([
        {
          id: 'pcat-foreign',
          handle: 'twarz',
          metadata: { gp: { market_id: 'mercur' } },
        },
      ]),
    })
    const warnings: string[] = []

    const counts = await syncCategoryMedia(
      productModuleService,
      [sourceCategory],
      'bonbeauty',
      warnings
    )

    expect(counts).toEqual({ updated: 0, skipped: 1 })
    expect(productModuleService.updateProductCategories).not.toHaveBeenCalled()
    expect(warnings.some((w) => w.includes('cross-market guard'))).toBe(true)
  })

  it('records planned category media update in dry-run without touching DB', async () => {
    const productModuleService = makeCategoryModuleService()
    const warnings: string[] = []
    const collector = new DryRunCollector()

    const counts = await syncCategoryMedia(
      productModuleService,
      [sourceCategory],
      'bonbeauty',
      warnings,
      collector
    )

    expect(counts).toEqual({ updated: 1, skipped: 0 })
    expect(productModuleService.updateProductCategories).not.toHaveBeenCalled()
    expect(collector.getEntries()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          entityType: 'category-media',
          handle: 'twarz',
          action: 'update',
          note: 'photo_url=yes; images=2',
        }),
      ])
    )
  })
})