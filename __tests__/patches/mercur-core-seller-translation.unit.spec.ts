const fs = require("fs")
const path = require("path")

describe("@mercurjs/core@2.1.1 patch - Seller translation metadata", () => {
  const patchPath = path.join(
    __dirname,
    "../../patches/@mercurjs__core@2.1.1.patch"
  )

  afterEach(() => {
    const { DmlEntity } = require("@medusajs/framework/utils")
    DmlEntity.clearTranslatableEntities()
  })

  it("patch dodaje natywne translatable() dla realnych pol Seller", () => {
    const content = fs.readFileSync(patchPath, "utf-8")

    expect(content).toContain(
      "diff --git a/.medusa/server/src/modules/seller/models/seller.js"
    )
    expect(content).toContain(
      "+    name: utils_1.model.text().searchable().translatable(),"
    )
    expect(content).toContain(
      "+    description: utils_1.model.text().translatable().nullable(),"
    )
    expect(content).not.toContain("+    bio:")
    expect(content).not.toContain("+    services:")
  })

  it("patch przekazuje req.locale do store seller query.graph", () => {
    const content = fs.readFileSync(patchPath, "utf-8")

    expect(content).toContain(
      "diff --git a/.medusa/server/src/api/store/sellers/route.js"
    )
    expect(content).toContain(
      "diff --git a/.medusa/server/src/api/store/sellers/[id]/route.js"
    )
    expect(content).toContain("+        locale: req.locale,")
  })

  it("DML Mercur rejestruje Seller.name i Seller.description jako tlumaczalne", () => {
    const { DmlEntity } = require("@medusajs/framework/utils")
    DmlEntity.clearTranslatableEntities()

    const sellerModelPath = path.join(
      __dirname,
      "../../node_modules/@mercurjs/core/.medusa/server/src/modules/seller/models/seller.js"
    )
    delete require.cache[require.resolve(sellerModelPath)]

    require(sellerModelPath)

    const seller = DmlEntity.getTranslatableEntities().find(
      (entry: { entity: string }) => entry.entity === "Seller"
    )

    expect(seller).toEqual({
      entity: "Seller",
      fields: ["name", "description"],
    })
  })
})
