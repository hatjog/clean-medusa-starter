/**
 * json-schema-lite.ts — minimalny interpreter JSON Schema Draft 2020-12 do testów
 * kontraktowych w backendzie (v1.16.0 Story 4.1).
 *
 * Dlaczego nie `ajv`: nie jest zadeklarowaną zależnością `@gp/api`; import przez
 * hoisting pnpm byłby mechanizmem działającym przypadkiem. Ten interpreter obsługuje
 * DOKŁADNIE podzbiór słów kluczowych użyty w `specs/contracts/recovery/schemas/*`:
 * type (także lista), required, properties, additionalProperties(false), enum, const,
 * oneOf, allOf, anyOf, not, if/then/else, minimum, minLength, minItems, pattern,
 * items, $ref (lokalny `#/$defs/...` i międzyplikowy `<plik>#/$defs/...`).
 *
 * Nieznane słowo kluczowe WALIDUJĄCE jest błędem (throw), nie cichym PASS-em —
 * inaczej rozszerzenie schemy o słowo, którego tu nie ma, dałoby zieleń bez pomiaru.
 * Bramką SSOT pozostaje `_grow/tools/validate_recovery_contract.py` (pełny jsonschema);
 * ten plik służy parytetowi konsumenta i mutantom po stronie TS.
 */

export type JsonSchema = Record<string, unknown>

const IGNORED_KEYWORDS = new Set([
  "$schema",
  "$id",
  "$comment",
  "title",
  "description",
  "examples",
  "$defs",
  "format",
])

const KNOWN_KEYWORDS = new Set([
  "type",
  "required",
  "properties",
  "additionalProperties",
  "enum",
  "const",
  "oneOf",
  "allOf",
  "anyOf",
  "not",
  "if",
  "then",
  "else",
  "minimum",
  "minLength",
  "minItems",
  "pattern",
  "items",
  "$ref",
])

export type SchemaFamily = Record<string, JsonSchema>

export class LiteValidator {
  private readonly family: SchemaFamily

  constructor(family: SchemaFamily) {
    this.family = family
  }

  /** Zwraca listę naruszeń (pusta = zgodne). */
  validate(schemaName: string, data: unknown): string[] {
    const schema = this.family[schemaName]
    if (!schema) {
      throw new Error(`json-schema-lite: brak schemy "${schemaName}" w rodzinie`)
    }
    const errors: string[] = []
    this.check(schema, data, "$", schemaName, errors)
    return errors
  }

  private resolveRef(ref: string, currentFile: string): { schema: JsonSchema; file: string } {
    const [filePart, pointer] = ref.split("#")
    const file = filePart === "" ? currentFile : filePart
    const root = this.family[file]
    if (!root) {
      throw new Error(`json-schema-lite: $ref do nieznanego pliku "${file}"`)
    }
    if (!pointer) {
      return { schema: root, file }
    }
    const segments = pointer.split("/").filter((s) => s.length > 0)
    let node: unknown = root
    for (const seg of segments) {
      if (typeof node !== "object" || node === null || !(seg in (node as Record<string, unknown>))) {
        throw new Error(`json-schema-lite: nierozwiązywalny $ref "${ref}"`)
      }
      node = (node as Record<string, unknown>)[seg]
    }
    return { schema: node as JsonSchema, file }
  }

  private matches(schema: JsonSchema, data: unknown, file: string): boolean {
    const errs: string[] = []
    this.check(schema, data, "$", file, errs)
    return errs.length === 0
  }

  private check(schema: JsonSchema, data: unknown, path: string, file: string, errors: string[]): void {
    for (const key of Object.keys(schema)) {
      if (!IGNORED_KEYWORDS.has(key) && !KNOWN_KEYWORDS.has(key)) {
        throw new Error(`json-schema-lite: nieobsługiwane słowo kluczowe "${key}" pod ${path} — rozszerz interpreter zamiast liczyć na cichy PASS`)
      }
    }

    if (typeof schema.$ref === "string") {
      const resolved = this.resolveRef(schema.$ref, file)
      this.check(resolved.schema, data, path, resolved.file, errors)
    }

    if (schema.type !== undefined) {
      const types = Array.isArray(schema.type) ? (schema.type as string[]) : [schema.type as string]
      if (!types.some((t) => typeMatches(t, data))) {
        errors.push(`${path}: typ ${describeType(data)} nie należy do [${types.join(", ")}]`)
        return
      }
    }

    if (schema.const !== undefined && !deepEqual(schema.const, data)) {
      errors.push(`${path}: oczekiwano const ${JSON.stringify(schema.const)}, jest ${JSON.stringify(data)}`)
    }

    if (Array.isArray(schema.enum) && !(schema.enum as unknown[]).some((v) => deepEqual(v, data))) {
      errors.push(`${path}: wartość ${JSON.stringify(data)} poza enum`)
    }

    if (typeof data === "string") {
      if (typeof schema.minLength === "number" && data.length < schema.minLength) {
        errors.push(`${path}: długość ${data.length} < minLength ${schema.minLength}`)
      }
      if (typeof schema.pattern === "string" && !new RegExp(schema.pattern, "u").test(data)) {
        errors.push(`${path}: "${data}" nie pasuje do wzorca ${schema.pattern}`)
      }
    }

    if (typeof data === "number" && typeof schema.minimum === "number" && data < schema.minimum) {
      errors.push(`${path}: ${data} < minimum ${schema.minimum}`)
    }

    if (Array.isArray(data)) {
      if (typeof schema.minItems === "number" && data.length < schema.minItems) {
        errors.push(`${path}: ${data.length} elementów < minItems ${schema.minItems}`)
      }
      if (schema.items && typeof schema.items === "object") {
        data.forEach((item, idx) => this.check(schema.items as JsonSchema, item, `${path}[${idx}]`, file, errors))
      }
    }

    if (isPlainObject(data)) {
      const obj = data as Record<string, unknown>
      const props = (schema.properties as Record<string, JsonSchema> | undefined) ?? {}
      if (Array.isArray(schema.required)) {
        for (const req of schema.required as string[]) {
          if (!(req in obj)) {
            errors.push(`${path}: brak wymaganego pola "${req}"`)
          }
        }
      }
      for (const [name, sub] of Object.entries(props)) {
        if (name in obj) {
          this.check(sub, obj[name], `${path}.${name}`, file, errors)
        }
      }
      if (schema.additionalProperties === false) {
        for (const name of Object.keys(obj)) {
          if (!(name in props)) {
            errors.push(`${path}: nieznane pole "${name}" (additionalProperties: false)`)
          }
        }
      }
    }

    if (Array.isArray(schema.allOf)) {
      for (const sub of schema.allOf as JsonSchema[]) {
        this.check(sub, data, path, file, errors)
      }
    }

    if (Array.isArray(schema.anyOf)) {
      const ok = (schema.anyOf as JsonSchema[]).some((sub) => this.matches(sub, data, file))
      if (!ok) {
        errors.push(`${path}: żadna gałąź anyOf nie pasuje`)
      }
    }

    if (Array.isArray(schema.oneOf)) {
      const branches = schema.oneOf as JsonSchema[]
      const perBranch = branches.map((sub) => {
        const errs: string[] = []
        this.check(sub, data, path, file, errs)
        return errs
      })
      const matching = perBranch.filter((errs) => errs.length === 0).length
      if (matching !== 1) {
        errors.push(`${path}: oneOf — pasuje ${matching} gałęzi, oczekiwano dokładnie 1`)
        if (matching === 0) {
          // Gałąź „najbliższa": ta, której discriminator (properties.*.const) zgadza się
          // z danymi; w braku discriminatora — z najmniejszą liczbą błędów. Jej błędy
          // wchodzą do raportu, żeby mutant był nazwany po polu, a nie po „żadna gałąź".
          const closest = pickClosestBranch(branches, perBranch, data)
          for (const e of perBranch[closest]) {
            errors.push(`${path} (oneOf#${closest}) ${e}`)
          }
        }
      }
    }

    if (schema.not && typeof schema.not === "object") {
      if (this.matches(schema.not as JsonSchema, data, file)) {
        errors.push(`${path}: wartość pasuje do zakazanej schemy (not)`)
      }
    }

    if (schema.if && typeof schema.if === "object") {
      const cond = this.matches(schema.if as JsonSchema, data, file)
      const branch = cond ? schema.then : schema.else
      if (branch && typeof branch === "object") {
        this.check(branch as JsonSchema, data, path, file, errors)
      }
    }
  }
}

function pickClosestBranch(branches: JsonSchema[], perBranch: string[][], data: unknown): number {
  if (isPlainObject(data)) {
    const obj = data as Record<string, unknown>
    for (let i = 0; i < branches.length; i++) {
      const props = (branches[i].properties as Record<string, JsonSchema> | undefined) ?? {}
      const discriminators = Object.entries(props).filter(([, sub]) => sub.const !== undefined)
      if (discriminators.length > 0 && discriminators.every(([name, sub]) => deepEqual(sub.const, obj[name]))) {
        return i
      }
    }
  }
  let best = 0
  for (let i = 1; i < perBranch.length; i++) {
    if (perBranch[i].length < perBranch[best].length) best = i
  }
  return best
}

function typeMatches(type: string, data: unknown): boolean {
  switch (type) {
    case "object":
      return isPlainObject(data)
    case "array":
      return Array.isArray(data)
    case "string":
      return typeof data === "string"
    case "integer":
      return typeof data === "number" && Number.isInteger(data)
    case "number":
      return typeof data === "number"
    case "boolean":
      return typeof data === "boolean"
    case "null":
      return data === null
    default:
      throw new Error(`json-schema-lite: nieznany typ "${type}"`)
  }
}

function isPlainObject(value: unknown): boolean {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function describeType(data: unknown): string {
  if (data === null) return "null"
  if (Array.isArray(data)) return "array"
  return typeof data
}

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}
