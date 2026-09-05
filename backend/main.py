"""
MSMEase — Review 1 backend.

Endpoints
---------
POST /api/profiles              create a business profile
GET  /api/profiles/{id}         fetch a profile
POST /api/profiles/{id}/generate  run the rule engine, store + return results
GET  /api/profiles/{id}/results   fetch the latest stored results
GET  /api/compliance-catalog     the raw knowledge base (for reference/debug)
GET  /api/health                 liveness check
"""

from fastapi import FastAPI, Depends, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy.orm import Session

import models
import schemas
from database import engine, get_db
from rule_engine import evaluate_profile, load_compliance_rules

models.Base.metadata.create_all(bind=engine)

app = FastAPI(title="MSMEase API", version="0.1.0-review1")

# Wide-open CORS for the Review-1 prototype (frontend runs from a static file
# or a different port). Tighten this before any real deployment.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/api/health")
def health():
    return {"status": "ok"}


@app.get("/api/compliance-catalog")
def compliance_catalog():
    return load_compliance_rules()


@app.post("/api/profiles", response_model=schemas.BusinessProfileOut)
def create_profile(profile: schemas.BusinessProfileCreate, db: Session = Depends(get_db)):
    db_profile = models.BusinessProfile(**profile.model_dump())
    db.add(db_profile)
    db.commit()
    db.refresh(db_profile)
    return db_profile


@app.get("/api/profiles/{profile_id}", response_model=schemas.BusinessProfileOut)
def get_profile(profile_id: int, db: Session = Depends(get_db)):
    db_profile = db.query(models.BusinessProfile).filter(models.BusinessProfile.id == profile_id).first()
    if not db_profile:
        raise HTTPException(status_code=404, detail="Business profile not found")
    return db_profile


@app.post("/api/profiles/{profile_id}/generate", response_model=list[schemas.ComplianceResultOut])
def generate_compliance(profile_id: int, db: Session = Depends(get_db)):
    """Stage 4 + Stage 5: run the rule engine for a profile and persist the result set."""
    db_profile = db.query(models.BusinessProfile).filter(models.BusinessProfile.id == profile_id).first()
    if not db_profile:
        raise HTTPException(status_code=404, detail="Business profile not found")

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

    # Replace any previous snapshot for this profile so the dashboard always
    # reflects the latest profile inputs (per Stage 6: "results change when
    # profile inputs change").
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
def get_results(profile_id: int, db: Session = Depends(get_db)):
    stored = db.query(models.ComplianceResult).filter(models.ComplianceResult.profile_id == profile_id).all()
    if not stored:
        raise HTTPException(status_code=404, detail="No compliance results yet — call /generate first")

    # Re-attach frequency/authority/documents from the catalog for display,
    # since those aren't duplicated into the results table.
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
