// Shared augmentation: locale propagated do MedusaRequest przez middleware
// (Story 2.2 SDK header `x-medusa-locale` -> request scope, ADR-124 + D-102).
// Pozwala usunąć inline cast `(req as MedusaRequest & { locale?: string }).locale`
// w handlerach API.

import "@medusajs/framework/http"

declare module "@medusajs/framework/http" {
  interface MedusaRequest {
    locale?: string
  }
}
