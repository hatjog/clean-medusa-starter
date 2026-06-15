import {
  fetchTranslationOverlay,
  overlayField,
} from "../../lib/translation-overlay"

describe("translation-overlay", () => {
  describe("overlayField", () => {
    it("returns the translated value when present and non-empty", () => {
      expect(
        overlayField("base", { description: "перекладено" }, "description")
      ).toBe("перекладено")
    })

    it("keeps the base value when the translation is absent, empty, or blank", () => {
      expect(overlayField("base", undefined, "description")).toBe("base")
      expect(overlayField("base", {}, "description")).toBe("base")
      expect(overlayField("base", { description: "" }, "description")).toBe("base")
      expect(overlayField("base", { description: "   " }, "description")).toBe("base")
      expect(overlayField(null, { description: 123 }, "description")).toBeNull()
    })
  })

  describe("fetchTranslationOverlay", () => {
    const makeScope = (listTranslations: jest.Mock) =>
      ({
        resolve: (key: string) => {
          if (key === "translation") {
            return { listTranslations }
          }
          throw new Error(`unexpected resolve: ${key}`)
        },
      }) as never

    it("returns an empty map without a locale (source locale → no overlay)", async () => {
      const listTranslations = jest.fn()
      const overlay = await fetchTranslationOverlay(
        makeScope(listTranslations),
        "seller",
        ["sel_1"],
        undefined
      )
      expect(overlay.size).toBe(0)
      expect(listTranslations).not.toHaveBeenCalled()
    })

    it("returns an empty map when there are no reference ids", async () => {
      const listTranslations = jest.fn()
      const overlay = await fetchTranslationOverlay(
        makeScope(listTranslations),
        "seller",
        [],
        "uk-UA"
      )
      expect(overlay.size).toBe(0)
      expect(listTranslations).not.toHaveBeenCalled()
    })

    it("maps translation records by reference_id for the requested locale", async () => {
      const listTranslations = jest.fn().mockResolvedValue([
        {
          reference_id: "sel_1",
          translations: { name: "Studio", description: "Опис" },
        },
        { reference_id: "sel_2", translations: { description: "Інший" } },
      ])

      const overlay = await fetchTranslationOverlay(
        makeScope(listTranslations),
        "seller",
        ["sel_1", "sel_2"],
        "uk-UA"
      )

      expect(listTranslations).toHaveBeenCalledWith({
        reference: "seller",
        reference_id: ["sel_1", "sel_2"],
        locale_code: "uk-UA",
      })
      expect(overlay.get("sel_1")).toEqual({ name: "Studio", description: "Опис" })
      expect(overlay.get("sel_2")).toEqual({ description: "Інший" })
    })

    it("fails open to an empty map when the translation module is not registered", async () => {
      const scope = {
        resolve: () => {
          throw new Error("module not registered")
        },
      } as never

      const overlay = await fetchTranslationOverlay(
        scope,
        "seller",
        ["sel_1"],
        "uk-UA"
      )
      expect(overlay.size).toBe(0)
    })

    it("fails open when resolve returns an object without listTranslations", async () => {
      const scope = { resolve: () => ({}) } as never
      const overlay = await fetchTranslationOverlay(
        scope,
        "seller",
        ["sel_1"],
        "uk-UA"
      )
      expect(overlay.size).toBe(0)
    })
  })
})
