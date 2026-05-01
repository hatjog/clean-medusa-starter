import { syncCollectionMedia } from '../../scripts/gp-config-sync-media'
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