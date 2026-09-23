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

    db.query(models.ComplianceResult).filter(models.ComplianceResult.profile_id == profile_id).delete()
    for r in results:
        db.add(models.ComplianceResult(
            profile_id=profile_id,
            rule_id=r["rule_id"],
            rule_name=r["rule_name"],
            category=r["category"],
            status=r["status"],
            explanation=r["explanation"],
            source=r["source"],
        ))
    db.commit()

    return results


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
    out = []
    for row in stored:
        rule = catalog.get(row.rule_id, {})
        out.append({
            "rule_id": row.rule_id,
            "rule_name": row.rule_name,
            "category": row.category,
            "status": row.status,
            "explanation": row.explanation,
            "frequency": rule.get("frequency"),
            "authority": rule.get("authority"),
            "documents": rule.get("documents", []),
            "source": row.source,
            "registration_steps": rule.get("registration_steps", []),
        })
    return out
