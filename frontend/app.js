// MSMEase — frontend logic.

// ⚠️ DEPLOYMENT: this is the only line you need to change when hosting online.
// Local dev:  "http://127.0.0.1:8000"
// Deployed:   "https://your-backend-service.onrender.com"  (no trailing slash)
const API_BASE = "https://msmeese.onrender.com";

let authToken = localStorage.getItem("msmease_token") || null;
let currentUser = null;

let currentProfile = null;
let currentResults = [];
let activeFilter = "all";
let activeStatusFilter = "all"; // "all" | "applicable" | "notapplicable"
let authMode = "login"; // "login" | "signup"

// ---------- fetch helper: attaches the auth header, handles 401 globally ----------
async function apiFetch(path, options = {}) {
  const headers = Object.assign({}, options.headers || {});
  if (authToken) headers["Authorization"] = `Bearer ${authToken}`;

  const res = await fetch(`${API_BASE}${path}`, Object.assign({}, options, { headers }));

  if (res.status === 401) {
    logout(); // session expired or invalid — send back to login
    throw new Error("Your session expired. Please log in again.");
  }
  return res;
}

// ---------- view switching ----------
function showView(name) {
  document.querySelectorAll(".view").forEach(v => v.classList.add("hidden"));
  document.getElementById(`view-${name}`).classList.remove("hidden");
}

document.querySelectorAll(".navlink").forEach(btn => {
  btn.addEventListener("click", () => {
    const view = btn.dataset.view;
    if (view === "myprofiles") loadMyProfiles();
    showView(view);
  });
});
document.getElementById("landing-start").addEventListener("click", () => showView("profile"));

function setLoggedInUI(isLoggedIn) {
  document.getElementById("topbar-nav").classList.toggle("hidden", !isLoggedIn);
  const acct = document.getElementById("topbar-account");
  if (isLoggedIn && currentUser) {
    acct.innerHTML = `
      <span class="topbar__user">${currentUser.business_name}</span>
      <button class="navlink" id="logout-btn">Log out</button>
    `;
    document.getElementById("logout-btn").addEventListener("click", logout);
  } else {
    acct.innerHTML = "";
  }
}

function logout() {
  authToken = null;
  currentUser = null;
  localStorage.removeItem("msmease_token");
  setLoggedInUI(false);
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
    document.getElementById("auth-sub").textContent = "Welcome back — log in to see your saved compliance profiles.";
    document.getElementById("auth-submit").textContent = "Log in";
    document.getElementById("auth-switch-prompt").textContent = "Don't have an account?";
    document.getElementById("auth-switch-btn").textContent = "Sign up";
    authNameRow.classList.add("hidden");
    authNameRow.querySelector("input").required = false;
  } else {
    document.getElementById("auth-title").textContent = "Create your account";
    document.getElementById("auth-sub").textContent = "One account per business — your profiles stay private to you.";
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
    const body = authMode === "login"
      ? { email, password }
      : { email, password, business_name };

    const res = await fetch(`${API_BASE}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errBody = await res.json().catch(() => ({}));
      throw new Error(errBody.detail || "Something went wrong. Please try again.");
    }

    const data = await res.json();
    authToken = data.access_token;
    localStorage.setItem("msmease_token", authToken);

    await loadCurrentUser();
    setLoggedInUI(true);
    showView("landing");
  } catch (err) {
    authError.textContent = err.message || "Something went wrong.";
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

// ---------- boot: check for an existing session ----------
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

  const submitBtn = form.querySelector("button[type=submit]");
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
    errorEl.textContent = err.message || "Something went wrong.";
    errorEl.classList.remove("hidden");
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = "Generate Compliance Profile";
  }
});

// ---------- My Profiles (history) ----------
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
      emptyEl.classList.remove("hidden");
      return;
    }

    listEl.innerHTML = profiles.map(p => `
      <div class="result-row" data-profile-id="${p.id}">
        <div class="result-row__main">
          <div class="result-row__name">${p.business_name}</div>
          <div class="result-row__cat">${p.industry} — ${p.business_type} — ${p.employees} employees — ₹${p.turnover_lakhs} lakh</div>
        </div>
        <span class="status-pill status-pill--notapplicable">Open →</span>
      </div>
    `).join("");

    listEl.querySelectorAll(".result-row").forEach(row => {
      row.addEventListener("click", () => openSavedProfile(row.dataset.profileId));
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
  document.getElementById("dash-business-meta").textContent =
    `${currentProfile.industry} — ${currentProfile.business_type} — ${currentProfile.state} — ` +
    `${currentProfile.employees} employees — turnover \u20b9${currentProfile.turnover_lakhs} lakh`;

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
    <button class="filter-btn ${cat === activeFilter ? "active" : ""}" data-cat="${cat}">
      ${cat === "all" ? "All categories" : cat}
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
    <div class="result-row" data-rule-id="${r.rule_id}">
      <div class="result-row__main">
        <div class="result-row__name">${r.rule_name}</div>
        <div class="result-row__cat">${r.category}</div>
      </div>
      <span class="status-pill ${statusPillClass(r.status)}">${r.status}</span>
    </div>
  `).join("");

  document.querySelectorAll("#dash-list .result-row").forEach(row => {
    row.addEventListener("click", () => openDetail(row.dataset.ruleId));
  });
}

// ---------- detail modal ----------
function openDetail(ruleId) {
  const r = currentResults.find(x => x.rule_id === ruleId);
  if (!r) return;

  document.getElementById("detail-body").innerHTML = `
    <h3>${r.rule_name}</h3>
    <div class="modal__meta">${r.category} — <span class="status-pill ${statusPillClass(r.status)}">${r.status}</span></div>

    <div class="modal__field">
      <div class="modal__field-label">Why this result</div>
      <div class="modal__field-value">${r.explanation}</div>
    </div>
    <div class="modal__field">
      <div class="modal__field-label">Frequency</div>
      <div class="modal__field-value">${r.frequency || "—"}</div>
    </div>
    <div class="modal__field">
      <div class="modal__field-label">Responsible authority</div>
      <div class="modal__field-value">${r.authority || "—"}</div>
    </div>
    <div class="modal__field">
      <div class="modal__field-label">Documents typically required</div>
      <div class="modal__field-value">${(r.documents && r.documents.length) ? r.documents.join(", ") : "—"}</div>
    </div>
    <div class="modal__field">
      <div class="modal__field-label">Official source</div>
      <div class="modal__field-value"><a href="${r.source}" target="_blank" rel="noopener">${r.source}</a></div>
    </div>

    ${r.registration_steps && r.registration_steps.length ? `
      <div class="modal__field">
        <div class="modal__field-label" style="margin-bottom:10px;">How to register / comply</div>
        <ol class="roadmap">
          ${r.registration_steps.map(s => `
            <li class="roadmap__step">
              <span class="roadmap__num"></span>
              <div class="roadmap__content">
                <div class="roadmap__title">${s.title}</div>
                <div class="roadmap__desc">${s.description}</div>
              </div>
            </li>
          `).join("")}
        </ol>
      </div>
    ` : ""}
  `;
  document.getElementById("detail-backdrop").classList.remove("hidden");
}

document.getElementById("detail-close").addEventListener("click", () => {
  document.getElementById("detail-backdrop").classList.add("hidden");
});
document.getElementById("detail-backdrop").addEventListener("click", (e) => {
  if (e.target.id === "detail-backdrop") e.target.classList.add("hidden");
});
