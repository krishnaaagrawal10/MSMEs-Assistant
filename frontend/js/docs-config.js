/*
 * Documents feature: configuration.
 *
 * BACKEND SWITCH
 *   "mock"  Everything stays inside this browser (IndexedDB + localStorage).
 *           Use this until the backend endpoints exist. No server needed.
 *   "http"  Talks to the real backend. See API_CONTRACT.md for the exact
 *           endpoints, request bodies and responses to implement.
 *
 * To add a new document type, add one entry to DOC_TYPES below. If it can be
 * checked automatically, also add a detector for its id in docs-verify.js.
 */
(function () {
  window.DOCS_CONFIG = {
    backend: "http",           // "mock" | "http"
    maxFileMB: 8,              // per file
    vaultMinLength: 10,        // minimum vault passphrase length
    ocrDir: "assets/ocr/",     // self-hosted OCR engine (nothing is sent to third parties)
    pdfDir: "assets/pdfjs/",   // self-hosted PDF reader
    idleLockMinutes: 15,       // vault locks itself after this much inactivity
  };

  /*
   * id         stored on the server as doc_type (keep these stable)
   * verify     true  = read on-device and check it really is this document
   *            false = stored privately, not checked
   * ruleMatch  matches the wording used in compliance_data.json "documents"
   *            lists, so the dashboard can show which documents are ready
   */
  window.DOC_TYPES = [
    { id: "aadhaar", label: "Aadhaar card", hint: "Photo or PDF. A masked Aadhaar is fine.", verify: true,  accept: "image/*,application/pdf", ruleMatch: /aadhaa?r/i },
    { id: "pan",     label: "PAN card",     hint: "Photo or PDF of the card or e-PAN.",       verify: true,  accept: "image/*,application/pdf", ruleMatch: /\bpan\b/i },
    { id: "gst",     label: "GST certificate", hint: "Registration certificate, photo or PDF.", verify: true, accept: "image/*,application/pdf", ruleMatch: /\bgstin?\b/i },
    { id: "udyam",   label: "Udyam certificate", hint: "MSME registration certificate.",     verify: true,  accept: "image/*,application/pdf", ruleMatch: /udyam/i },
    { id: "bank",    label: "Bank proof",   hint: "Cancelled cheque or passbook first page.", verify: true, accept: "image/*,application/pdf", ruleMatch: /\bbank\b|cheque|passbook/i },
    { id: "other",   label: "Other document", hint: "Any file type. Stored privately, not checked.", verify: false, accept: "", ruleMatch: null },
  ];
})();
