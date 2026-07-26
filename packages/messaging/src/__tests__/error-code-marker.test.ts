/**
 * error-code-marker.test.ts — Story 2.3, R-2.3-M3.
 *
 * Marker jest jedynym nośnikiem kodu błędu, który przeżywa DWA opakowania
 * Medusy (`MedusaError` bez `code` + `promiseAll({ aggregateErrors: true })`
 * → zwykły `Error`). Bez niego wiersz `failed` w ledgerze dostaje kod
 * generyczny i traci wartość dla triage'u.
 */

import { extractErrorCodeMarker, formatErrorCodeMarker } from "../errors";

describe("marker kodu błędu (R-2.3-M3)", () => {
  it("marker jest odczytywalny z komunikatu po przepakowaniu przez Medusę", () => {
    const providerMessage =
      `[notification-brevo] dispatch failed for template 'voucher_purchase_confirmation': ` +
      `${formatErrorCodeMarker("BREVO_TEMPLATE_NOT_CONFIGURED")} BREVO_TEMPLATE_NOT_CONFIGURED`;
    const medusaWrapped = `Failed to send notification with id noti_01:\n${providerMessage}`;
    const aggregated = `${medusaWrapped}\ninny błąd`;

    expect(extractErrorCodeMarker(aggregated)).toBe("BREVO_TEMPLATE_NOT_CONFIGURED");
  });

  it("brak markera → `null` (wołający decyduje o fallbacku, marker nic nie zmyśla)", () => {
    expect(extractErrorCodeMarker("Failed to send notification with id noti_01")).toBeNull();
    expect(extractErrorCodeMarker(undefined)).toBeNull();
    expect(extractErrorCodeMarker(42)).toBeNull();
  });

  it("marker akceptuje wyłącznie kształt kodu (`[A-Z0-9_]+`) — nie wciąga treści", () => {
    expect(extractErrorCodeMarker("[gp_error_code=kupujaca@example.test]")).toBeNull();
    expect(extractErrorCodeMarker("[gp_error_code=FLOW_DISABLED]")).toBe("FLOW_DISABLED");
  });

  it("format i parser są wzajemnie odwrotne", () => {
    for (const code of ["FLOW_DISABLED", "BREVO_DISPATCH_FAILED", "X1"]) {
      expect(extractErrorCodeMarker(formatErrorCodeMarker(code))).toBe(code);
    }
  });
});
