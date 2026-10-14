// MSMEase — frontend logic.

// The backend address is picked automatically:
//  - opened from localhost / 127.0.0.1 / a local file  -> your laptop's backend
//  - anywhere else (Netlify)                           -> the Render backend
const IS_LOCAL = ["localhost", "127.0.0.1", ""].includes(location.hostname);
const API_BASE = IS_LOCAL ? "http://127.0.0.1:8000" : "https://msmeese.onrender.com";

let authToken = localStorage.getItem("msmease_token") || null;
let currentUser = null;

let currentProfile = null;
let currentResults = [];
let activeFilter = "all";
let activeStatusFilter = "all"; // "all" | "applicable" | "notapplicable"
let authMode = "login"; // "login" | "signup"

// Documents feature: give its API layer the server address, the login token
// and what to do on an expired session. Switching it from "mock" to the real
// backend is one setting in js/docs-config.js.
DocsApi.configure({
  apiBase: API_BASE,
  getToken: () => authToken,
  getUserId: () => (currentUser ? currentUser.id : null),
  onUnauthorized: () => logout(),
});

// Escape user-entered text before putting it into innerHTML.
function esc(v) {
  return String(v ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ---------- fetch helper: attaches the auth header, handles 401 globally ----------
async function apiFetch(path, options = {}) {
  const headers = Object.assign({}, options.headers || {});
  if (authToken) headers["Authorization"] = `Bearer ${authToken}`;

  const res = await fetch(`${API_BASE}${path}`, Object.assign({}, options, { headers }));

  if (res.status === 401) {
    logout(); // session expired or invalid: back to login
    throw new Error("Your session expired. Please log in again.");
  }
  return res;
}

// ---------- view switching ----------
function showView(name) {
  document.querySelectorAll(".view").forEach(v => v.classList.add("hidden"));
  document.getElementById(`view-${name}`).classList.remove("hidden");
  document.querySelectorAll(".navlink[data-view]").forEach(b => {
    b.classList.toggle("active", b.dataset.view === name);
  });
}

document.querySelectorAll(".navlink[data-view]").forEach(btn => {
  btn.addEventListener("click", () => {
    const view = btn.dataset.view;
    if (view === "myprofiles") loadMyProfiles();
    showView(view);
  });
});
document.getElementById("landing-start").addEventListener("click", () => showView("profile"));
document.getElementById("landing-profiles").addEventListener("click", () => { loadMyProfiles(); showView("myprofiles"); });

function setLoggedInUI(isLoggedIn) {
  document.getElementById("topbar-nav").classList.toggle("hidden", !isLoggedIn);
  const acct = document.getElementById("topbar-account");
  if (isLoggedIn && currentUser) {
    const initial = esc((currentUser.business_name || "?").trim().charAt(0).toUpperCase());
    acct.innerHTML = `
      <span class="avatar" aria-hidden="true">${initial}</span>
      <span class="topbar__user">${esc(currentUser.business_name)}</span>
      <button class="navlink navlink--quiet" id="logout-btn">Log out</button>
    `;
    document.getElementById("logout-btn").addEventListener("click", logout);
    document.getElementById("landing-name").textContent = currentUser.business_name;
    DocsUI.onLogin(currentUser);
  } else {
    acct.innerHTML = "";
  }
}

function logout() {
  DocsUI.onLogout();
  authToken = null;
  currentUser = null;
  localStorage.removeItem("msmease_token");
  setLoggedInUI(false);
  setAuthMode("login");
  showView("auth");
}

// ---------- auth form (login / signup toggle) ----------
const authForm = document.getElementById("auth-form");
const authError = document.getElementById("auth-error");
const authNameRow = document.getElementById("auth-name-row");

function setAuthMode(mode) {
  authMode = mode;
  authError.classList.add("hidden");
  authForm.reset();
  if (mode === "login") {
    document.getElementById("auth-title").textContent = "Log in";
    document.getElementById("auth-sub").textContent = "Welcome back. Log in to see your saved compliance profiles.";
    document.getElementById("auth-submit").textContent = "Log in";
    document.getElementById("auth-switch-prompt").textContent = "Don't have an account?";
    document.getElementById("auth-switch-btn").textContent = "Sign up";
    authNameRow.classList.add("hidden");
    authNameRow.querySelector("input").required = false;
  } else {
    document.getElementById("auth-title").textContent = "Create your account";
    document.getElementById("auth-sub").textContent = "One account per business. Your profiles stay private to you.";
    document.getElementById("auth-submit").textContent = "Sign up";
    document.getElementById("auth-switch-prompt").textContent = "Already have an account?";
    document.getElementById("auth-switch-btn").textContent = "Log in";
    authNameRow.classList.remove("hidden");
    authNameRow.querySelector("input").required = true;
  }
}
document.getElementById("auth-switch-btn").addEventListener("click", () => {
  setAuthMode(authMode === "login" ? "signup" : "login");
});

authForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  authError.classList.add("hidden");

  const fd = new FormData(authForm);
  const email = fd.get("email");
  const password = fd.get("password");
  const business_name = fd.get("business_name");

  const submitBtn = document.getElementById("auth-submit");
  submitBtn.disabled = true;
  submitBtn.textContent = authMode === "login" ? "Logging in..." : "Signing up...";

  try {
    const path = authMode === "login" ? "/api/auth/login" : "/api/auth/signup";
    const body = authMode === "login" ? { email, password } : { email, password, business_name };

    const res = await fetch(`${API_BASE}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errBody = await res.json().catch(() => ({}));
      const detail = Array.isArray(errBody.detail) ? "Please check the details you entered." : errBody.detail;
      throw new Error(detail || "Something went wrong. Please try again.");
    }

    const data = await res.json();
    authToken = data.access_token;
    localStorage.setItem("msmease_token", authToken);

    await loadCurrentUser();
    setLoggedInUI(true);
    showView("landing");
  } catch (err) {
    const offline = err instanceof TypeError; // fetch() itself failed
    authError.textContent = offline
      ? "Can't reach the server. If it was idle, wait about a minute and try again."
      : (err.message || "Something went wrong.");
    authError.classList.remove("hidden");
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = authMode === "login" ? "Log in" : "Sign up";
  }
});

async function loadCurrentUser() {
  const res = await apiFetch("/api/auth/me");
  if (!res.ok) throw new Error("Could not load your account.");
  currentUser = await res.json();
}

// ---------- gauge + category visuals ----------
function countStatuses(results) {
  const registered = results.filter(r => r.status.includes("Already Registered")).length;
  const applicable = results.filter(r => r.status.startsWith("Applicable")).length;
  const na = results.length - applicable;
  return { action: applicable - registered, registered, na };
}

function gaugeMarkup(c, labelText) {
  const total = c.action + c.registered + c.na;
  const applicable = c.action + c.registered;
  const R = 80, L = Math.PI * R, SW = 16, GAP = 5;
  const segs = [
    { n: c.action, color: "var(--orange)", label: "Needs action" },
    { n: c.registered, color: "var(--leaf)", label: "Already registered" },
    { n: c.na, color: "var(--sky)", label: "Does not apply" },
  ];
  const arc = "M20 100 A80 80 0 0 1 180 100";
  let acc = 0;
  let arcs = "";
  segs.forEach(s => {
    const len = total ? (s.n / total) * L : 0;
    if (s.n > 0) {
      const dash = Math.max(0.01, len - GAP - SW);
      arcs += `<path d="${arc}" fill="none" stroke="${s.color}" stroke-width="${SW}" stroke-linecap="round" ` +
              `stroke-dasharray="${dash.toFixed(2)} ${L.toFixed(2)}" stroke-dashoffset="${(-(acc + GAP / 2 + SW / 2)).toFixed(2)}"/>`;
    }
    acc += len;
  });

  return `
    <div class="gauge">
      <svg viewBox="0 0 200 112" role="img" aria-label="${applicable} of ${total} requirements apply">
        ${arcs}
      </svg>
      <div class="gauge__center">
        <div class="gauge__num">${applicable}</div>
        <div class="gauge__label">${esc(labelText || `of ${total} requirements apply`)}</div>
      </div>
    </div>
    <ul class="legend">
      ${segs.map(s => `<li><span class="dot" style="background:${s.color}"></span><span>${s.label}</span><b>${s.n}</b></li>`).join("")}
    </ul>
  `;
}

function renderSample() {
  document.getElementById("landing-sample").innerHTML = `
    <div class="sample__title">Example result</div>
    <div class="sample__note">A 15-person textile unit in Tamil Nadu</div>
    ${gaugeMarkup({ action: 12, registered: 5, na: 5 })}
  `;
}

function categoryMarkup(results) {
  const cats = {};
  results.forEach(r => {
    cats[r.category] = cats[r.category] || { total: 0, applicable: 0 };
    cats[r.category].total += 1;
    if (r.status.startsWith("Applicable")) cats[r.category].applicable += 1;
  });
  const rows = Object.entries(cats).map(([name, v]) => {
    const pct = v.total ? Math.round((v.applicable / v.total) * 100) : 0;
    return `
      <div class="catrow">
        <div class="catrow__head">
          <span>${esc(name)}</span>
          <span class="catrow__count"><b>${v.applicable}</b> of ${v.total} apply</span>
        </div>
        <div class="bar"><div class="bar__fill" style="width:${pct}%"></div></div>
      </div>`;
  }).join("");
  return `<div class="cardtitle">By category</div>${rows}`;
}

// ---------- boot: check for an existing session ----------
renderSample();
(async function boot() {
  if (!authToken) {
    setLoggedInUI(false);
    setAuthMode("login");
    showView("auth");
    return;
  }
  try {
    await loadCurrentUser();
    setLoggedInUI(true);
    showView("landing");
  } catch {
    logout();
  }
})();

// ---------- profile form submit ----------
const form = document.getElementById("profile-form");
const errorEl = document.getElementById("profile-error");

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  errorEl.classList.add("hidden");

  const fd = new FormData(form);
  const payload = {
    business_name: fd.get("business_name"),
    business_type: fd.get("business_type"),
    industry: fd.get("industry"),
    state: fd.get("state"),
    employees: Number(fd.get("employees")),
    turnover_lakhs: Number(fd.get("turnover_lakhs")),
    uses_power: fd.get("uses_power") === "on",
    gst_registered: fd.get("gst_registered") === "on",
    udyam_registered: fd.get("udyam_registered") === "on",
    factory_status: fd.get("factory_status") === "on",
  };

  const submitBtn = document.getElementById("profile-submit");
  submitBtn.disabled = true;
  submitBtn.textContent = "Generating...";

  try {
    const profileRes = await apiFetch("/api/profiles", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!profileRes.ok) throw new Error("Could not save the business profile.");
    currentProfile = await profileRes.json();

    const genRes = await apiFetch(`/api/profiles/${currentProfile.id}/generate`, { method: "POST" });
    if (!genRes.ok) throw new Error("Could not generate the compliance list.");
    currentResults = await genRes.json();

    activeFilter = "all";
    activeStatusFilter = "all";
    renderDashboard();
    showView("dashboard");
    form.reset();
    document.querySelector('input[name="uses_power"]').checked = true;
  } catch (err) {
    errorEl.textContent = err instanceof TypeError
      ? "Can't reach the server. If it was idle, wait about a minute and try again."
      : (err.message || "Something went wrong.");
    errorEl.classList.remove("hidden");
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = "Generate compliance profile";
  }
});

// ---------- My profiles (history) ----------
async function loadMyProfiles() {
  const listEl = document.getElementById("myprofiles-list");
  const emptyEl = document.getElementById("myprofiles-empty");
  listEl.innerHTML = "";
  emptyEl.classList.add("hidden");

  try {
    const res = await apiFetch("/api/profiles");
    if (!res.ok) throw new Error("Could not load your profiles.");
    const profiles = await res.json();

    if (profiles.length === 0) {
      emptyEl.textContent = "You haven't created a profile yet. Start with New profile.";
      emptyEl.classList.remove("hidden");
      return;
    }

    listEl.innerHTML = profiles.map(p => `
      <div class="result-row" data-profile-id="${p.id}" tabindex="0" role="button">
        <div class="result-row__tile">${esc((p.business_name || "?").trim().charAt(0).toUpperCase())}</div>
        <div class="result-row__main">
          <div class="result-row__name">${esc(p.business_name)}</div>
          <div class="result-row__cat">${esc(p.industry)}, ${esc(p.business_type)}, ${p.employees} employees, \u20b9${p.turnover_lakhs} lakh turnover</div>
        </div>
        <span class="status-pill status-pill--open">Open</span>
      </div>
    `).join("");

    listEl.querySelectorAll(".result-row").forEach(row => {
      const open = () => openSavedProfile(row.dataset.profileId);
      row.addEventListener("click", open);
      row.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); } });
    });
  } catch (err) {
    emptyEl.textContent = err.message || "Could not load your profiles.";
    emptyEl.classList.remove("hidden");
  }
}

async function openSavedProfile(profileId) {
  try {
    const [profileRes, resultsRes] = await Promise.all([
      apiFetch(`/api/profiles/${profileId}`),
      apiFetch(`/api/profiles/${profileId}/results`),
    ]);
    if (!profileRes.ok || !resultsRes.ok) throw new Error("Could not open this profile.");

    currentProfile = await profileRes.json();
    currentResults = await resultsRes.json();
    activeFilter = "all";
    activeStatusFilter = "all";
    renderDashboard();
    showView("dashboard");
  } catch (err) {
    alert(err.message || "Could not open this profile.");
  }
}

// ---------- dashboard rendering ----------
function statusPillClass(status) {
  if (status.includes("Already Registered")) return "status-pill--registered";
  if (status.includes("Action Required") || status === "Applicable") return "status-pill--applicable";
  return "status-pill--notapplicable";
}

function renderDashboard() {
  document.getElementById("dash-business-name").textContent = currentProfile.business_name;
  document.getElementById("dash-business-meta").innerHTML = [
    currentProfile.industry,
    currentProfile.business_type,
    currentProfile.state,
    `${currentProfile.employees} employees`,
    `\u20b9${currentProfile.turnover_lakhs} lakh turnover`,
  ].map(t => `<span class="metachip">${esc(t)}</span>`).join("");

  document.getElementById("dash-gauge").innerHTML = `<div class="cardtitle">What applies to you</div>${gaugeMarkup(countStatuses(currentResults))}`;
  document.getElementById("dash-categories").innerHTML = categoryMarkup(currentResults);

  const applicableCount = currentResults.filter(r => r.status.startsWith("Applicable")).length;
  const notApplicableCount = currentResults.length - applicableCount;

  document.getElementById("dash-summary").innerHTML = `
    <button class="summary-chip ${activeStatusFilter === "applicable" ? "active" : ""}" data-status="applicable">
      <strong>${applicableCount}</strong> applicable
    </button>
    <button class="summary-chip ${activeStatusFilter === "notapplicable" ? "active" : ""}" data-status="notapplicable">
      <strong>${notApplicableCount}</strong> not applicable
    </button>
    <button class="summary-chip ${activeStatusFilter === "all" ? "active" : ""}" data-status="all">
      <strong>${currentResults.length}</strong> total checked
    </button>
  `;
  document.querySelectorAll(".summary-chip").forEach(btn => {
    btn.addEventListener("click", () => {
      activeStatusFilter = btn.dataset.status;
      renderDashboard();
    });
  });

  const categories = ["all", ...new Set(currentResults.map(r => r.category))];
  document.getElementById("dash-filters").innerHTML = categories.map(cat => `
    <button class="filter-btn ${cat === activeFilter ? "active" : ""}" data-cat="${esc(cat)}">
      ${cat === "all" ? "All categories" : esc(cat)}
    </button>
  `).join("");
  document.querySelectorAll(".filter-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      activeFilter = btn.dataset.cat;
      renderDashboard();
    });
  });

  let filtered = activeFilter === "all"
    ? currentResults
    : currentResults.filter(r => r.category === activeFilter);

  if (activeStatusFilter === "applicable") {
    filtered = filtered.filter(r => r.status.startsWith("Applicable"));
  } else if (activeStatusFilter === "notapplicable") {
    filtered = filtered.filter(r => r.status === "Not Applicable");
  }

  const sorted = [...filtered].sort((a, b) => {
    const aApp = a.status.startsWith("Applicable") ? 0 : 1;
    const bApp = b.status.startsWith("Applicable") ? 0 : 1;
    if (aApp !== bApp) return aApp - bApp;
    return a.rule_name.localeCompare(b.rule_name);
  });

  document.getElementById("dash-list").innerHTML = sorted.map(r => `
    <div class="result-row" data-rule-id="${r.rule_id}" tabindex="0" role="button">
      <div class="result-row__main">
        <div class="result-row__name">${esc(r.rule_name)}</div>
        <div class="result-row__cat">${esc(r.category)}</div>
      </div>
      <span class="status-pill ${statusPillClass(r.status)}">${esc(r.status)}</span>
    </div>
  `).join("");

  document.querySelectorAll("#dash-list .result-row").forEach(row => {
    const open = () => openDetail(row.dataset.ruleId);
    row.addEventListener("click", open);
    row.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); } });
  });
}

// ---------- detail modal ----------
const CHECK_SVG = '<svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true"><path d="M2 6.5l2.5 2.5L10 3.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';

function documentsMarkup(list) {
  if (!list || !list.length) return "Not specified";
  const rd = DocsUI.readiness(list);
  const chips = rd.items.map(i =>
    `<span class="docchip ${i.ready ? "docchip--ready" : ""}">${i.ready ? CHECK_SVG : ""}${esc(i.text)}</span>`
  ).join("");
  let note = "";
  if (rd.readyCount) note = `<div class="doclist__note">${rd.readyCount} of ${rd.items.length} already in your documents.</div>`;
  else if (rd.trackable) note = `<div class="doclist__note">Add them under New profile and we'll mark the ones you have.</div>`;
  return `<div class="doclist">${chips}</div>${note}`;
}

function openDetail(ruleId) {
  const r = currentResults.find(x => x.rule_id === ruleId);
  if (!r) return;

  document.getElementById("detail-body").innerHTML = `
    <h3 id="detail-title">${esc(r.rule_name)}</h3>
    <div class="modal__meta">${esc(r.category)} <span class="status-pill ${statusPillClass(r.status)}">${esc(r.status)}</span></div>

    <div class="modal__field">
      <div class="modal__field-label">Why this result</div>
      <div class="modal__field-value">${esc(r.explanation)}</div>
    </div>
    <div class="modal__field">
      <div class="modal__field-label">Frequency</div>
      <div class="modal__field-value">${esc(r.frequency || "Not specified")}</div>
    </div>
    <div class="modal__field">
      <div class="modal__field-label">Responsible authority</div>
      <div class="modal__field-value">${esc(r.authority || "Not specified")}</div>
    </div>
    <div class="modal__field">
      <div class="modal__field-label">Documents typically required</div>
      <div class="modal__field-value">${documentsMarkup(r.documents)}</div>
    </div>
    <div class="modal__field">
      <div class="modal__field-label">Official source</div>
      <div class="modal__field-value"><a href="${esc(r.source)}" target="_blank" rel="noopener">${esc(r.source)}</a></div>
    </div>

    ${r.registration_steps && r.registration_steps.length ? `
      <div class="modal__field">
        <div class="modal__field-label" style="margin-bottom:12px;">How to register or comply</div>
        <ol class="roadmap">
          ${r.registration_steps.map(s => `
            <li class="roadmap__step">
              <span class="roadmap__num"></span>
              <div class="roadmap__content">
                <div class="roadmap__title">${esc(s.title)}</div>
                <div class="roadmap__desc">${esc(s.description)}</div>
              </div>
            </li>
          `).join("")}
        </ol>
      </div>
    ` : ""}
  `;
  document.getElementById("detail-backdrop").classList.remove("hidden");
  document.getElementById("detail-close").focus();
}

function closeDetail() {
  document.getElementById("detail-backdrop").classList.add("hidden");
}
document.getElementById("detail-close").addEventListener("click", closeDetail);
document.getElementById("detail-backdrop").addEventListener("click", (e) => {
  if (e.target.id === "detail-backdrop") closeDetail();
});
document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeDetail(); });
