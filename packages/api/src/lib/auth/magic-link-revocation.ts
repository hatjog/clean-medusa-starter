import type { Knex } from "knex"

import {
  generateMagicLink,
  getMagicLinkSubjectEmail,
  getMagicLinkSubjectCustomerId,
  getMagicLinkSubjectMarketId,
  getMagicLinkSubjectSellerId,
  isValidMagicLinkJti as isValidJwtMagicLinkJti,
  type GeneratedMagicLink,
  type MagicLinkOptions,
  type MagicLinkPurpose,
  type MagicLinkRuntimeBindings,
  type MagicLinkSubject,
} from "./magic-link"

export type MagicLinkRevocationReason =
  | "user_revoke"
  | "admin_revoke"
  | "seller_revoke"
  | "auto_expired"
  | "security_response"

export type MagicLinkRevocationActorType = "customer" | "admin" | "seller"

export type RecordIssuedMagicLinkInput = {
  token_jti: string
  purpose: MagicLinkPurpose
  subject?: MagicLinkSubject | null
  subject_customer_id?: string | null
  subject_seller_id?: string | null
  subject_email?: string | null
  market_id?: string | null
  issued_at: Date
  expires_at: Date
}

export type RevokeMagicLinkInput = {
  token_jti: string
  reason: MagicLinkRevocationReason
  revoked_by?: string | null
  actor_type?: MagicLinkRevocationActorType | null
}

export type RevokePendingCustomerMagicLinksInput = {
  customer_id: string
  customer_email?: string | null
  market_id: string
  reason: "user_revoke"
  revoked_by: string
  actor_type?: "customer"
  now?: Date
}

export type MagicLinkRevocationStore = {
  isJtiRevoked(jti: string): Promise<boolean>
  recordIssued(input: RecordIssuedMagicLinkInput): Promise<void>
  revokeJti(input: RevokeMagicLinkInput): Promise<void>
  revokePendingForCustomer(
    input: RevokePendingCustomerMagicLinksInput
  ): Promise<{ revoked_count: number }>
  cleanupExpiredRevocations(): Promise<number>
  cleanupExpiredIssued(): Promise<number>
}

export const MAGIC_LINK_REVOCATION_RETENTION_DAYS = 30

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export function isValidMagicLinkJti(value: string): boolean {
  return UUID_RE.test(value) && isValidJwtMagicLinkJti(value)
}

export function shouldDeleteMagicLinkRevocation(
  revokedAt: Date,
  now: Date
): boolean {
  const cutoff =
    now.getTime() -
    MAGIC_LINK_REVOCATION_RETENTION_DAYS * 24 * 60 * 60 * 1000

  return revokedAt.getTime() < cutoff
}

function toNullableString(value: string | null): string | null {
  return value && value.trim() ? value.trim() : null
}

function normalizeEmail(value: string | null | undefined): string | null {
  const normalized = value?.trim().toLowerCase()
  return normalized ? normalized : null
}

export class PostgresMagicLinkStore implements MagicLinkRevocationStore {
  constructor(private readonly db: Knex) {}

  async isJtiRevoked(jti: string): Promise<boolean> {
    const row = await this.db("magic_link_revocation")
      .select("token_jti")
      .where({ token_jti: jti })
      .first<{ token_jti: string }>()

    return Boolean(row?.token_jti)
  }

  async recordIssued(input: RecordIssuedMagicLinkInput): Promise<void> {
    await this.db("magic_link_issued")
      .insert({
        token_jti: input.token_jti,
        purpose: input.purpose,
        subject: input.subject ?? null,
        subject_customer_id: toNullableString(input.subject_customer_id ?? null),
        subject_seller_id: toNullableString(input.subject_seller_id ?? null),
        subject_email: normalizeEmail(input.subject_email),
        market_id: toNullableString(input.market_id ?? null),
        issued_at: input.issued_at,
        expires_at: input.expires_at,
      })
      .onConflict("token_jti")
      .ignore()
  }

  async revokeJti(input: RevokeMagicLinkInput): Promise<void> {
    await this.db("magic_link_revocation")
      .insert({
        token_jti: input.token_jti,
        reason: input.reason,
        revoked_by: input.revoked_by ?? null,
        actor_type: input.actor_type ?? null,
      })
      .onConflict("token_jti")
      .ignore()
  }

  async revokePendingForCustomer(
    input: RevokePendingCustomerMagicLinksInput
  ): Promise<{ revoked_count: number }> {
    if (!input.market_id.trim()) {
      throw new Error("market_id is required for magic link revoke-all")
    }

    const customerEmail = normalizeEmail(input.customer_email)
    const rows = await this.db("magic_link_issued as issued")
      .leftJoin(
        "magic_link_revocation as revoked",
        "issued.token_jti",
        "revoked.token_jti"
      )
      .select<{ token_jti: string }[]>("issued.token_jti")
      .whereRaw(
        [
          "(",
          "issued.subject_customer_id = ?",
          "OR issued.subject->>'customer_id' = ?",
          "OR (? IS NOT NULL AND issued.subject_email = ?)",
          "OR (? IS NOT NULL AND lower(issued.subject->>'email') = ?)",
          ")",
        ].join(" "),
        [
          input.customer_id,
          input.customer_id,
          customerEmail,
          customerEmail,
          customerEmail,
          customerEmail,
        ]
      )
      .where("issued.expires_at", ">", input.now ?? new Date())
      .whereRaw("(issued.market_id = ? OR issued.market_id IS NULL)", [
        input.market_id.trim(),
      ])
      .whereNull("revoked.token_jti")

    if (rows.length === 0) {
      return { revoked_count: 0 }
    }

    await this.db("magic_link_revocation")
      .insert(
        rows.map((row) => ({
          token_jti: row.token_jti,
          reason: input.reason,
          revoked_by: input.revoked_by,
          actor_type: input.actor_type ?? "customer",
        }))
      )
      .onConflict("token_jti")
      .ignore()

    return { revoked_count: rows.length }
  }

  async cleanupExpiredRevocations(): Promise<number> {
    const deleted = await this.db("magic_link_revocation")
      .whereRaw("revoked_at < now() - interval '30 days'")
      .delete()

    return Number(deleted ?? 0)
  }

  async cleanupExpiredIssued(): Promise<number> {
    const deleted = await this.db("magic_link_issued")
      .whereRaw("expires_at < now()")
      .delete()

    return Number(deleted ?? 0)
  }
}

function recordIssuedFromGenerated(
  store: Pick<MagicLinkRevocationStore, "recordIssued">,
  generated: GeneratedMagicLink
): Promise<void> {
  return store.recordIssued({
    token_jti: generated.claims.jti,
    purpose: generated.claims.purpose,
    subject: generated.claims.subject,
    subject_customer_id: getMagicLinkSubjectCustomerId(generated.claims.subject),
    subject_seller_id: getMagicLinkSubjectSellerId(generated.claims.subject),
    subject_email: getMagicLinkSubjectEmail(generated.claims.subject),
    market_id: getMagicLinkSubjectMarketId(generated.claims.subject),
    issued_at: new Date(generated.claims.iat * 1000),
    expires_at: new Date(generated.claims.exp * 1000),
  })
}

export function createMagicLinkRuntimeBindings(
  store: Pick<MagicLinkRevocationStore, "isJtiRevoked" | "recordIssued">
): Required<MagicLinkRuntimeBindings> {
  return {
    isJtiRevoked: (jti) => store.isJtiRevoked(jti),
    recordIssued: (generated) => recordIssuedFromGenerated(store, generated),
  }
}

export async function issueMagicLink(
  store: Pick<MagicLinkRevocationStore, "recordIssued">,
  purpose: MagicLinkPurpose,
  subject: MagicLinkSubject,
  options: MagicLinkOptions = {}
): Promise<string> {
  return generateMagicLink(purpose, subject, {
    ...options,
    recordIssued: (generated) =>
      recordIssuedFromGenerated(store, generated),
  })
}
