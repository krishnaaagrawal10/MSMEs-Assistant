# MSMEase — Review 1 Prototype (20% Milestone)

This is a working implementation of the workflow your roadmap defines for Review 1:

```
Business Profile  →  Rule Engine  →  Applicable Compliance List  →  Basic Dashboard
```

Everything here maps directly to Stages 1–6 in your PDF. Nothing outside the
"What is NOT required" list (OCR, RAG, chatbot, notifications, monitoring, etc.)
has been touched.

---

## 1. How the pieces fit together

```
┌─────────────────┐      ┌──────────────────┐      ┌────────────────────┐
│   FRONTEND       │      │   BACKEND (API)   │      │   KNOWLEDGE BASE    │
│  index.html      │ HTTP │   FastAPI          │      │ compliance_data.json│
│  style.css       │─────▶│   main.py          │─────▶│  22 rules, TN       │
│  app.js          │◀─────│   rule_engine.py   │◀─────│  manufacturing/     │
│                  │ JSON │   models.py (DB)   │      │  service pilot      │
└─────────────────┘      └──────────────────┘      └────────────────────┘
                                    │
                                    ▼
                          SQLite: msmease.db
                    (business_profiles, compliance_results)
```

**Request flow when a user submits the form:**

1. Browser (`app.js`) sends the form as JSON to `POST /api/profiles`.
2. Backend saves it as a row in `business_profiles` (Stage 2) and returns its `id`.
3. Browser calls `POST /api/profiles/{id}/generate`.
4. `rule_engine.py` loads all 22 rules from `compliance_data.json`, checks each
   one against the profile, and returns a result per rule (Stage 4).
5. Backend saves that result set into `compliance_results` (Stage 6 test evidence)
   and returns it as JSON.
6. Browser renders the dashboard: applicable items first, with category filters
   and a detail view per item (Stage 5).

---

## 2. File-by-file, and which roadmap stage it satisfies

| File | Roadmap stage | What it does |
|---|---|---|
| `backend/compliance_data.json` | **Stage 3** | 22 real compliance rules for the pilot scenario (Manufacturing/Service/Trading MSMEs, Tamil Nadu). Each rule has category, applicability conditions, frequency, authority, documents, and an official source URL. |
| `backend/models.py` | **Stage 2** | `BusinessProfile` table (the schema) and `ComplianceResult` table (stored results, used as test evidence). |
| `backend/schemas.py` | **Stage 2** | Validation rules for the profile form — e.g. employees ≥ 0, turnover ≥ 0, business name required. |
| `backend/database.py` | **Stage 2/6** | SQLite connection setup. |
| `backend/rule_engine.py` | **Stage 4** | The actual matching logic. Deterministic, explainable, and safe against missing/invalid fields (see §3 below). |
| `backend/main.py` | **Stage 4/5** | FastAPI endpoints that expose the profile store and rule engine to the frontend. |
| `backend/test_engine.py` | **Stage 6** | 5 test profiles run straight through the engine, printed as a table, with a pass/fail check that different profiles give different results. |
| `frontend/index.html` | **Stage 5** | Landing screen, profile form, dashboard, detail modal — the 4 screens the roadmap asks for. |
| `frontend/style.css` | **Stage 5** | Visual design. |
| `frontend/app.js` | **Stage 5** | Wires the form and dashboard to the backend via `fetch`. |

---

## 3. How the rule engine actually works

Every compliance rule has one or more **condition groups**. A rule is
**Applicable** if the business profile satisfies *at least one* group in full
(this is how "OR" logic gets expressed — e.g. the Factories Act license
triggers on **either** "10+ employees with power" **or** "20+ employees
without power"):

```json
{
  "id": "C003",
  "name": "Factory License",
  "condition_groups": [
    { "business_type": ["Manufacturing"], "uses_power": true,  "min_employees": 10 },
    { "business_type": ["Manufacturing"], "uses_power": false, "min_employees": 20 }
  ]
}
```

`rule_engine.evaluate_profile()` walks every rule, checks its groups against
the profile, and returns a plain-English reason for the decision (e.g.
*"Applicable because employees (15) >= 10 and uses power = True."*). That
explanation is exactly what Stage 4 asks for: **"keep the rule logic
explainable so a reviewer can see why a compliance was selected."**

If a profile field is missing, the engine treats it as `0`/`False` rather
than crashing — that's the "handle missing or invalid profile information
safely" requirement.

---

## 4. How to run it

### Backend
```bash
cd backend
pip install -r requirements.txt
python3 -m uvicorn main:app --reload --port 8000
```
This creates `msmease.db` automatically on first run. API docs are auto-generated
at `http://127.0.0.1:8000/docs` (FastAPI's Swagger UI) — useful for your demo,
since a reviewer can literally see and try every endpoint live.

### Frontend
In a second terminal:
```bash
cd frontend
python3 -m http.server 8080
```
Open `http://127.0.0.1:8080` in a browser. (Any static file server works —
this is plain HTML/CSS/JS, no build step needed.)

### Run the test cases (no server needed)
```bash
cd backend
python3 test_engine.py
```

---

## 5. Suggested Review-1 demo script (matches the PDF's recommended demo)

1. Open the frontend → landing page.
2. Click **"Build my compliance profile"** → fill in a manufacturing profile
   (e.g. Textile Manufacturing, Tamil Nadu, 15 employees, ₹60 lakh turnover,
   uses power, GST + Udyam already registered).
3. Submit → dashboard appears showing ~17 applicable items out of 22.
4. Click **GST Registration** → show the detail modal: reason, frequency,
   authority, and the official source link.
5. Go back to **New Profile**, change employees to 5 and turnover to ₹10 lakh,
   submit again → show the applicable count drop sharply (EPF, ESI, Factory
   License, Bonus Act, etc. disappear) — this is the "different profiles
   produce different results" success criterion from Stage 1.

---

## 6. Honest gaps for right now (so you're not caught off guard in review)

- Only Tamil Nadu is wired into the knowledge base and form (per your Stage 1
  "controlled pilot" scope — multi-state is explicitly out of scope for 20%).
- "Already registered" flags only exist for GST, Udyam, and Factory License.
  Extending that to every rule is easy (just add to `REGISTRATION_FLAG_FOR_RULE`
  in `rule_engine.py`) but wasn't needed to hit the 20% target.
- No authentication — intentionally, since the roadmap marks it optional for
  Review 1.
- The 22 rules were researched from current official/regulatory sources as of
  Sept 2026 (linked in `compliance_data.json`), but you should re-verify exact
  figures before treating this as legal advice for a real user — thresholds
  like GST/Udyam limits do get revised.

---

## 7. Natural next steps (for after Review 1 — not required now)

This is where OCR, the RAG/chatbot layer, and monitoring would plug in later,
per your proposal's four-layer architecture — the Business Profile table and
the compliance results table are already structured so those layers can be
added without reworking Stage 1–6.
