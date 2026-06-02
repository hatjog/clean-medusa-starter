import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"

import {
  isVoucherAppointmentIcsStorageKey,
} from "../../../../modules/voucher-delivery"
import {
  getHmacSecret,
  verifySignedToken,
} from "../../../../modules/voucher-delivery/storage/hmac"
import type { IVoucherPdfStorage } from "../../../../modules/voucher-delivery/storage/ports"

export const AUTHENTICATE = false

const STORAGE_CONTAINER_KEY = "voucher_pdf_storage"

function resolveStorage(req: MedusaRequest): IVoucherPdfStorage | null {
  try {
    return req.scope.resolve(STORAGE_CONTAINER_KEY) as IVoucherPdfStorage
  } catch {
    return null
  }
}

function filenameFromStorageKey(storageKey: string): string {
  const candidate = storageKey.split("/").pop() ?? "bonbeauty-appointment.ics"
  return /^[A-Za-z0-9_.-]+\.ics$/.test(candidate)
    ? candidate
    : "bonbeauty-appointment.ics"
}

export async function GET(
  req: MedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const token = (req.params as { token?: string })?.token ?? ""
  const verified = token
    ? verifySignedToken(token, getHmacSecret())
    : null

  if (!verified || !isVoucherAppointmentIcsStorageKey(verified.storage_key)) {
    res.status(404).json({
      type: "not_found",
      message: "Calendar file not found.",
    })
    return
  }

  const storage = resolveStorage(req)
  if (!storage) {
    res.status(503).json({
      type: "service_unavailable",
      message: "Calendar storage unavailable.",
    })
    return
  }

  const artifact = await storage.retrieve(verified.storage_key)
  if (!artifact) {
    res.status(404).json({
      type: "not_found",
      message: "Calendar file not found.",
    })
    return
  }

  res.setHeader("Content-Type", "text/calendar; charset=utf-8")
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="${filenameFromStorageKey(verified.storage_key)}"`,
  )
  res.status(200).send(artifact.pdf_buffer)
}
