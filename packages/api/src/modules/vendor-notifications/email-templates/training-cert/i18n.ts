/**
 * Story v160-7-6: Training cert email copy (3 states × PL+EN).
 *
 * States: pending (admin notified of new upload), approved (vendor confirmed),
 * rejected (vendor receives reason + re-upload instructions).
 */

export type TrainingCertLocale = "pl" | "en"
export type TrainingCertState = "pending" | "approved" | "rejected"

export interface TrainingCertCopy {
  subject: string
  preheader: string
  greeting: string
  body: string
  cta_label: string
  footer: string
}

export const TRAINING_CERT_PENDING_EMAIL_COPY: Record<
  TrainingCertLocale,
  TrainingCertCopy
> = {
  pl: {
    subject:
      "Nowy certyfikat szkoleniowy do weryfikacji — vendor {{ vendor_name }}",
    preheader:
      "Vendor uploadował certyfikat szkolenia. Sprawdź w kolejce review.",
    greeting: "Cześć adminie,",
    body: [
      "Vendor {{ vendor_name }} ({{ vendor_email }}) uploadował certyfikat szkoleniowy.",
      "",
      "Status: oczekuje na weryfikację.",
      "Data uploadu: {{ uploaded_at }}",
      "",
      "Przejdź do kolejki review aby zatwierdzić lub odrzucić.",
    ].join("\n"),
    cta_label: "Otwórz kolejkę review",
    footer:
      "Powiadomienie automatyczne BonBeauty multi-vendor. Pytania: {{ contact_email }}.",
  },
  en: {
    subject:
      "New training cert pending review — vendor {{ vendor_name }}",
    preheader:
      "Vendor uploaded training certificate. Check the review queue.",
    greeting: "Hi admin,",
    body: [
      "Vendor {{ vendor_name }} ({{ vendor_email }}) uploaded a training certificate.",
      "",
      "Status: pending review.",
      "Uploaded at: {{ uploaded_at }}",
      "",
      "Go to the review queue to approve or reject.",
    ].join("\n"),
    cta_label: "Open review queue",
    footer:
      "Automated notification from BonBeauty multi-vendor. Questions: {{ contact_email }}.",
  },
}

export const TRAINING_CERT_APPROVED_EMAIL_COPY: Record<
  TrainingCertLocale,
  TrainingCertCopy
> = {
  pl: {
    subject: "Certyfikat szkoleniowy zatwierdzony",
    preheader: "Twój certyfikat został zweryfikowany. Zobacz następne kroki.",
    greeting: "Cześć {{ vendor_name }},",
    body: [
      "Twój certyfikat szkoleniowy został zatwierdzony.",
      "",
      "Data zatwierdzenia: {{ reviewed_at }}",
      "",
      "Następne kroki:",
      "• To była jedna z bramek pre-flag-flip; admin uruchomi ostateczną aktywację.",
      "• Otrzymasz powiadomienie gdy salon zostanie przełączony na multi-vendor.",
    ].join("\n"),
    cta_label: "Wróć do dashboardu",
    footer:
      "Pytania? Napisz na {{ contact_email }}.",
  },
  en: {
    subject: "Training certificate approved",
    preheader:
      "Your certificate has been verified. See next steps.",
    greeting: "Hi {{ vendor_name }},",
    body: [
      "Your training certificate has been approved.",
      "",
      "Approved at: {{ reviewed_at }}",
      "",
      "Next steps:",
      "• This was one of the pre-flag-flip gates; admin will trigger final activation.",
      "• You'll be notified when your salon switches to multi-vendor.",
    ].join("\n"),
    cta_label: "Back to dashboard",
    footer:
      "Questions? Email {{ contact_email }}.",
  },
}

export const TRAINING_CERT_REJECTED_EMAIL_COPY: Record<
  TrainingCertLocale,
  TrainingCertCopy
> = {
  pl: {
    subject:
      "Certyfikat szkoleniowy odrzucony — wymagana ponowna wysyłka",
    preheader:
      "Twój certyfikat został odrzucony. Sprawdź powód i wgraj ponownie.",
    greeting: "Cześć {{ vendor_name }},",
    body: [
      "Twój certyfikat szkoleniowy został odrzucony.",
      "",
      "Data review: {{ reviewed_at }}",
      "Powód odrzucenia: {{ rejection_reason }}",
      "",
      "Następne kroki:",
      "• Wgraj ponownie certyfikat w panelu vendora.",
      "• Upewnij się, że plik jest czytelny (PDF / JPG / PNG, max 10 MB).",
    ].join("\n"),
    cta_label: "Wgraj ponownie",
    footer:
      "Pytania? Napisz na {{ contact_email }}.",
  },
  en: {
    subject:
      "Training certificate rejected — re-upload required",
    preheader:
      "Your certificate was rejected. See reason and re-upload.",
    greeting: "Hi {{ vendor_name }},",
    body: [
      "Your training certificate was rejected.",
      "",
      "Reviewed at: {{ reviewed_at }}",
      "Rejection reason: {{ rejection_reason }}",
      "",
      "Next steps:",
      "• Re-upload the certificate in the vendor panel.",
      "• Ensure the file is legible (PDF / JPG / PNG, max 10 MB).",
    ].join("\n"),
    cta_label: "Re-upload",
    footer:
      "Questions? Email {{ contact_email }}.",
  },
}

export interface TrainingCertContext {
  vendor_name: string
  vendor_email?: string
  uploaded_at?: string
  reviewed_at?: string
  rejection_reason?: string
  contact_email: string
}

function hydrate(text: string, ctx: TrainingCertContext): string {
  return text
    .replace(/\{\{\s*vendor_name\s*\}\}/g, ctx.vendor_name ?? "")
    .replace(/\{\{\s*vendor_email\s*\}\}/g, ctx.vendor_email ?? "")
    .replace(/\{\{\s*uploaded_at\s*\}\}/g, ctx.uploaded_at ?? "")
    .replace(/\{\{\s*reviewed_at\s*\}\}/g, ctx.reviewed_at ?? "")
    .replace(/\{\{\s*rejection_reason\s*\}\}/g, ctx.rejection_reason ?? "")
    .replace(/\{\{\s*contact_email\s*\}\}/g, ctx.contact_email)
}

function getCopy(
  state: TrainingCertState,
  locale: TrainingCertLocale,
): TrainingCertCopy {
  switch (state) {
    case "pending":
      return TRAINING_CERT_PENDING_EMAIL_COPY[locale]
    case "approved":
      return TRAINING_CERT_APPROVED_EMAIL_COPY[locale]
    case "rejected":
      return TRAINING_CERT_REJECTED_EMAIL_COPY[locale]
  }
}

export function renderTrainingCertSubject(
  state: TrainingCertState,
  locale: TrainingCertLocale,
  ctx: TrainingCertContext,
): string {
  return hydrate(getCopy(state, locale).subject, ctx)
}

export function renderTrainingCertText(
  state: TrainingCertState,
  locale: TrainingCertLocale,
  ctx: TrainingCertContext,
): string {
  const copy = getCopy(state, locale)
  return [
    hydrate(copy.greeting, ctx),
    "",
    hydrate(copy.body, ctx),
    "",
    "---",
    hydrate(copy.footer, ctx),
  ].join("\n")
}
