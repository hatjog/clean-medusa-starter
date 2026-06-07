/**
 * Ownership preservation integration test for gp-config-sync-vendors.ts
 *
 * Story 7.7 — AC: #1, #2, #3, #4, #5
 *
 * Uses in-memory mock Seller service (no real DB / PostgreSQL).
 * Pattern follows gp-config-sync-media.unit.spec.ts (story 7.6).
 */

import { findConflictingSellerLink, upsertSeller } from '../scripts/gp-config-sync-vendors'

// Minimal chainable knex-like mock that records the filters and returns a
// configurable `.first()` row.
function makeDbMock(firstRow: { seller_id: string } | null) {
  const calls: { table?: string; where?: any; whereNot?: any; whereNull?: any } = {}
  const builder: any = {
    where: (w: any) => {
      calls.where = w
      return builder
    },
    whereNot: (w: any) => {
      calls.whereNot = w
      return builder
    },
    whereNull: (c: any) => {
      calls.whereNull = c
      return builder
    },
    first: async () => firstRow,
  }
  const db: any = (table: string) => {
    calls.table = table
    return builder
  }
  db.calls = calls
  return db
}

describe('findConflictingSellerLink — single-seller invariant', () => {
  it('returns the conflicting link when the product is owned by a DIFFERENT seller', async () => {
    const db = makeDbMock({ seller_id: 'sel_other' })
    const conflict = await findConflictingSellerLink(db, 'prod_1', 'sel_mine')
    expect(conflict).toEqual({ seller_id: 'sel_other' })
    expect(db.calls.table).toBe('product_product_seller_seller')
    expect(db.calls.where).toEqual({ product_id: 'prod_1' })
    expect(db.calls.whereNot).toEqual({ seller_id: 'sel_mine' })
    expect(db.calls.whereNull).toBe('deleted_at')
  })

  it('returns null when no other-seller link exists (safe to link)', async () => {
    const db = makeDbMock(null)
    expect(await findConflictingSellerLink(db, 'prod_1', 'sel_mine')).toBeNull()
  })

  it('only considers ACTIVE links (whereNull deleted_at) for a different seller', async () => {
    const db = makeDbMock(undefined as any)
    // undefined row coalesces to null
    expect(await findConflictingSellerLink(db, 'prod_2', 'sel_mine')).toBeNull()
    expect(db.calls.whereNull).toBe('deleted_at')
  })
})

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
    expect(createArg.status).toBe('open')

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
