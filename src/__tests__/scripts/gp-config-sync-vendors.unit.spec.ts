import { upsertSeller } from '../../scripts/gp-config-sync-vendors'

describe('upsertSeller dry-run', () => {
  it('reports normalized seed_if_empty diffs without updating the DB', async () => {
    const sellerModuleService = {
      list: jest.fn().mockResolvedValue([
        {
          id: 'seller-1',
          handle: 'city-beauty',
          name: 'City Beauty',
          metadata: {
            gp: {
              seeded_fields: ['description', 'photo_url'],
              description: 'A &amp; B',
              photo_url: 'https://cdn.example.com/old.jpg',
            },
          },
        },
      ]),
      update: jest.fn(),
    }

    const result = await upsertSeller(
      sellerModuleService,
      {
        vendor_id: 'city-beauty',
        slug: 'city-beauty',
        description: 'A & B',
        photo_url: 'https://cdn.example.com/new.jpg',
      },
      true,
      'bonbeauty'
    )

    expect(result.action).toBe('updated')
    expect(result.note).toContain('photo_url: https://cdn.example.com/old.jpg -> https://cdn.example.com/new.jpg')
    expect(result.note).not.toContain('description:')
    expect(sellerModuleService.update).not.toHaveBeenCalled()
  })
})