/**
 * Unit tests for formatCurrency helper (IP-4, Story 1.9)
 */

import { formatCurrency } from "../../lib/format";

describe("formatCurrency", () => {
  it("formats 0 grosze as PLN", () => {
    expect(formatCurrency(0)).toMatch(/0[,.]00/);
  });

  it("formats 1000 grosze (10 PLN)", () => {
    const result = formatCurrency(1000);
    expect(result).toContain("10");
    expect(result).toContain("00");
    expect(result).toContain("zł");
  });

  it("formats 100000 grosze (1000 PLN) with thousands separator", () => {
    const result = formatCurrency(100000);
    // pl-PL uses non-breaking space as thousands separator
    expect(result).toMatch(/1[\s\u00a0]?000/);
    expect(result).toContain("zł");
  });

  it("formats 1 grosz correctly", () => {
    const result = formatCurrency(1);
    expect(result).toMatch(/0[,.]01/);
  });

  it("formats 99 grosze correctly", () => {
    const result = formatCurrency(99);
    expect(result).toMatch(/0[,.]99/);
  });

  it("defaults to PLN when no currency specified", () => {
    const result = formatCurrency(500);
    expect(result).toContain("zł");
  });

  it("supports EUR currency", () => {
    const result = formatCurrency(1000, "EUR");
    expect(result).toContain("10");
    expect(result).toMatch(/EUR|€/);
  });

  it("supports USD currency", () => {
    const result = formatCurrency(2550, "USD");
    expect(result).toContain("25");
    expect(result).toMatch(/USD|\$/);
  });
});
