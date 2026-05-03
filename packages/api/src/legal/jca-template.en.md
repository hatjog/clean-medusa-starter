# Joint Controller Agreement

> **DRAFT — pending legal team review pre-Phase-B-activation.**
> This template provides operational scaffolding for the 8 sections
> mandated by GDPR art. 26. Final language subject to legal review.

**Version**: {{ jca_version }}
**Generated**: {{ generation_date }}
**Signed**: {{ signed_date_placeholder }}

---

## 1. Parties identification

**Joint Controller A (BonBeauty)**
- Name: {{ controller.name }}
- Legal address: {{ controller.legal_address }}
- Tax ID: {{ controller.tax_id }}

**Joint Controller B (Vendor)**
- Name: {{ vendor.name }}
- Legal address: {{ vendor.legal_address }}
- Tax ID: {{ vendor.tax_id }}

## 2. Subject matter and duration

This agreement governs joint processing of personal data within the BonBeauty
multi-vendor platform from {{ flag_flip_date }} indefinitely, terminable per
section 8.

## 3. Roles and responsibilities (split)

- BonBeauty: platform operation, general security, admin access control, data
  retention per DPIA §3.
- Vendor: offer accuracy, customer communication, service delivery, quality
  of data entered into the platform.

## 4. Data subjects and categories of personal data

- **Subjects**: end customers (natural persons using the platform).
- **Categories**: first name, last name, email, phone, service delivery
  address, booking history, service preferences.
- **Excluded**: special categories (GDPR art. 9) unless voluntarily disclosed
  by customer in service delivery context.

## 5. Security measures

- Encryption at rest (PostgreSQL TDE) and in transit (TLS 1.3+).
- Role-based access control (RBAC) — vendor sees only own customers.
- Tamper-evident access audit (hash chain).
- Backup retention per DPIA §5.

## 6. Sub-processors policy

- BonBeauty maintains an approved sub-processor list (PostgreSQL hosting, CDN,
  email/SMS providers). Vendor receives 30-day notice of changes.
- Vendor MAY NOT engage own sub-processors without prior BonBeauty consent.

## 7. Data subject rights handling

- Contact point for GDPR art. 15-22 requests: BonBeauty.
- Vendor obligated to cooperate within 7 business days on request fulfilment
  (e.g. deletion, export, rectification).
- Requests forwarded by BonBeauty to vendor address via ticket workflow.

## 8. Termination and signature blocks

Either party may terminate with 90-day notice. Upon termination, vendor
loses access to customer data; historical data remains in BonBeauty archive
per retention policy.

**BonBeauty signature:** _______________________
Name: _______________________
Date: _______________________

**Vendor signature:** _______________________
Name: {{ vendor.name }}
Date: {{ signed_date_placeholder }}
