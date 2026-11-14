/**
 * ADR-213 wariant A — trasa z sekretem w ścieżce
 * (`/hooks/notifications/brevo/<token>`). Token weryfikuje
 * `brevoHmacValidatorMiddleware` (matcher `/hooks/notifications/brevo*`), więc
 * handler jest tym samym handlerem co trasa bez tokenu.
 */
export { AUTHENTICATE, POST } from "../route"
