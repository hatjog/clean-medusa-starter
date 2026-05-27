import {
  lookupSellerJti,
  timingSafeJtiEqual,
} from "../../../lib/auth/magic-link-seller-scope"

const JTI_A = "00000000-0000-4000-8000-000000000001"
const JTI_B = "00000000-0000-4000-8000-000000000002"

function dbWithRow(row: Record<string, unknown> | undefined) {
  const first = jest.fn().mockResolvedValue(row)
  const where = jest.fn(() => ({ first }))
  const select = jest.fn(() => ({ where }))
  const db = jest.fn(() => ({ select }))

  return { db, select, where, first }
}

describe("lookupSellerJti", () => {
  it("always performs one ledger query and returns seller scope for matching JTI", async () => {
    const { db, where } = dbWithRow({
      token_jti: JTI_A,
      subject_seller_id: "seller_1",
    })

    await expect(lookupSellerJti(db as never, JTI_A)).resolves.toEqual({
      found: true,
      subject_seller_id: "seller_1",
    })
    expect(db).toHaveBeenCalledWith("magic_link_issued")
    expect(where).toHaveBeenCalledWith({ token_jti: JTI_A })
  })

  it("returns not found for missing ledger rows without skipping the query", async () => {
    const { db, where } = dbWithRow(undefined)

    await expect(lookupSellerJti(db as never, JTI_A)).resolves.toEqual({
      found: false,
      subject_seller_id: null,
    })
    expect(where).toHaveBeenCalledWith({ token_jti: JTI_A })
  })

  it("uses timing-safe fixed-length comparison for mismatched inputs", () => {
    expect(timingSafeJtiEqual(JTI_A, JTI_A)).toBe(true)
    expect(timingSafeJtiEqual(JTI_A, JTI_B)).toBe(false)
    expect(timingSafeJtiEqual("short", JTI_A)).toBe(false)
  })
})
