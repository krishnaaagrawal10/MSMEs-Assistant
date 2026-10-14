/*
 * Vault: end-to-end encryption for stored documents.
 *
 * How it keeps documents private from everyone, including the developers:
 *  - The owner picks a vault passphrase. It is used only inside this browser.
 *    It is never sent anywhere, so the server cannot derive the key.
 *  - The key is derived with PBKDF2 (600,000 rounds) and kept in memory only,
 *    as a non-extractable CryptoKey. Reloading the page or logging out drops it.
 *  - Each file is encrypted with AES-256-GCM before it leaves the page. The
 *    file name and type are inside the encrypted envelope, so the server sees
 *    only random-looking bytes and a size.
 *  - Each ciphertext is bound to its document slot (GCM "additional data"), so
 *    a stored PAN blob cannot be swapped into the Aadhaar slot unnoticed.
 *
 * What the server stores for the vault itself: a random salt and a small
 * encrypted check value used to tell whether a typed passphrase is right.
 * If the passphrase is forgotten the documents cannot be recovered. That is
 * the price of nobody else being able to read them.
 */
(function (root) {
  "use strict";

  const ITERATIONS = 600000;
  const CHECK_TEXT = "msmease-vault-v1";
  const te = new TextEncoder();
  const td = new TextDecoder();
  const subtle = (root.crypto || {}).subtle;

  let key = null;

  function bytesToB64(bytes) {
    let s = "";
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      s += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(s);
  }
  function b64ToBytes(b64) {
    const s = atob(b64);
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out;
  }

  async function deriveKey(passphrase, salt, iterations) {
    if (!subtle) throw new Error("Secure storage needs a secure connection. Please open this site over HTTPS.");
    const base = await subtle.importKey("raw", te.encode(passphrase.normalize("NFKC")), "PBKDF2", false, ["deriveKey"]);
    return subtle.deriveKey(
      { name: "PBKDF2", salt, iterations, hash: "SHA-256" },
      base,
      { name: "AES-GCM", length: 256 },
      false, // not extractable
      ["encrypt", "decrypt"]
    );
  }

  async function seal(k, plain, aad) {
    const iv = root.crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(await subtle.encrypt({ name: "AES-GCM", iv, additionalData: te.encode(aad) }, k, plain));
    return { iv, ct };
  }
  async function open(k, ct, iv, aad) {
    return new Uint8Array(await subtle.decrypt({ name: "AES-GCM", iv, additionalData: te.encode(aad) }, k, ct));
  }

  /** Create a brand-new vault. Returns the public parameters to store on the server. */
  async function create(passphrase) {
    const salt = root.crypto.getRandomValues(new Uint8Array(16));
    const k = await deriveKey(passphrase, salt, ITERATIONS);
    const { iv, ct } = await seal(k, te.encode(CHECK_TEXT), "vault-check");
    key = k;
    return {
      version: 1,
      kdf: { name: "PBKDF2", hash: "SHA-256", iterations: ITERATIONS },
      salt_b64: bytesToB64(salt),
      check: { iv_b64: bytesToB64(iv), ciphertext_b64: bytesToB64(ct) },
    };
  }

  /** Unlock with the passphrase, using the parameters fetched from the server. */
  async function unlock(passphrase, params) {
    const k = await deriveKey(passphrase, b64ToBytes(params.salt_b64), params.kdf.iterations);
    try {
      const plain = await open(k, b64ToBytes(params.check.ciphertext_b64), b64ToBytes(params.check.iv_b64), "vault-check");
      if (td.decode(plain) !== CHECK_TEXT) throw new Error("bad check");
    } catch (e) {
      throw new Error("That passphrase is not correct.");
    }
    key = k;
  }

  function lock() { key = null; }
  function isUnlocked() { return key !== null; }

  /** Encrypt a File. The name and type travel inside the envelope. */
  async function encryptFile(file, slot) {
    if (!key) throw new Error("The vault is locked.");
    const header = te.encode(JSON.stringify({ v: 1, name: file.name, type: file.type, size: file.size }));
    const body = new Uint8Array(await file.arrayBuffer());
    const plain = new Uint8Array(4 + header.length + body.length);
    new DataView(plain.buffer).setUint32(0, header.length);
    plain.set(header, 4);
    plain.set(body, 4 + header.length);
    const { iv, ct } = await seal(key, plain, "doc:" + slot);
    return { iv_b64: bytesToB64(iv), bytes: ct };
  }

  /** Decrypt back into a Blob plus its original name and type. */
  async function decryptToBlob(bytes, iv_b64, slot) {
    if (!key) throw new Error("The vault is locked.");
    let plain;
    try {
      plain = await open(key, bytes, b64ToBytes(iv_b64), "doc:" + slot);
    } catch (e) {
      throw new Error("This copy could not be decrypted. It may be damaged or from a different vault.");
    }
    const hlen = new DataView(plain.buffer, plain.byteOffset).getUint32(0);
    const header = JSON.parse(td.decode(plain.subarray(4, 4 + hlen)));
    const body = plain.subarray(4 + hlen);
    return { blob: new Blob([body], { type: header.type || "application/octet-stream" }), name: header.name, type: header.type };
  }

  const Vault = { create, unlock, lock, isUnlocked, encryptFile, decryptToBlob, bytesToB64, b64ToBytes, ITERATIONS };
  root.Vault = Vault;
  if (typeof module !== "undefined" && module.exports) module.exports = Vault;
})(typeof window !== "undefined" ? window : globalThis);
