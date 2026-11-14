/**
 * v1.16.0 Story 3.5 AC1 (DW-15-134): NUMERIC jako łańcuch, zamiana na liczbę
 * dokładna albo odmowa — nigdy przez float.
 */
import {
  numericMinorStringToSafeInteger,
  readDatabaseMinorInteger,
  readDatabaseMinorIntegerStrict,
  readNumericMinorString,
} from "../../../lib/payment/numeric-minor"

describe("numeric-minor (Story 3.5 AC1)", () => {
  it("string z node-pg zostaje łańcuchem (typ i wartość)", () => {
    const v = readNumericMinorString("12345.00")
    expect(typeof v).toBe("string")
    expect(v).toBe("12345.00")
    expect(readNumericMinorString("9007199254740993")).toBe("9007199254740993")
  })

  it("wartość nieczytelna ⇒ null, nie zero", () => {
    expect(readNumericMinorString("nie-liczba")).toBeNull()
    expect(readNumericMinorString("")).toBeNull()
    expect(readNumericMinorString(null)).toBeNull()
    expect(readNumericMinorString(Number.NaN)).toBeNull()
    expect(readNumericMinorString(2 ** 60)).toBeNull()
  })

  it("dokładna zamiana: obcięcie ułamka na łańcuchu, odmowa poza bezpiecznym zakresem", () => {
    expect(numericMinorStringToSafeInteger("12345.00")).toBe(12345)
    expect(numericMinorStringToSafeInteger("25000.5")).toBe(25000)
    expect(numericMinorStringToSafeInteger("9007199254740991")).toBe(9007199254740991)
    expect(numericMinorStringToSafeInteger("9007199254740993")).toBeNull()
    expect(numericMinorStringToSafeInteger("-0.5")).toBe(0)
    expect(readDatabaseMinorInteger(" 42 ")).toBe(42)
  })

  it("wariant ścisły odrzuca ułamek grosza", () => {
    expect(readDatabaseMinorIntegerStrict("15000.00")).toBe(15000)
    expect(readDatabaseMinorIntegerStrict("150.50")).toBeNull()
    expect(readDatabaseMinorIntegerStrict("9007199254740993")).toBeNull()
  })
})
