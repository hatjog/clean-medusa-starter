import { resolveProductByFixture, upsertSeller } from '../../scripts/gp-config-sync-vendors'

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

describe('resolveProductByFixture', () => {
  it('returns fixture strategy when fixture lookup finds product', async () => {
    const listProducts = jest.fn().mockResolvedValueOnce([{ id: 'prod_fixture_1' }])

    const result = await resolveProductByFixture(listProducts, 'srv_0206', 'masaz-banka-twarz')

    expect(result.product?.id).toBe('prod_fixture_1')
    expect(result.strategy).toBe('fixture')
    expect(listProducts).toHaveBeenCalledTimes(1)
  })

  it('falls back to handle strategy when fixture lookup returns empty', async () => {
    const listProducts = jest
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: 'prod_handle_1' }])

    const result = await resolveProductByFixture(listProducts, 'srv_0208', 'masaz-twarz-maska-ampulka')

    expect(result.product?.id).toBe('prod_handle_1')
    expect(result.strategy).toBe('handle')
    expect(listProducts).toHaveBeenNthCalledWith(1, { metadata: { gp: { fixture_id: 'srv_0208' } } })
    expect(listProducts).toHaveBeenNthCalledWith(2, { handle: 'masaz-twarz-maska-ampulka' })
  })

  it('returns none when fixture lookup throws and fallback handle is missing', async () => {
    const listProducts = jest.fn().mockRejectedValueOnce(new Error('db offline'))

    const result = await resolveProductByFixture(listProducts, 'srv_0206')

    expect(result.product).toBeNull()
    expect(result.strategy).toBe('none')
    expect(result.error).toContain('fixture lookup failed')
  })
})