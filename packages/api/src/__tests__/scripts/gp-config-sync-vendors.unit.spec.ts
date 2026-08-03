import { resolveProductByFixture, upsertSeller } from '../../scripts/gp-config-sync-vendors'

describe('upsertSeller dry-run', () => {
  it('reports normalized seed_if_empty diffs without updating the DB', async () => {
    const sellerModuleService = {
      list: jest.fn().mockResolvedValue([
        {
          id: 'seller-1',
          handle: 'city-beauty',
          name: 'City Beauty',
          // Review cykl 4: wartość kanoniczna mieszka w KOLUMNIE encji;
          // `metadata.gp.*` to rejestr pochodzenia seeda. Nota dry-run opisuje
          // stan kolumn, bo to je zobaczy storefront.
          description: 'A &amp; B',
          logo: 'https://cdn.example.com/old.jpg',
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

  // Verify-B5 V5: ten test kodował kontrakt SPRZED ADR-165 („--overwrite wymusza
  // zapis config-owned"). Po odwróceniu semantyki przechodził wakacyjnie —
  // asertował wyłącznie notę diffu, która w dry-runie powstaje niezależnie od
  // decyzji o zapisie. Przepisany na kontrakt PO ADR-165: pole edytowane przez
  // vendora jest POMIJANE mimo `--overwrite`, a pominięcie jest raportowane.
  it('dry-run z overwrite=true raportuje pole vendor-owned jako pominięte (ADR-165), a nie jako nadpisane', async () => {
    const sellerModuleService = {
      list: jest.fn().mockResolvedValue([
        {
          id: 'seller-1',
          handle: 'city-beauty',
          name: 'City Beauty',
          // Kolumna (wartość) rozjechana z rejestrem (co zasialiśmy) ⇒ Case 2:
          // vendor edytował pole po zasianiu.
          description: 'Vendor custom description',
          metadata: {
            gp: {
              market_id: 'bonbeauty',
              seeded_fields: ['description'],
              description: 'Seeded description',
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
        description: 'Canonical config description',
      },
      true,
      'bonbeauty',
      'pln',
      true
    )

    expect(result.action).toBe('updated')
    // pole jest seeded, ale DB != config → vendor je edytował (Case 2)
    expect(result.ownershipProtectedFields).toEqual(['description'])
    expect(result.note).toContain('vendor-owned (pominięte mimo --overwrite, ADR-165)')
    expect(result.note).toContain('description')
    expect(sellerModuleService.update).not.toHaveBeenCalled()
  })

  it('skips seller update when the existing handle belongs to another market', async () => {
    const sellerModuleService = {
      list: jest.fn().mockResolvedValue([
        {
          id: 'seller-foreign',
          handle: 'city-beauty',
          metadata: {
            gp: {
              market_id: 'mercur',
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
        description: 'Canonical config description',
      },
      true,
      'bonbeauty',
      'pln',
      true
    )

    expect(result.action).toBe('skipped')
    expect(result.note).toContain("cross-market guard")
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