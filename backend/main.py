"""
MSMEase backend, with login.

Public endpoints:
  POST /api/auth/signup
  POST /api/auth/login
  GET  /api/health

Everything else requires an "Authorization: Bearer <token>" header, and
only ever returns/modifies data that belongs to that logged-in user.
"""

from fastapi import FastAPI, Depends, HTTPException, Header
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy.orm import Session
from typing import Optional

import models
import schemas
from database import engine, get_db
from rule_engine import evaluate_profile, load_compliance_rules
from auth import hash_password, verify_password, create_token, decode_token
import documents_api
doc_models = documents_api.define_models(models.Base)

models.Base.metadata.create_all(bind=engine)

app = FastAPI(title="MSMEase API", version="0.2.0-with-login")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


def get_current_user(
    authorization: Optional[str] = Header(None),
    db: Session = Depends(get_db),
) -> models.User:
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Not authenticated")
    token = authorization.split(" ", 1)[1]
    user_id = decode_token(token)
    if user_id is None:
        raise HTTPException(status_code=401, detail="Invalid or expired session — please log in again")
    user = db.query(models.User).filter(models.User.id == user_id).first()
    if not user:
        raise HTTPException(status_code=401, detail="Account not found")
    return user


@app.get("/api/health")
def health():
    return {"status": "ok"}


@app.get("/api/compliance-catalog")
def compliance_catalog():
    return load_compliance_rules()


# ---------- auth ----------
@app.post("/api/auth/signup", response_model=schemas.Token)
def signup(payload: schemas.UserCreate, db: Session = Depends(get_db)):
    existing = db.query(models.User).filter(models.User.email == payload.email.lower()).first()
    if existing:
        raise HTTPException(status_code=400, detail="An account with this email already exists")

    user = models.User(
        business_name=payload.business_name,
        email=payload.email.lower(),
        password_hash=hash_password(payload.password),
    )
    db.add(user)
    db.commit()
    db.refresh(user)
    return {"access_token": create_token(user.id)}


@app.post("/api/auth/login", response_model=schemas.Token)
def login(payload: schemas.UserLogin, db: Session = Depends(get_db)):
    user = db.query(models.User).filter(models.User.email == payload.email.lower()).first()
    if not user or not verify_password(payload.password, user.password_hash):
        raise HTTPException(status_code=401, detail="Incorrect email or password")
    return {"access_token": create_token(user.id)}


@app.get("/api/auth/me", response_model=schemas.UserOut)
def me(current_user: models.User = Depends(get_current_user)):
    return current_user


# ---------- business profiles (all require login, all scoped to the user) ----------
@app.get("/api/profiles", response_model=list[schemas.BusinessProfileOut])
def list_my_profiles(
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    return (
        db.query(models.BusinessProfile)
        .filter(models.BusinessProfile.user_id == current_user.id)
        .order_by(models.BusinessProfile.created_at.desc())
        .all()
    )


@app.post("/api/profiles", response_model=schemas.BusinessProfileOut)
def create_profile(
    profile: schemas.BusinessProfileCreate,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    db_profile = models.BusinessProfile(**profile.model_dump(), user_id=current_user.id)
    db.add(db_profile)
    db.commit()
    db.refresh(db_profile)
    return db_profile


def _get_owned_profile(profile_id: int, db: Session, current_user: models.User) -> models.BusinessProfile:
    db_profile = db.query(models.BusinessProfile).filter(models.BusinessProfile.id == profile_id).first()
    if not db_profile:
        raise HTTPException(status_code=404, detail="Business profile not found")
    if db_profile.user_id != current_user.id:
        raise HTTPException(status_code=403, detail="This profile doesn't belong to your account")
    return db_profile


@app.get("/api/profiles/{profile_id}", response_model=schemas.BusinessProfileOut)
def get_profile(
    profile_id: int,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    return _get_owned_profile(profile_id, db, current_user)


from datetime import datetime, date


def _compute_deadline_status(progress: str, due_date: Optional[str]) -> tuple[bool, str, Optional[int]]:
    """
    Calculate overdue and deadline status.
    - If progress is 'Completed', deadline is marked as 'completed' (not overdue).
    - If due_date is missing or invalid, status is 'none'.
    - If due_date < today and not completed, status is 'overdue' (is_overdue = True).
    - If due_date >= today and within 30 days, status is 'due_soon'.
    - If due_date > 30 days away, status is 'upcoming'.
    """
    if progress == "Completed":
        return False, "completed", None
    if not due_date or not due_date.strip():
        return False, "none", None
    try:
        target = datetime.strptime(due_date.strip(), "%Y-%m-%d").date()
        today = date.today()
        delta = (target - today).days
        if delta < 0:
            return True, "overdue", delta
        elif delta <= 30:
            return False, "due_soon", delta
        else:
            return False, "upcoming", delta
    except ValueError:
        return False, "none", None


def _format_compliance_result(row: models.ComplianceResult, catalog: dict) -> dict:
    rule = catalog.get(row.rule_id, {})
    is_overdue, deadline_status, days_remaining = _compute_deadline_status(row.progress, row.due_date)
    return {
        "rule_id": row.rule_id,
        "rule_name": row.rule_name,
        "category": row.category,
        "status": row.status,
        "applicability": row.applicability or "Applicable",
        "progress": row.progress or "Action required",
        "due_date": row.due_date,
        "is_overdue": is_overdue,
        "deadline_status": deadline_status,
        "days_remaining": days_remaining,
        "notes": row.notes,
        "evidence_doc_id": row.evidence_doc_id,
        "reminder_date": row.reminder_date,
        "reminder_enabled": bool(row.reminder_enabled),
        "act_section": row.act_section or rule.get("act_section"),
        "jurisdiction": row.jurisdiction or rule.get("jurisdiction"),
        "last_verified_date": row.last_verified_date or rule.get("last_verified_date"),
        "needs_verification": rule.get("needs_verification", False) or (row.applicability == "Needs verification"),
        "explanation": row.explanation,
        "frequency": rule.get("frequency"),
        "authority": rule.get("authority"),
        "documents": rule.get("documents", []),
        "source": row.source,
        "registration_steps": rule.get("registration_steps", []),
    }


@app.post("/api/profiles/{profile_id}/generate", response_model=list[schemas.ComplianceResultOut])
def generate_compliance(
    profile_id: int,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    db_profile = _get_owned_profile(profile_id, db, current_user)

    profile_dict = {
        "business_type": db_profile.business_type,
        "industry": db_profile.industry,
        "state": db_profile.state,
        "employees": db_profile.employees,
        "turnover_lakhs": db_profile.turnover_lakhs,
        "uses_power": db_profile.uses_power,
        "gst_registered": db_profile.gst_registered,
        "udyam_registered": db_profile.udyam_registered,
        "factory_status": db_profile.factory_status,
    }

    results = evaluate_profile(profile_dict)

    # Upsert logic: preserve any existing user customization (notes, progress, due dates, evidence, reminders)
    existing_rows = db.query(models.ComplianceResult).filter(models.ComplianceResult.profile_id == profile_id).all()
    existing_map = {row.rule_id: row for row in existing_rows}

    for r in results:
        rule_id = r["rule_id"]
        if rule_id in existing_map:
            row = existing_map[rule_id]
            row.rule_name = r["rule_name"]
            row.category = r["category"]
            row.explanation = r["explanation"]
            row.source = r["source"]
            row.act_section = r.get("act_section")
            row.jurisdiction = r.get("jurisdiction")
            row.last_verified_date = r.get("last_verified_date")
            row.applicability = r["applicability"]

            if r["applicability"] == "Not applicable":
                row.progress = "Not applicable"
                row.status = "Not Applicable"
            elif row.progress == "Not applicable":
                row.progress = r["progress"]
                row.status = r["status"]
            # If already customized by user (e.g. In progress, Completed), preserve existing progress!
        else:
            row = models.ComplianceResult(
                profile_id=profile_id,
                rule_id=r["rule_id"],
                rule_name=r["rule_name"],
                category=r["category"],
                status=r["status"],
                applicability=r["applicability"],
                progress=r["progress"],
                explanation=r["explanation"],
                source=r["source"],
                act_section=r.get("act_section"),
                jurisdiction=r.get("jurisdiction"),
                last_verified_date=r.get("last_verified_date"),
            )
            db.add(row)

    db.commit()

    catalog = {r["id"]: r for r in load_compliance_rules()}
    stored = db.query(models.ComplianceResult).filter(models.ComplianceResult.profile_id == profile_id).all()
    return [_format_compliance_result(row, catalog) for row in stored]


@app.get("/api/profiles/{profile_id}/results", response_model=list[schemas.ComplianceResultOut])
def get_results(
    profile_id: int,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    _get_owned_profile(profile_id, db, current_user)  # ownership check (raises 403/404)

    stored = db.query(models.ComplianceResult).filter(models.ComplianceResult.profile_id == profile_id).all()
    if not stored:
        raise HTTPException(status_code=404, detail="No compliance results yet — call /generate first")

    catalog = {r["id"]: r for r in load_compliance_rules()}
    return [_format_compliance_result(row, catalog) for row in stored]


@app.patch("/api/profiles/{profile_id}/results/{rule_id}", response_model=schemas.ComplianceResultOut)
def update_compliance_result(
    profile_id: int,
    rule_id: str,
    payload: schemas.ComplianceProgressUpdate,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    _get_owned_profile(profile_id, db, current_user)

    row = (
        db.query(models.ComplianceResult)
        .filter(models.ComplianceResult.profile_id == profile_id, models.ComplianceResult.rule_id == rule_id)
        .first()
    )
    if not row:
        raise HTTPException(status_code=404, detail="Compliance result not found")

    if payload.progress is not None:
        valid_progress = {"Action required", "In progress", "Submitted", "Completed"}
        if payload.progress not in valid_progress:
            raise HTTPException(
                status_code=422,
                detail=f"Invalid progress status '{payload.progress}'. Must be one of {sorted(valid_progress)}"
            )
        row.progress = payload.progress
        if payload.progress == "Completed":
            row.status = "Applicable — Completed"
        elif payload.progress == "Action required":
            row.status = "Applicable — Action Required"

    if payload.due_date is not None:
        clean_date = payload.due_date.strip() if payload.due_date else ""
        if clean_date:
            try:
                datetime.strptime(clean_date, "%Y-%m-%d")
                row.due_date = clean_date
            except ValueError:
                raise HTTPException(status_code=422, detail="Invalid due_date format. Expected YYYY-MM-DD")
        else:
            row.due_date = None

    if payload.notes is not None:
        row.notes = payload.notes.strip() if payload.notes else None

    if payload.evidence_doc_id is not None:
        row.evidence_doc_id = payload.evidence_doc_id.strip() if payload.evidence_doc_id else None

    if payload.reminder_date is not None:
        clean_rem = payload.reminder_date.strip() if payload.reminder_date else ""
        if clean_rem:
            try:
                datetime.strptime(clean_rem, "%Y-%m-%d")
                row.reminder_date = clean_rem
            except ValueError:
                raise HTTPException(status_code=422, detail="Invalid reminder_date format. Expected YYYY-MM-DD")
        else:
            row.reminder_date = None

    if payload.reminder_enabled is not None:
        row.reminder_enabled = payload.reminder_enabled

    db.commit()
    db.refresh(row)

    catalog = {r["id"]: r for r in load_compliance_rules()}
    return _format_compliance_result(row, catalog)


# ---------- documents + encrypted vault (OCR feature) ----------
app.include_router(documents_api.build_router(get_db, get_current_user, doc_models))