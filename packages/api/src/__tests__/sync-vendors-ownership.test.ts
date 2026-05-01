/**
 * Ownership preservation integration test for gp-config-sync-vendors.ts
 *
 * Story 7.7 — AC: #1, #2, #3, #4, #5
 *
 * Uses in-memory mock Seller service (no real DB / PostgreSQL).
 * Pattern follows gp-config-sync-media.unit.spec.ts (story 7.6).
 */

import { upsertSeller } from '../scripts/gp-config-sync-vendors'

// ---- Mock factory ----

function makeSellerService(existingSellers: any[] = []) {
  return {
    list: jest.fn().mockResolvedValue(existingSellers),
    update: jest.fn().mockImplementation(async (id: string, payload: any) => ({ id, ...payload })),
    create: jest.fn().mockImplementation(async (payload: any) => ({ id: 'seller-new-001', ...payload })),
  }
}

// ---- Test: AC #4 — initial seed (fresh vendor, no DB record) ----

describe('upsertSeller — initial seed (fresh vendor)', () => {
  it('creates seller with all seed_if_empty fields and tracks them in seeded_fields[]', async () => {
    const sellerService = makeSellerService([]) // no existing record

    const vendor = {
      vendor_id: 'kremidotyk',
      slug: 'kremidotyk',
      status: 'onboarded',
      display_name: 'KREM i DOTYK',
      email: 'kontakt@kremidotyk.pl',
      phone: '+48578919155',
      description: 'Masaże ciała',
      photo_url: 'https://cdn.example.com/kremidotyk/photo.jpg',
      gallery_urls: ['https://cdn.example.com/kremidotyk/g1.jpg'],
    }

    const result = await upsertSeller(sellerService, vendor, false, 'bonbeauty')

    expect(result.action).toBe('created')
    expect(result.sellerId).toBeTruthy()

    expect(sellerService.create).toHaveBeenCalledTimes(1)
    const createArg = sellerService.create.mock.calls[0][0]

    // config_wins fields present
    expect(createArg.handle).toBe('kremidotyk')
    expect(createArg.email).toBe('kontakt@kremidotyk.pl')
    expect(createArg.store_status).toBe('ACTIVE')

    // seed_if_empty fields written
    expect(createArg.metadata.gp.description).toBe('Masaże ciała')
    expect(createArg.metadata.gp.photo_url).toBe('https://cdn.example.com/kremidotyk/photo.jpg')

    // seeded_fields[] tracking
    const seededFields: string[] = createArg.metadata.gp.seeded_fields
    expect(seededFields).toContain('description')
    expect(seededFields).toContain('name')
    expect(seededFields).toContain('photo_url')
    expect(seededFields).toContain('gallery')

    // market_id in gp metadata
    expect(createArg.metadata.gp.market_id).toBe('bonbeauty')
  })
})

// ---- Test: AC #1, #2 — re-sync with vendor-edited description (MAIN ownership test) ----

describe('upsertSeller — re-sync: vendor-edited description preserved', () => {
  it('does NOT overwrite description when vendor edited it (seed_if_empty skip)', async () => {
    const existingSeller = {
      id: 'seller-kremidotyk',
      handle: 'kremidotyk',
      name: 'KREM i DOTYK',
      description: 'Moja własna treść',  // vendor edited this
      metadata: {
        gp: {
          market_id: 'bonbeauty',
          seeded_fields: ['description', 'name'],
          description: 'Moja własna treść',  // tracked in gp namespace too
        },
      },
    }
    const sellerService = makeSellerService([existingSeller])

    const vendor = {
      vendor_id: 'kremidotyk',
      slug: 'kremidotyk',
      status: 'onboarded',
      description: 'Masaże ciała',  // config value (differs from vendor-edited)
    }

    const result = await upsertSeller(sellerService, vendor, false, 'bonbeauty')

    expect(result.action).toBe('updated')
    expect(sellerService.update).toHaveBeenCalledTimes(1)

    const updateArg = sellerService.update.mock.calls[0][1]

    // description must NOT be overwritten (vendor edit preserved)
    expect(updateArg.metadata.gp.description).not.toBe('Masaże ciała')
    // or description was not set to config value (either not present or original value)
    if ('description' in updateArg.metadata.gp) {
      expect(updateArg.metadata.gp.description).toBe('Moja własna treść')
    }

    // seeded_fields still contains 'description' (tracking preserved)
    const seededFields: string[] = updateArg.metadata.gp.seeded_fields
    expect(seededFields).toContain('description')
  })
})

// ---- Test: AC #3 — config-authoritative handle tampered in DB ----

describe('upsertSeller — config-authoritative handle overwritten', () => {
  it('overwrites tampered handle back to config value (config_wins)', async () => {
    const existingSeller = {
      id: 'seller-kremidotyk',
      handle: 'WRONG-handle',  // tampered in DB
      metadata: {
        gp: {
          market_id: 'bonbeauty',
          seeded_fields: [],
        },
      },
    }
    const sellerService = makeSellerService([existingSeller])

    const vendor = {
      vendor_id: 'kremidotyk',
      slug: 'kremidotyk',  // config value
      status: 'onboarded',
    }

    const result = await upsertSeller(sellerService, vendor, false, 'bonbeauty')

    expect(result.action).toBe('updated')
    expect(sellerService.update).toHaveBeenCalledTimes(1)

    const updateArg = sellerService.update.mock.calls[0][1]
    // handle must be overwritten to config value
    expect(updateArg.handle).toBe('kremidotyk')
  })
})

// ---- Test: AC #5 — vendor reverted description to config value (re-seed allowed) ----

describe('upsertSeller — vendor reverted description matches config → re-seed', () => {
  it('applies config value when vendor-reverted value == config value (case 1)', async () => {
    const existingSeller = {
      id: 'seller-kremidotyk',
      handle: 'kremidotyk',
      metadata: {
        gp: {
          market_id: 'bonbeauty',
          seeded_fields: ['description'],
          description: 'Masaże ciała',  // vendor reverted — same as config
        },
      },
    }
    const sellerService = makeSellerService([existingSeller])

    const vendor = {
      vendor_id: 'kremidotyk',
      slug: 'kremidotyk',
      description: 'Masaże ciała',  // config value (same as DB)
    }

    const result = await upsertSeller(sellerService, vendor, false, 'bonbeauty')

    expect(result.action).toBe('updated')
    expect(sellerService.update).toHaveBeenCalledTimes(1)

    const updateArg = sellerService.update.mock.calls[0][1]
    // config value must be applied (values match → case 1)
    expect(updateArg.metadata.gp.description).toBe('Masaże ciała')
  })
})

// ---- Test: seeded_fields integrity after re-sync ----

describe('upsertSeller — seeded_fields integrity', () => {
  it('preserves all original seeded fields and adds no duplicates after re-sync', async () => {
    const existingSeller = {
      id: 'seller-kremidotyk',
      handle: 'kremidotyk',
      metadata: {
        gp: {
          market_id: 'bonbeauty',
          seeded_fields: ['name', 'description', 'photo_url', 'gallery'],
          name: 'KREM i DOTYK',
          description: 'Masaże ciała',
          photo_url: 'https://cdn.example.com/kremidotyk/photo.jpg',
          gallery: ['https://cdn.example.com/kremidotyk/g1.jpg'],
        },
      },
    }
    const sellerService = makeSellerService([existingSeller])

    const vendor = {
      vendor_id: 'kremidotyk',
      slug: 'kremidotyk',
      status: 'onboarded',
      display_name: 'KREM i DOTYK',
      description: 'Masaże ciała',
      photo_url: 'https://cdn.example.com/kremidotyk/photo.jpg',
      gallery_urls: ['https://cdn.example.com/kremidotyk/g1.jpg'],
    }

    await upsertSeller(sellerService, vendor, false, 'bonbeauty')

    const updateArg = sellerService.update.mock.calls[0][1]
    const seededFields: string[] = updateArg.metadata.gp.seeded_fields

    // All original fields still present
    expect(seededFields).toContain('name')
    expect(seededFields).toContain('description')
    expect(seededFields).toContain('photo_url')
    expect(seededFields).toContain('gallery')

    // No duplicates
    const uniqueFields = new Set(seededFields)
    expect(uniqueFields.size).toBe(seededFields.length)
  })
})
