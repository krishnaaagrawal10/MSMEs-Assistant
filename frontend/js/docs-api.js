/*
 * Documents API layer. The UI only ever talks to window.DocsApi.
 * DOCS_CONFIG.backend decides which adapter answers:
 *   "mock": stays inside this browser, works with no backend at all
 *   "http": calls the backend described in API_CONTRACT.md
 *
 * Both adapters expose exactly the same methods and return the same shapes,
 * so switching is a one-word config change and nothing else in the UI moves.
 *
 *   getVault()                    -> VaultParams | null
 *   putVault(params)              -> void
 *   deleteVault()                 -> void        (also deletes every stored copy)
 *   listDocuments()               -> DocumentRecord[]
 *   saveDocument(type, {verdict, encrypted?}) -> DocumentRecord
 *   getDocumentBlob(type)         -> { bytes: Uint8Array, iv_b64 }
 *   deleteDocument(type)          -> void
 *
 * DocumentRecord:
 *   { doc_type, status, detected_type, method, checked_at,
 *     has_encrypted_copy, size_bytes, iv_b64, updated_at }
 *   status is one of: "verified" | "needs_review" | "not_checked"
 */
(function (root) {
  "use strict";

  const cfg = root.DOCS_CONFIG;
  let ctx = {
    apiBase: "",
    getToken: () => null,
    getUserId: () => null,
    onUnauthorized: () => {},
  };

  function fail(message, extra) {
    const e = new Error(message);
    Object.assign(e, extra || {});
    return e;
  }

  // =====================================================================
  // MOCK adapter: browser only
  // =====================================================================
  const mock = (function () {
    const DB_NAME = "msmease_docs_mock";
    const uid = () => String(ctx.getUserId());
    const vaultKey = () => "msmease_vault:" + uid();
    const metaKey = () => "msmease_docs_meta:" + uid();

    function openDb() {
      return new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = () => req.result.createObjectStore("blobs");
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    }
    async function idb(mode, fn) {
      const db = await openDb();
      return new Promise((resolve, reject) => {
        const tx = db.transaction("blobs", mode);
        const store = tx.objectStore("blobs");
        const out = fn(store);
        tx.oncomplete = () => { db.close(); resolve(out && out.result); };
        tx.onerror = () => { db.close(); reject(tx.error); };
      });
    }
    const readMeta = () => JSON.parse(localStorage.getItem(metaKey()) || "{}");
    const writeMeta = (m) => localStorage.setItem(metaKey(), JSON.stringify(m));
    const blobId = (type) => uid() + ":" + type;

    return {
      async getVault() {
        const raw = localStorage.getItem(vaultKey());
        return raw ? JSON.parse(raw) : null;
      },
      async putVault(params) {
        if (localStorage.getItem(vaultKey())) throw fail("A vault already exists for this account.", { status: 409 });
        localStorage.setItem(vaultKey(), JSON.stringify(params));
      },
      async deleteVault() {
        const meta = readMeta();
        for (const type of Object.keys(meta)) await idb("readwrite", (s) => s.delete(blobId(type)));
        localStorage.removeItem(vaultKey());
        localStorage.removeItem(metaKey());
      },
      async listDocuments() {
        return Object.values(readMeta());
      },
      async saveDocument(type, { verdict, encrypted }) {
        const now = new Date().toISOString();
        const record = {
          doc_type: type,
          status: verdict.status,
          detected_type: verdict.detected_type || null,
          method: verdict.method || "none",
          checked_at: verdict.checked_at || now,
          has_encrypted_copy: !!encrypted,
          size_bytes: encrypted ? encrypted.bytes.length : null,
          iv_b64: encrypted ? encrypted.iv_b64 : null,
          updated_at: now,
        };
        if (encrypted) await idb("readwrite", (s) => s.put(encrypted.bytes.buffer.slice(encrypted.bytes.byteOffset, encrypted.bytes.byteOffset + encrypted.bytes.byteLength), blobId(type)));
        else await idb("readwrite", (s) => s.delete(blobId(type)));
        const meta = readMeta();
        meta[type] = record;
        writeMeta(meta);
        return record;
      },
      async getDocumentBlob(type) {
        const record = readMeta()[type];
        if (!record || !record.has_encrypted_copy) throw fail("No stored copy for this document.", { status: 404 });
        const buf = await idb("readonly", (s) => s.get(blobId(type)));
        if (!buf) throw fail("No stored copy for this document.", { status: 404 });
        return { bytes: new Uint8Array(buf), iv_b64: record.iv_b64 };
      },
      async deleteDocument(type) {
        await idb("readwrite", (s) => s.delete(blobId(type)));
        const meta = readMeta();
        delete meta[type];
        writeMeta(meta);
      },
    };
  })();

  // =====================================================================
  // HTTP adapter: the real backend (see API_CONTRACT.md)
  // =====================================================================
  const http = (function () {
    async function request(path, opts) {
      opts = opts || {};
      const headers = Object.assign({}, opts.headers || {});
      const token = ctx.getToken();
      if (token) headers["Authorization"] = "Bearer " + token;
      let res;
      try {
        res = await fetch(ctx.apiBase + path, Object.assign({}, opts, { headers }));
      } catch (e) {
        throw fail("Can't reach the server. If it was idle, wait about a minute and try again.", { network: true });
      }
      if (res.status === 401) {
        ctx.onUnauthorized();
        throw fail("Your session expired. Please log in again.", { status: 401 });
      }
      return res;
    }
    async function detail(res, fallback) {
      try {
        const body = await res.json();
        if (typeof body.detail === "string") return body.detail;
      } catch (e) { /* not JSON */ }
      return fallback;
    }
    function unavailable(res) {
      return [404, 405, 501].includes(res.status);
    }

    return {
      async getVault() {
        const res = await request("/api/vault");
        if (res.status === 404) return null;
        if (!res.ok) throw fail(await detail(res, "Could not load your vault."), { status: res.status });
        return res.json();
      },
      async putVault(params) {
        const res = await request("/api/vault", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(params),
        });
        if (!res.ok) throw fail(await detail(res, "Could not create your vault."), { status: res.status });
      },
      async deleteVault() {
        const res = await request("/api/vault", { method: "DELETE" });
        if (!res.ok && res.status !== 404) throw fail(await detail(res, "Could not reset your vault."), { status: res.status });
      },
      async listDocuments() {
        const res = await request("/api/documents");
        if (unavailable(res)) throw fail("The documents service isn't available yet.", { unavailable: true, status: res.status });
        if (!res.ok) throw fail(await detail(res, "Could not load your documents."), { status: res.status });
        return res.json();
      },
      async saveDocument(type, { verdict, encrypted }) {
        const form = new FormData();
        form.append("verdict", JSON.stringify(verdict));
        if (encrypted) {
          form.append("iv", encrypted.iv_b64);
          form.append("file", new Blob([encrypted.bytes], { type: "application/octet-stream" }), "blob");
        }
        const res = await request("/api/documents/" + encodeURIComponent(type), { method: "PUT", body: form });
        if (!res.ok) throw fail(await detail(res, "Could not save this document."), { status: res.status });
        return res.json();
      },
      async getDocumentBlob(type) {
        const list = await this.listDocuments();
        const record = list.find((r) => r.doc_type === type);
        if (!record || !record.has_encrypted_copy) throw fail("No stored copy for this document.", { status: 404 });
        const res = await request("/api/documents/" + encodeURIComponent(type) + "/blob");
        if (!res.ok) throw fail(await detail(res, "Could not download this document."), { status: res.status });
        return { bytes: new Uint8Array(await res.arrayBuffer()), iv_b64: record.iv_b64 };
      },
      async deleteDocument(type) {
        const res = await request("/api/documents/" + encodeURIComponent(type), { method: "DELETE" });
        if (!res.ok && res.status !== 404) throw fail(await detail(res, "Could not remove this document."), { status: res.status });
      },
    };
  })();

  const adapter = () => (cfg.backend === "http" ? http : mock);

  root.DocsApi = {
    /** Called once by app.js so the layer knows the server address and who is logged in. */
    configure(c) { ctx = Object.assign(ctx, c); },
    getVault: () => adapter().getVault(),
    putVault: (p) => adapter().putVault(p),
    deleteVault: () => adapter().deleteVault(),
    listDocuments: () => adapter().listDocuments(),
    saveDocument: (t, d) => adapter().saveDocument(t, d),
    getDocumentBlob: (t) => adapter().getDocumentBlob(t),
    deleteDocument: (t) => adapter().deleteDocument(t),
  };
})(window);
