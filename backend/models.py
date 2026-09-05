"""
Stage 2 deliverable: Business Profile schema / database table design.
Stage 6 deliverable: stored compliance results, used as the "test evidence"
table that shows different profiles produce different results.
"""

from sqlalchemy import Column, Integer, String, Float, Boolean, DateTime, ForeignKey, JSON
from sqlalchemy.orm import relationship
from datetime import datetime

from database import Base


class BusinessProfile(Base):
    __tablename__ = "business_profiles"

    id = Column(Integer, primary_key=True, index=True)
    business_name = Column(String, nullable=False)

    # Core profile fields (Stage 2: required fields)
    business_type = Column(String, nullable=False)   # Manufacturing / Service / Trading
    industry = Column(String, nullable=False)         # e.g. "Textile Manufacturing"
    state = Column(String, nullable=False, default="Tamil Nadu")
    employees = Column(Integer, nullable=False)
    turnover_lakhs = Column(Float, nullable=False)     # annual turnover, INR lakhs

    # Boolean / registration fields (Stage 2: useful boolean fields)
    uses_power = Column(Boolean, default=True)
    gst_registered = Column(Boolean, default=False)
    udyam_registered = Column(Boolean, default=False)
    factory_status = Column(Boolean, default=False)

    created_at = Column(DateTime, default=datetime.utcnow)

    results = relationship("ComplianceResult", back_populates="profile", cascade="all, delete-orphan")


class ComplianceResult(Base):
    """
    Snapshot of what the rule engine returned for a profile at a point in time.
    Kept so Stage 6 (testing & review prep) has a persisted test-evidence trail,
    and so the dashboard can reload past results without re-running the engine.
    """
    __tablename__ = "compliance_results"

    id = Column(Integer, primary_key=True, index=True)
    profile_id = Column(Integer, ForeignKey("business_profiles.id"), nullable=False)

    rule_id = Column(String, nullable=False)
    rule_name = Column(String, nullable=False)
    category = Column(String, nullable=False)
    status = Column(String, nullable=False)     # Applicable / Not Applicable
    explanation = Column(String, nullable=False)
    source = Column(String, nullable=False)
    generated_at = Column(DateTime, default=datetime.utcnow)

    profile = relationship("BusinessProfile", back_populates="results")
