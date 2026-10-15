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

// ---------- status and deadline helpers ----------
function isApplicable(r) {
  return r.applicability === "Applicable" || (r.status && r.status.startsWith("Applicable"));
}

function isCompleted(r) {
  return r.progress === "Completed" || (r.status && r.status.includes("Already Registered") && !["Action required", "In progress", "Submitted"].includes(r.progress));
}

function isOverdue(r) {
  if (r.is_overdue !== undefined) return Boolean(r.is_overdue);
  if (isCompleted(r)) return false;
  if (!r.due_date) return false;
  const today = new Date().toISOString().slice(0, 10);
  return r.due_date < today;
}

function statusPillClass(status) {
  if (status.includes("Already Registered") || status.includes("Completed")) return "status-pill--registered";
  if (status.includes("Action Required") || status === "Applicable") return "status-pill--applicable";
  if (status.includes("Needs Verification") || status === "Needs verification") return "status-pill--verification";
  return "status-pill--notapplicable";
}

function rowBadgesMarkup(r) {
  let html = "";
  if (r.applicability === "Needs verification") {
    html += `<span class="status-pill status-pill--verification">Needs verification</span> `;
  } else if (r.applicability === "Not applicable") {
    html += `<span class="status-pill status-pill--notapplicable">Not applicable</span>`;
  } else {
    html += `<span class="status-pill status-pill--applicable">Applicable</span> `;
  }

  if (r.applicability !== "Not applicable") {
    const prog = r.progress || "Action required";
    let progClass = "action";
    if (prog === "In progress") progClass = "inprogress";
    else if (prog === "Submitted") progClass = "submitted";
    else if (prog === "Completed") progClass = "completed";

    html += `
      <select class="row-progress-select row-progress-select--${progClass}" data-rule-id="${r.rule_id}" title="Change status directly">
        <option value="Action required" ${prog === "Action required" ? "selected" : ""}>Action required</option>
        <option value="In progress" ${prog === "In progress" ? "selected" : ""}>In progress</option>
        <option value="Submitted" ${prog === "Submitted" ? "selected" : ""}>Submitted</option>
        <option value="Completed" ${prog === "Completed" ? "selected" : ""}>Completed</option>
      </select>
    `;
  }

  if (isOverdue(r)) {
    html += ` <span class="status-pill status-pill--overdue">Overdue</span>`;
  }
  return html;
}

function modalBadgesMarkup(r) {
  let html = `${esc(r.category)} `;
  if (r.applicability === "Needs verification") {
    html += `<span class="status-pill status-pill--verification">Needs verification</span> `;
  } else if (r.applicability === "Not applicable") {
    html += `<span class="status-pill status-pill--notapplicable">Not applicable</span> `;
  } else {
    html += `<span class="status-pill status-pill--applicable">Applicable</span> `;
  }

  if (r.applicability !== "Not applicable") {
    const prog = r.progress || "Action required";
    if (prog === "Completed") {
      html += `<span class="status-pill status-pill--progress-completed">Completed</span> `;
    } else if (prog === "In progress") {
      html += `<span class="status-pill status-pill--progress-inprogress">In progress</span> `;
    } else if (prog === "Submitted") {
      html += `<span class="status-pill status-pill--progress-submitted">Submitted</span> `;
    } else {
      html += `<span class="status-pill status-pill--progress-action">Action required</span> `;
    }
  }

  if (isOverdue(r)) {
    html += `<span class="status-pill status-pill--overdue">Overdue</span>`;
  }
  return html;
}

// ---------- calendar state & rendering ----------
let calYear = new Date().getFullYear();
let calMonth = new Date().getMonth();
let calSelectedDate = null;

function renderCalendar() {
  const calEl = document.getElementById("dash-calendar");
  if (!calEl) return;

  const monthNames = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December"
  ];
  const weekdays = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];

  const eventsByDate = {};
  currentResults.forEach(r => {
    if (r.due_date && r.due_date.trim()) {
      const d = r.due_date.trim();
      eventsByDate[d] = eventsByDate[d] || [];
      eventsByDate[d].push({ type: "due", rule: r });
    }
    if (r.reminder_date && r.reminder_date.trim() && r.reminder_enabled) {
      const d = r.reminder_date.trim();
      eventsByDate[d] = eventsByDate[d] || [];
      eventsByDate[d].push({ type: "reminder", rule: r });
    }
  });

  const firstDayIndex = new Date(calYear, calMonth, 1).getDay();
  const daysInMonth = new Date(calYear, calMonth + 1, 0).getDate();
  const daysInPrevMonth = new Date(calYear, calMonth, 0).getDate();

  const today = new Date();
  const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;

  let daysHtml = "";

  for (let i = firstDayIndex - 1; i >= 0; i--) {
    const dNum = daysInPrevMonth - i;
    daysHtml += `<div class="cal__cell cal__cell--muted"><span class="cal__num">${dNum}</span></div>`;
  }

  for (let day = 1; day <= daysInMonth; day++) {
    const dayStr = `${calYear}-${String(calMonth + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    const isToday = dayStr === todayStr;
    const isSelected = dayStr === calSelectedDate;
    const events = eventsByDate[dayStr] || [];

    let dotsHtml = "";
    if (events.length) {
      const hasOverdue = events.some(e => e.type === "due" && isOverdue(e.rule));
      const hasCompleted = events.some(e => e.type === "due" && isCompleted(e.rule));
      const hasDue = events.some(e => e.type === "due" && !isCompleted(e.rule) && !isOverdue(e.rule));
      const hasReminder = events.some(e => e.type === "reminder");

      dotsHtml = `<div class="cal__dots">`;
      if (hasOverdue) dotsHtml += `<span class="cal__dot cal__dot--overdue" title="Overdue compliance"></span>`;
      else if (hasDue) dotsHtml += `<span class="cal__dot cal__dot--due" title="Due / Renewal date"></span>`;
      else if (hasCompleted) dotsHtml += `<span class="cal__dot cal__dot--completed" title="Completed"></span>`;
      if (hasReminder) dotsHtml += `<span class="cal__dot cal__dot--reminder" title="Reminder configured"></span>`;
      dotsHtml += `</div>`;
    }

    daysHtml += `
      <div class="cal__cell ${isToday ? "cal__cell--today" : ""} ${isSelected ? "cal__cell--selected" : ""}" data-date="${dayStr}">
        <span class="cal__num">${day}</span>
        ${dotsHtml}
      </div>
    `;
  }

  const totalCells = firstDayIndex + daysInMonth;
  const remainingCells = (7 - (totalCells % 7)) % 7;
  for (let i = 1; i <= remainingCells; i++) {
    daysHtml += `<div class="cal__cell cal__cell--muted"><span class="cal__num">${i}</span></div>`;
  }

  let eventBoxHtml = "";
  const selectedEvents = calSelectedDate ? (eventsByDate[calSelectedDate] || []) : [];
  if (calSelectedDate) {
    if (selectedEvents.length) {
      eventBoxHtml = `
        <div class="cal__events-box">
          <div class="cal__events-title">Schedules for ${esc(calSelectedDate)}:</div>
          ${selectedEvents.map(ev => {
            const r = ev.rule;
            const label = ev.type === "due" ? (isOverdue(r) ? "⚠️ Due (Overdue)" : "📅 Due date") : "⏰ Reminder";
            return `
              <div class="cal__event-item">
                <div><b>${esc(r.rule_name)}</b> <span style="font-size:12px;color:var(--ink-3);">(${label} &bull; ${esc(r.progress || "Action required")})</span></div>
                <button type="button" class="cal__event-link" data-rule-id="${r.rule_id}">Open</button>
              </div>
            `;
          }).join("")}
        </div>
      `;
    } else {
      eventBoxHtml = `
        <div class="cal__events-box">
          <div class="cal__events-title">No renewals or reminders scheduled on ${esc(calSelectedDate)}.</div>
        </div>
      `;
    }
  } else {
    const thisMonthPrefix = `${calYear}-${String(calMonth + 1).padStart(2, "0")}`;
    const thisMonthKeys = Object.keys(eventsByDate).filter(k => k.startsWith(thisMonthPrefix));
    if (thisMonthKeys.length) {
      eventBoxHtml = `
        <div class="cal__events-box">
          <div class="cal__events-title">${monthNames[calMonth]} ${calYear}: ${thisMonthKeys.length} active scheduled date(s)</div>
          <span style="font-size:12px;color:var(--ink-3);">Click any date with a dot to inspect scheduled filings and reminders.</span>
        </div>
      `;
    } else {
      eventBoxHtml = `
        <div class="cal__events-box">
          <div class="cal__events-title">No renewals or reminders in ${monthNames[calMonth]} ${calYear}.</div>
          <span style="font-size:12px;color:var(--ink-3);">Set due or reminder dates in any compliance below to track it here.</span>
        </div>
      `;
    }
  }

  calEl.innerHTML = `
    <div class="cal__head">
      <div class="cardtitle">Compliance Calendar</div>
      <div class="cal__nav">
        <span class="cal__month-title">${monthNames[calMonth]} ${calYear}</span>
        <button type="button" class="cal__btn" id="cal-prev" title="Previous month">&lsaquo;</button>
        <button type="button" class="cal__btn cal__btn--today" id="cal-today" title="Current month">Today</button>
        <button type="button" class="cal__btn" id="cal-next" title="Next month">&rsaquo;</button>
      </div>
    </div>
    <div class="cal__weekdays">
      ${weekdays.map(w => `<span>${w}</span>`).join("")}
    </div>
    <div class="cal__days">
      ${daysHtml}
    </div>
    ${eventBoxHtml}
  `;

  document.getElementById("cal-prev").addEventListener("click", () => {
    if (calMonth === 0) { calMonth = 11; calYear--; }
    else { calMonth--; }
    renderCalendar();
  });
  document.getElementById("cal-next").addEventListener("click", () => {
    if (calMonth === 11) { calMonth = 0; calYear++; }
    else { calMonth++; }
    renderCalendar();
  });
  document.getElementById("cal-today").addEventListener("click", () => {
    const n = new Date();
    calYear = n.getFullYear();
    calMonth = n.getMonth();
    calSelectedDate = todayStr;
    renderCalendar();
  });

  calEl.querySelectorAll(".cal__cell[data-date]").forEach(cell => {
    cell.addEventListener("click", () => {
      calSelectedDate = cell.dataset.date;
      renderCalendar();
    });
  });

  calEl.querySelectorAll(".cal__event-link").forEach(btn => {
    btn.addEventListener("click", () => {
      openDetail(btn.dataset.ruleId);
    });
  });
}

// ---------- dashboard rendering ----------
function renderDashboard() {
  document.getElementById("dash-business-name").textContent = currentProfile.business_name;

  // Key-value formatted business details tags
  const metaPairs = [
    { key: "Industry", val: currentProfile.industry },
    { key: "Business type", val: currentProfile.business_type },
    { key: "State", val: currentProfile.state },
    { key: "Employees", val: currentProfile.employees },
    { key: "Turnover", val: `₹${currentProfile.turnover_lakhs} lakh` },
  ];
  if (currentProfile.uses_power !== undefined && currentProfile.uses_power !== null) {
    metaPairs.push({ key: "Power", val: currentProfile.uses_power ? "Used" : "No" });
  }

  document.getElementById("dash-business-meta").innerHTML = metaPairs.map(p =>
    `<span class="metachip"><span class="metachip__key">${esc(p.key)}:</span> <b>${esc(p.val)}</b></span>`
  ).join("");

  document.getElementById("dash-gauge").innerHTML = `<div class="cardtitle">What applies to you</div>${gaugeMarkup(countStatuses(currentResults))}`;
  document.getElementById("dash-categories").innerHTML = categoryMarkup(currentResults);

  // Exact counts for applicable, outstanding, completed, and overdue requirements
  const applicableItems = currentResults.filter(r => isApplicable(r));
  const completedItems = applicableItems.filter(r => isCompleted(r));
  const outstandingItems = applicableItems.filter(r => !isCompleted(r));
  const overdueItems = currentResults.filter(r => isOverdue(r));

  // Upcoming deadlines section
  const deadlineItems = currentResults
    .filter(r => r.due_date && r.due_date.trim() !== "")
    .sort((a, b) => a.due_date.localeCompare(b.due_date));

  const deadlinesEl = document.getElementById("dash-deadlines");
  if (deadlinesEl) {
    if (deadlineItems.length === 0) {
      deadlinesEl.innerHTML = `
        <div class="deadlines__head">
          <div class="cardtitle">Upcoming Deadlines & Renewals</div>
        </div>
        <p class="emptynote" style="padding:4px 0 8px;">No deadlines configured yet. Open any applicable compliance below to set a due or renewal date.</p>
      `;
    } else {
      deadlinesEl.innerHTML = `
        <div class="deadlines__head">
          <div class="cardtitle">Upcoming Deadlines & Renewals (${deadlineItems.length})</div>
        </div>
        <div class="deadlines__list">
          ${deadlineItems.map(d => {
            let badge = "";
            if (isOverdue(d)) {
              badge = `<span class="deadline-badge deadline-badge--overdue">Overdue (${esc(d.due_date)})</span>`;
            } else if (isCompleted(d)) {
              badge = `<span class="deadline-badge deadline-badge--completed">Completed (${esc(d.due_date)})</span>`;
            } else if (d.days_remaining !== undefined && d.days_remaining !== null && d.days_remaining <= 30) {
              badge = `<span class="deadline-badge deadline-badge--due-soon">Due in ${d.days_remaining}d (${esc(d.due_date)})</span>`;
            } else {
              badge = `<span class="deadline-badge deadline-badge--upcoming">Due on ${esc(d.due_date)}</span>`;
            }

            return `
              <div class="deadline-item" data-rule-id="${d.rule_id}" tabindex="0" role="button">
                <div class="deadline-item__info">
                  <div class="deadline-item__title">${esc(d.rule_name)}</div>
                  <div class="deadline-item__sub">${esc(d.category)} &bull; ${esc(d.progress || "Action required")}</div>
                </div>
                ${badge}
              </div>
            `;
          }).join("")}
        </div>
      `;

      deadlinesEl.querySelectorAll(".deadline-item").forEach(item => {
        const open = () => openDetail(item.dataset.ruleId);
        item.addEventListener("click", open);
        item.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); } });
      });
    }
  }

  // Render the calendar
  renderCalendar();

  // Dashboard summary chips with accurate counts
  document.getElementById("dash-summary").innerHTML = `
    <button class="summary-chip ${activeStatusFilter === "applicable" ? "active" : ""}" data-status="applicable">
      <strong>${applicableItems.length}</strong> applicable
    </button>
    <button class="summary-chip ${activeStatusFilter === "outstanding" ? "active" : ""}" data-status="outstanding">
      <strong>${outstandingItems.length}</strong> outstanding
    </button>
    <button class="summary-chip ${activeStatusFilter === "completed" ? "active" : ""}" data-status="completed">
      <strong>${completedItems.length}</strong> completed
    </button>
    <button class="summary-chip ${activeStatusFilter === "overdue" ? "active" : ""}" data-status="overdue">
      <strong>${overdueItems.length}</strong> overdue
    </button>
    <button class="summary-chip ${activeStatusFilter === "all" ? "active" : ""}" data-status="all">
      <strong>${currentResults.length}</strong> all checked
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
    filtered = filtered.filter(r => isApplicable(r));
  } else if (activeStatusFilter === "outstanding") {
    filtered = filtered.filter(r => isApplicable(r) && !isCompleted(r));
  } else if (activeStatusFilter === "completed") {
    filtered = filtered.filter(r => isApplicable(r) && isCompleted(r));
  } else if (activeStatusFilter === "overdue") {
    filtered = filtered.filter(r => isOverdue(r));
  }

  const sorted = [...filtered].sort((a, b) => {
    const aApp = isApplicable(a) ? 0 : 1;
    const bApp = isApplicable(b) ? 0 : 1;
    if (aApp !== bApp) return aApp - bApp;
    return a.rule_name.localeCompare(b.rule_name);
  });

  document.getElementById("dash-list").innerHTML = sorted.length ? sorted.map(r => `
    <div class="result-row" data-rule-id="${r.rule_id}" tabindex="0" role="button">
      <div class="result-row__main">
        <div class="result-row__name">${esc(r.rule_name)}</div>
        <div class="result-row__cat">${esc(r.category)} ${r.act_section ? `&bull; ${esc(r.act_section.slice(0, 50))}` : ""}</div>
      </div>
      <div>${rowBadgesMarkup(r)}</div>
    </div>
  `).join("") : `<p class="emptynote">No compliance requirements match the selected filter.</p>`;

  // Wire interactive row status dropdowns
  document.querySelectorAll("#dash-list .row-progress-select").forEach(sel => {
    sel.addEventListener("click", (e) => e.stopPropagation());
    sel.addEventListener("keydown", (e) => e.stopPropagation());
    sel.addEventListener("change", async (e) => {
      e.stopPropagation();
      const ruleId = sel.dataset.ruleId;
      const newProgress = sel.value;
      const r = currentResults.find(x => x.rule_id === ruleId);
      if (!r) return;

      try {
        const res = await apiFetch(`/api/profiles/${currentProfile.id}/results/${ruleId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ progress: newProgress }),
        });
        if (!res.ok) throw new Error("Could not update status.");
        const updated = await res.json();
        Object.assign(r, updated);
        renderDashboard();
      } catch (err) {
        alert(err.message || "Failed to update status.");
        renderDashboard();
      }
    });
  });

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

  const currentProg = r.progress || (isCompleted(r) ? "Completed" : "Action required");

  document.getElementById("detail-body").innerHTML = `
    <h3 id="detail-title">${esc(r.rule_name)}</h3>
    <div class="modal__meta">${modalBadgesMarkup(r)}</div>

    <div class="modal__grid">
      <!-- Left Column: Legal Basis & Interactive Progress Tracking -->
      <div class="modal__col">
        <!-- Legal Accuracy -->
        <div class="legalbox">
          <div class="legalbox__row">
            <span class="legalbox__label">Act & Section:</span>
            <span class="legalbox__val">${esc(r.act_section || "Needs verification")}</span>
          </div>
          <div class="legalbox__row">
            <span class="legalbox__label">Jurisdiction:</span>
            <span class="legalbox__val">${esc(r.jurisdiction || "Needs verification")}</span>
          </div>
          <div class="legalbox__row">
            <span class="legalbox__label">Legal verification:</span>
            <span class="legalbox__val">${r.last_verified_date ? `Verified as of ${esc(r.last_verified_date)}` : `<span style="color:#C8553D;font-weight:700;">Needs verification</span>`}</span>
          </div>
          <div class="legalbox__row">
            <span class="legalbox__label">Official source:</span>
            <span class="legalbox__val"><a href="${esc(r.source)}" target="_blank" rel="noopener">${esc(r.source)}</a></span>
          </div>
        </div>

        <!-- Persistent Progress Tracking -->
        <div class="trackcard">
          <div class="trackcard__title">
            <span>Progress & Deadline Tracking</span>
            <span class="trackcard__msg" id="track-msg">Saved!</span>
          </div>

          <div class="trackcard__grid">
            <div>
              <label class="modal__field-label" for="track-progress">Progress status</label>
              <select id="track-progress">
                <option value="Action required" ${currentProg === "Action required" ? "selected" : ""}>Action required</option>
                <option value="In progress" ${currentProg === "In progress" ? "selected" : ""}>In progress</option>
                <option value="Submitted" ${currentProg === "Submitted" ? "selected" : ""}>Submitted</option>
                <option value="Completed" ${currentProg === "Completed" ? "selected" : ""}>Completed</option>
              </select>
            </div>
            <div>
              <label class="modal__field-label" for="track-due-date">Due / Renewal date</label>
              <input type="date" id="track-due-date" value="${esc(r.due_date || "")}">
            </div>
          </div>

          <div>
            <label class="modal__field-label" for="track-evidence">Supporting document / Vault evidence</label>
            <select id="track-evidence">
              <option value="">-- No document attached --</option>
              <option value="aadhaar" ${r.evidence_doc_id === "aadhaar" ? "selected" : ""}>Aadhaar Card (from Vault)</option>
              <option value="pan" ${r.evidence_doc_id === "pan" ? "selected" : ""}>PAN Card (from Vault)</option>
              <option value="gst" ${r.evidence_doc_id === "gst" ? "selected" : ""}>GST Certificate (from Vault)</option>
              <option value="udyam" ${r.evidence_doc_id === "udyam" ? "selected" : ""}>Udyam Certificate (from Vault)</option>
              <option value="bank" ${r.evidence_doc_id === "bank" ? "selected" : ""}>Bank Proof (from Vault)</option>
              <option value="other" ${r.evidence_doc_id === "other" ? "selected" : ""}>Other Vault Document</option>
            </select>
          </div>

          <div>
            <label class="modal__field-label" for="track-notes">Compliance notes</label>
            <textarea id="track-notes" placeholder="Add filing reference number, certificate ID, or compliance notes...">${esc(r.notes || "")}</textarea>
          </div>

          <div class="trackcard__grid">
            <div>
              <label class="modal__field-label" for="track-reminder-date">Reminder date</label>
              <input type="date" id="track-reminder-date" value="${esc(r.reminder_date || "")}">
            </div>
            <div style="display:flex; flex-direction:column; justify-content:center; padding-top:10px;">
              <label class="switchline" style="margin:0;">
                <input type="checkbox" id="track-reminder-enabled" class="switch" ${r.reminder_enabled ? "checked" : ""}>
                <span style="font-size:13.5px; font-weight:600;">Enable reminder</span>
              </label>
              <span class="reminder-note">* Local reminder configured. Email/push alerts require background worker.</span>
            </div>
          </div>

          <div class="trackcard__actions">
            <button type="button" class="btn btn--primary btn--sm" id="track-save-btn">Save changes</button>
          </div>
        </div>
      </div>

      <!-- Right Column: Applicability Explanation, Requirements & How to Register Roadmap -->
      <div class="modal__col">
        <div class="modal__field">
          <div class="modal__field-label">Why this result</div>
          <div class="modal__field-value">${esc(r.explanation)}</div>
        </div>

        <div class="modal__row-split">
          <div class="modal__field">
            <div class="modal__field-label">Frequency</div>
            <div class="modal__field-value">${esc(r.frequency || "Not specified")}</div>
          </div>
          <div class="modal__field">
            <div class="modal__field-label">Responsible authority</div>
            <div class="modal__field-value">${esc(r.authority || "Not specified")}</div>
          </div>
        </div>

        <div class="modal__field">
          <div class="modal__field-label">Documents typically required</div>
          <div class="modal__field-value">${documentsMarkup(r.documents)}</div>
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
      </div>
    </div>
  `;

  // Attach Save Handler for Progress Tracking
  const saveBtn = document.getElementById("track-save-btn");
  saveBtn.addEventListener("click", async () => {
    saveBtn.disabled = true;
    saveBtn.textContent = "Saving...";
    const msgEl = document.getElementById("track-msg");

    try {
      const progressVal = document.getElementById("track-progress").value;
      const dueDateVal = document.getElementById("track-due-date").value || null;
      const notesVal = document.getElementById("track-notes").value || null;
      const evidenceVal = document.getElementById("track-evidence").value || null;
      const reminderDateVal = document.getElementById("track-reminder-date").value || null;
      const reminderEnabledVal = document.getElementById("track-reminder-enabled").checked;

      const res = await apiFetch(`/api/profiles/${currentProfile.id}/results/${r.rule_id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          progress: progressVal,
          due_date: dueDateVal,
          notes: notesVal,
          evidence_doc_id: evidenceVal,
          reminder_date: reminderDateVal,
          reminder_enabled: reminderEnabledVal,
        }),
      });

      if (!res.ok) throw new Error("Could not save tracking updates.");
      const updated = await res.json();
      Object.assign(r, updated);

      const metaEl = document.querySelector(".modal__meta");
      if (metaEl) {
        metaEl.innerHTML = modalBadgesMarkup(r);
      }

      msgEl.classList.add("visible");
      setTimeout(() => msgEl.classList.remove("visible"), 2500);

      // Re-render dashboard behind modal to synchronize counts, calendar, and upcoming deadlines
      renderDashboard();
    } catch (err) {
      alert(err.message || "Failed to save changes.");
    } finally {
      saveBtn.disabled = false;
      saveBtn.textContent = "Save changes";
    }
  });

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

