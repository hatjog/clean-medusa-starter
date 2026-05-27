import { createHash, timingSafeEqual } from "crypto"

import type { Knex } from "knex"

const UUID_LENGTH = 36
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export type SellerJtiLookupResult = {
  found: boolean
  subject_seller_id: string | null
}

type MagicLinkIssuedSellerRow = {
  token_jti?: string | null
  subject_seller_id?: string | null
  subject?: Record<string, unknown> | null
}

function fixedUuidBuffer(value: string): Buffer {
  const normalized = value.toLowerCase()
  const buffer = Buffer.alloc(UUID_LENGTH, "0")
  buffer.write(normalized.slice(0, UUID_LENGTH), 0, UUID_LENGTH, "utf8")
  return buffer
}

export function timingSafeJtiEqual(left: string, right: string): boolean {
  const leftValid = UUID_RE.test(left)
  const rightValid = UUID_RE.test(right)
  const equal = timingSafeEqual(fixedUuidBuffer(left), fixedUuidBuffer(right))
  return leftValid && rightValid && equal
}

function resolveSubjectSellerId(row: MagicLinkIssuedSellerRow | undefined): string | null {
  const direct = row?.subject_seller_id
  if (typeof direct === "string" && direct.trim()) {
    return direct.trim()
  }

  const nested = row?.subject?.seller_id
  return typeof nested === "string" && nested.trim() ? nested.trim() : null
}

export function hashSellerId(value: string): string {
  return createHash("sha256").update(value).digest("hex")
}

export async function lookupSellerJti(
  db: Knex,
  jti: string
): Promise<SellerJtiLookupResult> {
  const row = await db("magic_link_issued")
    .select("token_jti", "subject_seller_id", "subject")
    .where({ token_jti: jti })
    .first<MagicLinkIssuedSellerRow>()

  const rowJti = typeof row?.token_jti === "string" ? row.token_jti : ""
  const subjectSellerId = resolveSubjectSellerId(row)
  const matched = timingSafeJtiEqual(rowJti, jti)

  return {
    found: matched && Boolean(subjectSellerId),
    subject_seller_id: matched ? subjectSellerId : null,
  }
}
