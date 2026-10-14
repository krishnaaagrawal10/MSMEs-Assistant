/*
 * Documents panel (New profile page) and the vault passphrase dialog.
 *
 * Upload flow for a slot:
 *   choose file -> read + check on this device -> (wrong document? stop)
 *   -> encrypt on this device -> DocsApi.saveDocument(verdict + ciphertext)
 *
 * The backend never receives the file contents, the numbers on it, or the
 * passphrase. See API_CONTRACT.md for exactly what it does receive.
 *
 * Public surface (used by app.js):
 *   DocsUI.onLogin(user)         load vault + document records for this user
 *   DocsUI.onLogout()            lock the vault and clear everything
 *   DocsUI.readiness(strings)    which of a rule's required documents are ready
 */
(function (root) {
  "use strict";

  const cfg = root.DOCS_CONFIG;
  const TYPES = root.DOC_TYPES;
  const $ = (sel, el) => (el || document).querySelector(sel);
  const esc = (v) => String(v == null ? "" : v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const typeOf = (id) => TYPES.find((t) => t.id === id);

  const S = {
    records: {},      // doc_type -> DocumentRecord (metadata only)
    slots: {},        // doc_type -> transient UI state (checking, mismatch, ...)
    vault: "unknown", // unknown | none | locked | unlocked | unavailable
    note: "",
    idleTimer: null,
  };
  let panel = null;
  let vaultMode = "create";
  let pendingUnlock = null;

  // ------------------------------------------------------------------ helpers
  function friendly(e) {
    if (e && e.code === "PASSWORD") return "This PDF is password protected. Please upload a photo or screenshot of the document instead.";
    if (e && e.code === "UNSUPPORTED") return "We couldn't open this file. Try a JPG, PNG or PDF.";
    if (e && e.code === "ENGINE_LOAD") return "The document reader couldn't load. Check your connection and try again.";
    return (e && e.message) || "Something went wrong. Please try again.";
  }
  function touchIdle() {
    clearTimeout(S.idleTimer);
    if (!root.Vault.isUnlocked()) return;
    S.idleTimer = setTimeout(lockNow, cfg.idleLockMinutes * 60 * 1000);
  }
  function lockNow() {
    clearTimeout(S.idleTimer);
    root.Vault.lock();
    if (S.vault === "unlocked") S.vault = "locked";
    renderAll();
  }
  function setSlot(id, state) { S.slots[id] = state; renderSlot(id); }

  // ------------------------------------------------------------------ rendering
  function renderAll() {
    if (!panel) return;
    renderVaultBar();
    TYPES.forEach((t) => renderSlot(t.id));
  }

  function mountSkeleton() {
    panel.innerHTML = `
      <div class="cardtitle">Your documents</div>
      <p class="section__sub docs__sub">Optional. Add what you already have and we'll show which documents each registration still needs.</p>
      <div class="privacy">
        <p class="privacy__lead"><strong>Private by design.</strong> Files are read and encrypted on your device. Our team and servers cannot open them.</p>
        <details>
          <summary>How this works</summary>
          <ul>
            <li>Each file is read and checked on your device. Its contents never leave it.</li>
            <li>Stored copies are encrypted with a vault passphrase that only you know. Our servers hold unreadable data.</li>
            <li>We only record whether each document looks correct, for example "Aadhaar: verified".</li>
            <li>We cannot reset your passphrase. If you forget it you can reset the vault, but stored copies are lost and you will upload them again.</li>
            <li>The check catches mix-ups such as a PAN card in the Aadhaar slot. It is not official identity verification.</li>
          </ul>
        </details>
      </div>
      <div class="vaultbar" id="vaultbar"></div>
      <div class="docgrid">${TYPES.map((t) => `<div class="docslot" data-slot="${esc(t.id)}"></div>`).join("")}</div>
    `;
  }

  function renderVaultBar() {
    const el = $("#vaultbar", panel);
    if (!el) return;
    let text, btn = "", cls = "";
    switch (S.vault) {
      case "none":
        text = "Set up a private vault to add documents. You choose a passphrase that never leaves your device.";
        btn = `<button type="button" class="btn btn--raised btn--sm" data-action="vault-setup">Set up vault</button>`;
        break;
      case "locked":
        text = "Your vault is locked. Unlock it to add or open documents.";
        btn = `<button type="button" class="btn btn--raised btn--sm" data-action="vault-unlock">Unlock</button>`;
        break;
      case "unlocked":
        text = "Vault unlocked for this session.";
        btn = `<button type="button" class="btn btn--raised btn--sm" data-action="vault-lock">Lock now</button>`;
        cls = " vaultbar--open";
        break;
      case "unavailable":
        text = esc(S.note || "Documents aren't available right now.");
        cls = " vaultbar--warn";
        break;
      default:
        text = "Checking your vault…";
    }
    el.className = "vaultbar" + cls;
    el.innerHTML = `<span class="vaultbar__dot" aria-hidden="true"></span><span class="vaultbar__text">${text}</span>${btn}`;
  }

  function renderSlot(id) {
    const el = panel && panel.querySelector(`[data-slot="${id}"].docslot`);
    if (!el) return;
    const t = typeOf(id);
    const st = S.slots[id] || {};
    const rec = S.records[id];
    const locked = S.vault !== "unlocked";
    const unavailable = S.vault === "unavailable";

    let pill = ["status-pill--notapplicable", "Not added"];
    let msg = esc(t.hint);
    let actions = "";
    let bar = "";
    const choose = (label) => `<button type="button" class="docbtn docbtn--primary" data-action="choose" data-slot="${id}"${unavailable ? " disabled" : ""}>${label}</button>`;

    if (st.phase === "checking") {
      pill = ["status-pill--checking", "Reading"];
      msg = esc(st.text || "Reading on your device…");
      bar = `<div class="docslot__bar"><span style="width:${Math.max(3, Math.min(100, st.pct || 3))}%"></span></div>`;
    } else if (st.phase === "saving") {
      pill = ["status-pill--checking", "Saving"];
      msg = "Encrypting and saving…";
      bar = `<div class="docslot__bar"><span style="width:96%"></span></div>`;
    } else if (st.phase === "mismatch") {
      pill = ["status-pill--bad", "Wrong document"];
      msg = `This looks like ${esc(st.label)}, not ${esc(root.DocVerify.LABELS[id] || t.label)}. Please choose the right file.`;
      actions = choose("Choose another file");
    } else if (st.phase === "review") {
      pill = ["status-pill--applicable", "Not confirmed"];
      msg = st.reason === "partial"
        ? "We could only partly confirm this document. A sharper, upright photo or the PDF works best."
        : "We couldn't read this clearly. Try a sharper, upright photo or the PDF.";
      actions = `<button type="button" class="docbtn docbtn--primary" data-action="keep" data-slot="${id}">Keep anyway</button>${choose("Choose another file")}`;
    } else if (st.phase === "error") {
      pill = ["status-pill--bad", "Problem"];
      msg = esc(st.error);
      actions = choose("Try again");
    } else if (rec) {
      const copy = rec.has_encrypted_copy ? " Encrypted copy stored." : "";
      if (rec.status === "verified") { pill = ["status-pill--registered", "Verified"]; msg = esc((st.note ? st.note + " " : "Checked on your device.") + copy); }
      else if (rec.status === "needs_review") { pill = ["status-pill--applicable", "Not confirmed"]; msg = "Kept, but we couldn't confirm what it is." + copy; }
      else { pill = ["status-pill--open", "Stored"]; msg = "Stored privately. Not checked." + copy; }
      actions =
        (rec.has_encrypted_copy ? `<button type="button" class="docbtn" data-action="open" data-slot="${id}">Open</button>` : "") +
        `<button type="button" class="docbtn" data-action="choose" data-slot="${id}"${unavailable ? " disabled" : ""}>Replace</button>` +
        `<button type="button" class="docbtn docbtn--quiet" data-action="remove" data-slot="${id}">Remove</button>`;
    } else {
      actions = choose(locked && !unavailable ? "Unlock to add" : "Choose file");
    }

    el.className = "docslot" + (st.drag ? " docslot--drag" : "");
    el.innerHTML = `
      <div class="docslot__top">
        <div class="docslot__title">${esc(t.label)}</div>
        <span class="status-pill ${pill[0]}">${pill[1]}</span>
      </div>
      <div class="docslot__msg">${msg}</div>
      ${bar}
      <div class="docslot__actions">${actions}</div>
      <input type="file" data-slot="${id}" hidden${t.accept ? ` accept="${esc(t.accept)}"` : ""}>
    `;
  }

  // ------------------------------------------------------------------ upload flow
  async function handleFile(id, file) {
    const t = typeOf(id);
    if (S.vault === "unavailable") return;
    if (S.vault !== "unlocked") return openVault(S.vault === "none" ? "create" : "unlock");
    touchIdle();

    if (file.size > cfg.maxFileMB * 1024 * 1024) {
      return setSlot(id, { phase: "error", error: `That file is larger than ${cfg.maxFileMB} MB.` });
    }
    if (!t.verify) {
      return persist(id, file, { status: "not_checked", detected_type: null, method: "none", checked_at: new Date().toISOString() });
    }
    const looksOk = /^image\//.test(file.type) || file.type === "application/pdf" || /\.(pdf|jpe?g|png|webp|gif|bmp)$/i.test(file.name);
    if (!looksOk) return setSlot(id, { phase: "error", error: "Please choose a photo (JPG or PNG) or a PDF." });

    setSlot(id, { phase: "checking", text: "Opening the file…", pct: 3 });
    try {
      const v = await root.DocVerify.check(file, id, (p) => setSlot(id, { phase: "checking", text: p.text, pct: p.pct }));
      if (v.status === "mismatch") return setSlot(id, { phase: "mismatch", label: v.label });
      if (v.status === "needs_review") return setSlot(id, { phase: "review", reason: v.reason, file, verdict: v });
      await persist(id, file, v);
    } catch (e) {
      setSlot(id, { phase: "error", error: friendly(e) });
    }
  }

  async function persist(id, file, v) {
    setSlot(id, { phase: "saving" });
    try {
      const encrypted = await root.Vault.encryptFile(file, id);
      // Only these four fields reach the server. No text, no numbers.
      const verdict = { status: v.status, detected_type: v.detected_type || null, method: v.method || "none", checked_at: v.checked_at || new Date().toISOString() };
      const rec = await root.DocsApi.saveDocument(id, { verdict, encrypted });
      S.records[id] = rec;
      const label = root.DocVerify.LABELS[v.detected_type];
      S.slots[id] = { note: v.status === "verified" && label ? `Looks like ${label}${v.last4 ? " ending " + v.last4 : ""}.` : "" };
      renderSlot(id);
      touchIdle();
    } catch (e) {
      setSlot(id, { phase: "error", error: friendly(e) });
    }
  }

  async function onOpen(id) {
    if (S.vault !== "unlocked") return openVault("unlock");
    touchIdle();
    const tab = root.open("", "_blank");
    try {
      const { bytes, iv_b64 } = await root.DocsApi.getDocumentBlob(id);
      const { blob, name } = await root.Vault.decryptToBlob(bytes, iv_b64, id);
      const url = URL.createObjectURL(blob);
      if (tab) tab.location.href = url;
      else { const a = document.createElement("a"); a.href = url; a.download = name || id; a.click(); }
      setTimeout(() => URL.revokeObjectURL(url), 120000);
    } catch (e) {
      if (tab) tab.close();
      setSlot(id, { phase: "error", error: friendly(e) });
    }
  }

  async function onRemove(id) {
    if (!root.confirm(`Remove "${typeOf(id).label}"? The stored copy is deleted.`)) return;
    try {
      await root.DocsApi.deleteDocument(id);
      delete S.records[id];
      S.slots[id] = {};
      renderSlot(id);
    } catch (e) {
      setSlot(id, { phase: "error", error: friendly(e) });
    }
  }

  function onChoose(id) {
    if (S.vault === "unavailable" || S.vault === "unknown") return;
    if (S.vault === "none") return openVault("create");
    if (S.vault === "locked") return openVault("unlock");
    const input = panel.querySelector(`input[type=file][data-slot="${id}"]`);
    if (input) input.click();
  }

  function onKeep(id) {
    const st = S.slots[id];
    if (!st || !st.file) return;
    persist(id, st.file, { status: "needs_review", detected_type: st.verdict.detected_type, method: st.verdict.method, checked_at: st.verdict.checked_at });
  }

  // ------------------------------------------------------------------ vault dialog
  function openVault(mode) {
    vaultMode = mode;
    const create = mode === "create";
    $("#vault-title").textContent = create ? "Set up your vault" : "Unlock your vault";
    $("#vault-desc").textContent = create
      ? `Choose a passphrase of at least ${cfg.vaultMinLength} characters. It encrypts your documents on this device and is never sent to us, so we cannot recover it for you.`
      : "Enter your vault passphrase to add or open documents.";
    $("#vault-submit").textContent = create ? "Create vault" : "Unlock";
    $("#vault-confirm-row").classList.toggle("hidden", !create);
    $("#vault-pass2").required = create;
    $("#vault-reset-row").classList.toggle("hidden", create);
    $("#vault-pass").setAttribute("autocomplete", create ? "new-password" : "current-password");
    $("#vault-pass").value = "";
    $("#vault-pass2").value = "";
    $("#vault-error").classList.add("hidden");
    $("#vault-backdrop").classList.remove("hidden");
    $("#vault-pass").focus();
  }
  function closeVault() {
    $("#vault-backdrop").classList.add("hidden");
    $("#vault-pass").value = "";
    $("#vault-pass2").value = "";
  }

  async function onVaultSubmit(e) {
    e.preventDefault();
    const err = $("#vault-error");
    const btn = $("#vault-submit");
    const label = btn.textContent;
    const pass = $("#vault-pass").value;
    err.classList.add("hidden");
    btn.disabled = true;
    btn.textContent = "Working…";
    try {
      if (vaultMode === "create") {
        if (pass.length < cfg.vaultMinLength) throw new Error(`Use at least ${cfg.vaultMinLength} characters.`);
        if (pass !== $("#vault-pass2").value) throw new Error("The two passphrases don't match.");
        const params = await root.Vault.create(pass);
        try { await root.DocsApi.putVault(params); } catch (e2) { root.Vault.lock(); throw e2; }
      } else {
        const params = await root.DocsApi.getVault();
        if (!params) { S.vault = "none"; renderAll(); throw new Error("No vault found. Please set one up."); }
        await root.Vault.unlock(pass, params);
      }
      S.vault = "unlocked";
      touchIdle();
      closeVault();
      renderAll();
      root.DocVerify.warmUp();   // load the reader now so the first upload feels fast
      if (pendingUnlock) { pendingUnlock(); pendingUnlock = null; }
    } catch (e3) {
      err.textContent = friendly(e3);
      err.classList.remove("hidden");
    } finally {
      btn.disabled = false;
      btn.textContent = label;
    }
  }

  async function onVaultReset() {
    if (!root.confirm("Reset your vault? All stored document copies are permanently deleted and cannot be recovered. You can then set a new passphrase and upload again.")) return;
    try {
      await root.DocsApi.deleteVault();
      root.Vault.lock();
      S.records = {};
      S.slots = {};
      S.vault = "none";
      closeVault();
      renderAll();
    } catch (e) {
      const err = $("#vault-error");
      err.textContent = friendly(e);
      err.classList.remove("hidden");
    }
  }

  // ------------------------------------------------------------------ session
  async function onLogin(user) {
    S.records = {};
    S.slots = {};
    S.vault = "unknown";
    S.note = "";
    root.Vault.lock();
    renderAll();
    try {
      const [params, list] = await Promise.all([root.DocsApi.getVault(), root.DocsApi.listDocuments()]);
      S.vault = params ? "locked" : "none";
      S.records = {};
      list.forEach((r) => { S.records[r.doc_type] = r; });
    } catch (e) {
      S.vault = "unavailable";
      S.note = e.unavailable ? "The documents service isn't available yet." : friendly(e);
    }
    renderAll();
  }

  function onLogout() {
    clearTimeout(S.idleTimer);
    root.Vault.lock();
    S.records = {};
    S.slots = {};
    S.vault = "unknown";
    closeVault();
    renderAll();
  }

  /** Which of a rule's required documents are already verified. */
  function readiness(list) {
    const items = (list || []).map((text) => {
      const t = TYPES.find((x) => x.ruleMatch && x.ruleMatch.test(text));
      const rec = t && S.records[t.id];
      return { text, typeId: t ? t.id : null, ready: !!(rec && rec.status === "verified") };
    });
    return { items, readyCount: items.filter((i) => i.ready).length, trackable: items.filter((i) => i.typeId).length };
  }

  // ------------------------------------------------------------------ wiring
  function init() {
    panel = document.getElementById("docs-panel");
    if (!panel) return;
    mountSkeleton();
    renderAll();

    panel.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-action]");
      if (!btn || btn.disabled) return;
      const id = btn.dataset.slot;
      switch (btn.dataset.action) {
        case "vault-setup": return openVault("create");
        case "vault-unlock": return openVault("unlock");
        case "vault-lock": return lockNow();
        case "choose": return onChoose(id);
        case "open": return onOpen(id);
        case "remove": return onRemove(id);
        case "keep": return onKeep(id);
      }
    });
    panel.addEventListener("change", (e) => {
      if (!e.target.matches("input[type=file][data-slot]")) return;
      const file = e.target.files[0];
      const id = e.target.dataset.slot;
      e.target.value = "";
      if (file) handleFile(id, file);
    });
    panel.addEventListener("dragover", (e) => {
      const slot = e.target.closest(".docslot");
      if (!slot) return;
      e.preventDefault();
      slot.classList.add("docslot--drag");
    });
    panel.addEventListener("dragleave", (e) => {
      const slot = e.target.closest(".docslot");
      if (slot && !slot.contains(e.relatedTarget)) slot.classList.remove("docslot--drag");
    });
    panel.addEventListener("drop", (e) => {
      const slot = e.target.closest(".docslot");
      if (!slot) return;
      e.preventDefault();
      slot.classList.remove("docslot--drag");
      const file = e.dataTransfer.files[0];
      if (file) handleFile(slot.dataset.slot, file);
    });

    $("#vault-form").addEventListener("submit", onVaultSubmit);
    $("#vault-close").addEventListener("click", closeVault);
    $("#vault-reset").addEventListener("click", onVaultReset);
    $("#vault-backdrop").addEventListener("click", (e) => { if (e.target.id === "vault-backdrop") closeVault(); });
    document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeVault(); });
  }

  root.DocsUI = { onLogin, onLogout, readiness, _state: S };
  init();
})(window);
