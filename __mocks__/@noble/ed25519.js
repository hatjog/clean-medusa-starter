/**
 * Jest manual mock for @noble/ed25519 v2.x.
 *
 * @noble/ed25519 v2 is ESM-only and cannot be required() by Jest in CJS mode.
 * This mock provides the same sync API surface backed by Node's built-in crypto,
 * which supports Ed25519 natively since Node 15+.
 *
 * Used ONLY in test environments — production code uses the real @noble/ed25519.
 */

const crypto = require("node:crypto")

/**
 * Verify an Ed25519 signature.
 * @param {Uint8Array} sig - 64-byte signature
 * @param {Uint8Array} msg - message bytes
 * @param {Uint8Array} pub - 32-byte raw public key
 * @returns {boolean}
 */
function verify(sig, msg, pub) {
  // Build SPKI DER from raw 32-byte public key
  const SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex")
  const der = Buffer.concat([SPKI_PREFIX, Buffer.from(pub)])
  const keyObj = crypto.createPublicKey({ key: der, format: "der", type: "spki" })
  try {
    return crypto.verify(null, Buffer.from(msg), keyObj, Buffer.from(sig))
  } catch {
    return false
  }
}

/**
 * Sign a message (sync).
 * @param {Uint8Array} msg - message bytes
 * @param {Uint8Array} priv - 32-byte raw private key
 * @returns {Uint8Array} 64-byte signature
 */
function sign(msg, priv) {
  const PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex")
  const der = Buffer.concat([PKCS8_PREFIX, Buffer.from(priv)])
  const keyObj = crypto.createPrivateKey({ key: der, format: "der", type: "pkcs8" })
  return new Uint8Array(crypto.sign(null, Buffer.from(msg), keyObj))
}

/**
 * Derive public key from private key (sync).
 * @param {Uint8Array} priv - 32-byte raw private key
 * @returns {Uint8Array} 32-byte raw public key
 */
function getPublicKey(priv) {
  const PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex")
  const der = Buffer.concat([PKCS8_PREFIX, Buffer.from(priv)])
  const privKey = crypto.createPrivateKey({ key: der, format: "der", type: "pkcs8" })
  const pubKey = crypto.createPublicKey(privKey)
  const pubDer = pubKey.export({ format: "der", type: "spki" })
  return new Uint8Array(pubDer.subarray(pubDer.length - 32))
}

/**
 * Generate a random private key.
 * @returns {Uint8Array} 32-byte private key
 */
function randomPrivateKey() {
  return crypto.randomBytes(32)
}

/**
 * etc namespace (sha512Sync shim needed in some setups).
 */
const etc = {
  sha512Sync: null,
  concatBytes: (...arrays) => {
    const total = arrays.reduce((acc, a) => acc + a.length, 0)
    const result = new Uint8Array(total)
    let offset = 0
    for (const a of arrays) {
      result.set(a, offset)
      offset += a.length
    }
    return result
  },
}

const utils = { randomPrivateKey }

module.exports = { verify, sign, getPublicKey, randomPrivateKey, etc, utils }
