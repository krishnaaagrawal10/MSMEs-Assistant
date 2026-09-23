"""
Stage 2 deliverable: Business Profile schema / database table design.
Stage 6 deliverable: stored compliance results, used as test evidence.
Login feature: adds a User table; every BusinessProfile now belongs to one.
"""

from sqlalchemy import Column, Integer, String, Float, Boolean, DateTime, ForeignKey
from sqlalchemy.orm import relationship
from datetime import datetime

from database import Base


class User(Base):
    __tablename__ = "users"

    id = Column(Integer, primary_key=True, index=True)
    business_name = Column(String, nullable=False)
    email = Column(String, unique=True, index=True, nullable=False)
    password_hash = Column(String, nullable=False)
    created_at = Column(DateTime, default=datetime.utcnow)

    profiles = relationship("BusinessProfile", back_populates="owner", cascade="all, delete-orphan")


class BusinessProfile(Base):
    __tablename__ = "business_profiles"

    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False)

    business_name = Column(String, nullable=False)
    business_type = Column(String, nullable=False)
    industry = Column(String, nullable=False)
    state = Column(String, nullable=False, default="Tamil Nadu")
    employees = Column(Integer, nullable=False)
    turnover_lakhs = Column(Float, nullable=False)

    uses_power = Column(Boolean, default=True)
    gst_registered = Column(Boolean, default=False)
    udyam_registered = Column(Boolean, default=False)
    factory_status = Column(Boolean, default=False)

    created_at = Column(DateTime, default=datetime.utcnow)

    owner = relationship("User", back_populates="profiles")
    results = relationship("ComplianceResult", back_populates="profile", cascade="all, delete-orphan")


class ComplianceResult(Base):
    __tablename__ = "compliance_results"

    id = Column(Integer, primary_key=True, index=True)
    profile_id = Column(Integer, ForeignKey("business_profiles.id"), nullable=False)

    rule_id = Column(String, nullable=False)
    rule_name = Column(String, nullable=False)
    category = Column(String, nullable=False)
    status = Column(String, nullable=False)
    explanation = Column(String, nullable=False)
    source = Column(String, nullable=False)
    generated_at = Column(DateTime, default=datetime.utcnow)

    profile = relationship("BusinessProfile", back_populates="results")
