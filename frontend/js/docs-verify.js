/*
 * Document verification, entirely on the owner's device.
 *
 * The file is read in this browser (a PDF's own text when it has one,
 * otherwise OCR with a self-hosted Tesseract). The text is then scored
 * against what each document type contains. Only the resulting verdict
 * ("this is an Aadhaar", "this looks like a PAN", "couldn't tell") ever
 * leaves this file. The text and the numbers in it are discarded.
 *
 * What it can and cannot promise:
 *  - It catches honest mistakes: a PAN uploaded in the Aadhaar slot, a
 *    blurry photo, the wrong page.
 *  - It is NOT identity verification. It does not check a number against
 *    the government's records, and a determined person can fake a document
 *    or tamper with this script. For guidance on what a business still needs,
 *    that is fine. It must not be used as proof of identity.
 */
(function (root) {
  "use strict";

  const LABELS = {
    aadhaar: "an Aadhaar card",
    pan: "a PAN card",
    gst: "a GST certificate",
    udyam: "an Udyam certificate",
    bank: "a bank document",
  };

  // ------------------------------------------------------------------
  // Aadhaar numbers carry a Verhoeff check digit, so a misread digit
  // or a made-up number is detectable without any lookup.
  // ------------------------------------------------------------------
  const D = [[0,1,2,3,4,5,6,7,8,9],[1,2,3,4,0,6,7,8,9,5],[2,3,4,0,1,7,8,9,5,6],[3,4,0,1,2,8,9,5,6,7],[4,0,1,2,3,9,5,6,7,8],[5,9,8,7,6,0,4,3,2,1],[6,5,9,8,7,1,0,4,3,2],[7,6,5,9,8,2,1,0,4,3],[8,7,6,5,9,3,2,1,0,4],[9,8,7,6,5,4,3,2,1,0]];
  const P = [[0,1,2,3,4,5,6,7,8,9],[1,5,7,6,2,8,3,0,9,4],[5,8,0,3,7,9,6,1,4,2],[8,9,1,6,0,4,3,5,2,7],[9,4,5,3,1,2,6,8,7,0],[4,2,8,6,5,7,3,9,0,1],[2,7,9,3,8,0,6,4,1,5],[7,0,4,6,9,1,3,2,5,8]];
  const INV = [0,4,3,2,1,5,6,7,8,9];

  function verhoeffValid(num) {
    let c = 0;
    const a = String(num).split("").reverse().map(Number);
    for (let i = 0; i < a.length; i++) c = D[c][P[i % 8][a[i]]];
    return c === 0;
  }
  function verhoeffCheckDigit(base) {
    let c = 0;
    const a = String(base).split("").reverse().map(Number);
    for (let i = 0; i < a.length; i++) c = D[c][P[(i + 1) % 8][a[i]]];
    return INV[c];
  }

  // ------------------------------------------------------------------
  // PAN: AAAAA9999A. OCR confuses O/0, I/1, S/5, B/8, so repair the
  // characters by position before testing the structure.
  // The 4th letter is the holder type (P person, C company, ...).
  // ------------------------------------------------------------------
  const TO_LETTER = { "0": "O", "1": "I", "5": "S", "8": "B", "2": "Z", "6": "G" };
  const TO_DIGIT = { O: "0", Q: "0", D: "0", I: "1", L: "1", S: "5", B: "8", Z: "2", G: "6" };
  function fixPanToken(tok) {
    if (tok.length !== 10) return null;
    let out = "";
    for (let i = 0; i < 10; i++) {
      const ch = tok[i];
      if (i < 5 || i === 9) out += /[0-9]/.test(ch) ? (TO_LETTER[ch] || ch) : ch;
      else out += /[A-Z]/.test(ch) ? (TO_DIGIT[ch] || ch) : ch;
    }
    return /^[A-Z]{5}[0-9]{4}[A-Z]$/.test(out) && "PCHFATBLJG".includes(out[3]) ? out : null;
  }

  // ------------------------------------------------------------------
  // Score the text against each document type.
  // 3 or more = confident. Strong signals alone reach 3 (the printed
  // title, a valid ID format); weaker ones add up.
  // ------------------------------------------------------------------
  function classify(rawText) {
    const text = String(rawText || "").toUpperCase();
    const compact = text.replace(/[^A-Z0-9]/g, "");
    const tokens = text.split(/[^A-Z0-9]+/).filter(Boolean);
    const norm = (s) => s.toUpperCase().replace(/[^A-Z0-9]/g, "");
    const has = (...phrases) => phrases.some((p) => compact.includes(norm(p)));
    const countHas = (phrases) => phrases.filter((p) => compact.includes(norm(p))).length;

    const scores = { aadhaar: 0, pan: 0, gst: 0, udyam: 0, bank: 0 };
    const last4 = {};

    // ---- Aadhaar
    if (has("UNIQUE IDENTIFICATION AUTHORITY", "AADHAAR", "AADHAR", "UIDAI")) scores.aadhaar += 3;
    if (has("YEAR OF BIRTH", "ENROLMENT", "DOB", "VID")) scores.aadhaar += 1;
    const full = /(?<![\d] ?)([2-9]\d{3})[\s-]?(\d{4})[\s-]?(\d{4})(?![ -]?\d)/g; // not inside a longer number (the 16-digit VID)
    let m, bestAadhaar = null;
    while ((m = full.exec(text)) !== null) {
      const digits = m[1] + m[2] + m[3];
      if (verhoeffValid(digits)) { bestAadhaar = { digits, valid: true }; break; }
      if (!bestAadhaar) bestAadhaar = { digits, valid: false };
    }
    if (bestAadhaar) {
      scores.aadhaar += bestAadhaar.valid ? 2 : 1;
      last4.aadhaar = bestAadhaar.digits.slice(-4);
    } else {
      const masked = /[X*]{4}[\s-]?[X*]{4}[\s-]?(\d{4})/.exec(text);
      if (masked) { scores.aadhaar += 2; last4.aadhaar = masked[1]; }
    }

    // ---- PAN
    if (has("PERMANENT ACCOUNT NUMBER", "INCOME TAX DEPARTMENT")) scores.pan += 3;
    if (has("FATHER'S NAME", "DATE OF BIRTH")) scores.pan += 1;
    for (const tok of tokens) {
      const pan = fixPanToken(tok);
      if (pan) { scores.pan += 2; last4.pan = pan.slice(-4); break; }
    }

    // ---- GST certificate (GSTIN is 15 characters and embeds the PAN)
    if (tokens.some((t) => /^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(t))) scores.gst += 3;
    if (has("GOODS AND SERVICES TAX")) scores.gst += 3;
    if (has("REGISTRATION CERTIFICATE")) scores.gst += 1;
    if (has("GSTIN")) scores.gst += 1;

    // ---- Udyam certificate
    if (/UDYAM[A-Z]{2}\d{9}/.test(compact)) scores.udyam += 4;
    if (has("UDYAM REGISTRATION CERTIFICATE")) scores.udyam += 3;
    if (has("MINISTRY OF MICRO SMALL AND MEDIUM ENTERPRISES")) scores.udyam += 1;

    // ---- Bank proof (cancelled cheque / passbook)
    if (tokens.some((t) => /^[A-Z]{4}0[A-Z0-9]{6}$/.test(t))) scores.bank += 2;
    scores.bank += Math.min(3, countHas(["IFSC", "ACCOUNT NO", "ACCOUNT NUMBER", "A/C", "CHEQUE", "PASSBOOK", "BRANCH"]));

    return { scores, last4 };
  }

  function maxScore(c) { return Math.max.apply(null, Object.values(c.scores)); }

  /** Turn the scores into a verdict for the slot the owner uploaded into. */
  function verdictFor(slot, c) {
    const mine = c.scores[slot] || 0;
    const others = Object.entries(c.scores).filter(([k]) => k !== slot).sort((a, b) => b[1] - a[1]);
    const [otherId, otherScore] = others[0] || [null, 0];

    if (otherScore >= 3 && otherScore > mine) {
      return { status: "mismatch", reason: "wrong_document", detected_type: otherId, label: LABELS[otherId] };
    }
    if (mine >= 3) {
      return { status: "verified", reason: "ok", detected_type: slot, last4: c.last4[slot] || null };
    }
    return { status: "needs_review", reason: mine >= 2 ? "partial" : "unreadable", detected_type: mine >= 2 ? slot : null };
  }

  // ------------------------------------------------------------------
  // Reading the file (browser only)
  // ------------------------------------------------------------------
  const cfg = () => root.DOCS_CONFIG;
  const absUrl = (rel) => new URL(rel, document.baseURI).href;
  const codeErr = (code, msg) => Object.assign(new Error(msg || code), { code });

  const scriptCache = {};
  function loadScript(src) {
    if (!scriptCache[src]) {
      scriptCache[src] = new Promise((resolve, reject) => {
        const s = document.createElement("script");
        s.src = src;
        s.onload = resolve;
        s.onerror = () => { delete scriptCache[src]; reject(codeErr("ENGINE_LOAD", "Could not load the reader.")); };
        document.head.appendChild(s);
      });
    }
    return scriptCache[src];
  }

  let workerPromise = null;
  let progressHook = null;
  async function getWorker() {
    if (!workerPromise) {
      workerPromise = (async () => {
        await loadScript(absUrl(cfg().ocrDir + "tesseract.min.js"));
        return root.Tesseract.createWorker("eng", 1, {
          workerPath: absUrl(cfg().ocrDir + "worker.min.js"),
          corePath: absUrl(cfg().ocrDir),
          langPath: absUrl(cfg().ocrDir).replace(/\/$/, ""),
          logger: (m) => progressHook && progressHook(m),
        });
      })().catch((e) => { workerPromise = null; throw e.code ? e : codeErr("ENGINE_LOAD", "Could not load the reader."); });
    }
    return workerPromise;
  }

  async function recognize(canvas, psm) {
    const worker = await getWorker();
    await worker.setParameters({ tessedit_pageseg_mode: psm });
    const { data } = await worker.recognize(canvas, {}, { text: true }); // text only: skips unused hOCR/TSV output
    return data.text || "";
  }

  /** Grayscale + contrast stretch. Helps OCR on phone photos. */
  function enhance(canvas) {
    const g = canvas.getContext("2d", { willReadFrequently: true });
    const img = g.getImageData(0, 0, canvas.width, canvas.height);
    const d = img.data;
    const hist = new Uint32Array(256);
    for (let i = 0; i < d.length; i += 4) {
      const v = (d[i] * 299 + d[i + 1] * 587 + d[i + 2] * 114) / 1000 | 0;
      d[i] = d[i + 1] = d[i + 2] = v;
      hist[v]++;
    }
    const total = canvas.width * canvas.height;
    let acc = 0, lo = 0, hi = 255;
    for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= total * 0.02) { lo = v; break; } }
    acc = 0;
    for (let v = 255; v >= 0; v--) { acc += hist[v]; if (acc >= total * 0.02) { hi = v; break; } }
    if (hi - lo > 30) {
      const k = 255 / (hi - lo);
      for (let i = 0; i < d.length; i += 4) {
        const v = Math.max(0, Math.min(255, (d[i] - lo) * k));
        d[i] = d[i + 1] = d[i + 2] = v;
      }
    }
    g.putImageData(img, 0, 0);
  }

  async function imageToCanvas(file) {
    let bmp;
    try { bmp = await createImageBitmap(file); }
    catch (e) { throw codeErr("UNSUPPORTED", "Could not open this image."); }
    const long = Math.max(bmp.width, bmp.height);
    const target = cfg().ocrTargetPx || 1400;   // OCR time grows with pixels; this is the speed/accuracy dial
    let scale = 1;
    if (long > target * 1.5) scale = (target * 1.5) / long;
    else if (long < target) scale = Math.min(3, target / long);
    const c = document.createElement("canvas");
    c.width = Math.max(1, Math.round(bmp.width * scale));
    c.height = Math.max(1, Math.round(bmp.height * scale));
    c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
    if (bmp.close) bmp.close();
    enhance(c);
    return c;
  }

  async function openPdf(file) {
    await loadScript(absUrl(cfg().pdfDir + "pdf.min.js"));
    root.pdfjsLib.GlobalWorkerOptions.workerSrc = absUrl(cfg().pdfDir + "pdf.worker.min.js");
    const data = new Uint8Array(await file.arrayBuffer());
    try {
      return await root.pdfjsLib.getDocument({ data }).promise;
    } catch (e) {
      if (e && e.name === "PasswordException") throw codeErr("PASSWORD", "This PDF is password protected.");
      throw codeErr("UNSUPPORTED", "Could not open this PDF.");
    }
  }
  async function pdfText(pdf) {
    let out = "";
    for (let i = 1; i <= Math.min(2, pdf.numPages); i++) {
      const page = await pdf.getPage(i);
      const content = await page.getTextContent();
      out += content.items.map((it) => it.str).join(" ") + "\n";
    }
    return out;
  }
  async function pdfCanvas(pdf) {
    const page = await pdf.getPage(1);
    const base = page.getViewport({ scale: 1 });
    const scale = Math.max(1, Math.min(3, ((cfg().ocrTargetPx || 1400) * 1.2) / base.width));
    const vp = page.getViewport({ scale });
    const c = document.createElement("canvas");
    c.width = Math.round(vp.width);
    c.height = Math.round(vp.height);
    await page.render({ canvasContext: c.getContext("2d"), viewport: vp }).promise;
    enhance(c);
    return c;
  }

  /**
   * Check a file against the slot it was uploaded into.
   * onProgress({ text, pct }) is called so the UI can show what is happening.
   * Resolves to a verdict. Rejects with an Error that has .code for
   * PASSWORD, UNSUPPORTED, ENGINE_LOAD.
   */
  async function check(file, slot, onProgress) {
    const say = (text, pct) => onProgress && onProgress({ text, pct });
    const isPdf = file.type === "application/pdf" || /\.pdf$/i.test(file.name);
    let text = "";
    let canvas;

    say("Opening the file…", 3);
    if (isPdf) {
      const pdf = await openPdf(file);
      text = await pdfText(pdf);               // many PDFs carry real text: no OCR needed
      const quick = classify(text);
      if (maxScore(quick) >= 3) return finish(slot, quick);
      canvas = await pdfCanvas(pdf);
    } else {
      canvas = await imageToCanvas(file);
    }

    progressHook = (m) => {
      if (m.status === "recognizing text") say("Reading the document…", 35 + Math.round(m.progress * 55));
      else if (/loading|initializ/i.test(m.status || "")) say("Loading the reader (first time only)…", 10 + Math.round((m.progress || 0) * 20));
    };
    say("Loading the reader (first time only)…", 8);
    text += "\n" + (await recognize(canvas, "3"));
    let c = classify(text);
    if (maxScore(c) < 3) {
      say("Taking a closer look…", 85);
      text += "\n" + (await recognize(canvas, "11"));
      c = classify(text);
    }
    progressHook = null;
    return finish(slot, c);
  }

  function finish(slot, c) {
    const v = verdictFor(slot, c);
    v.method = "client_ocr_v1";
    v.checked_at = new Date().toISOString();
    return v;
  }

  /** Start loading the OCR engine in the background so the first check is quick. */
  function warmUp() { getWorker().catch(() => { /* the real check will report any problem */ }); }

  const DocVerify = { check, warmUp, LABELS, _t: { classify, verdictFor, verhoeffValid, verhoeffCheckDigit, fixPanToken, maxScore } };
  root.DocVerify = DocVerify;
  if (typeof module !== "undefined" && module.exports) module.exports = DocVerify._t;
})(typeof window !== "undefined" ? window : globalThis);
