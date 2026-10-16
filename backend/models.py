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
    status = Column(String, nullable=False)  # Legacy combined status
    applicability = Column(String, nullable=False, default="Applicable")  # Applicable, Not applicable, Needs verification
    progress = Column(String, nullable=False, default="Action required")   # Action required, In progress, Submitted, Completed
    due_date = Column(String, nullable=True)                              # YYYY-MM-DD
    notes = Column(String, nullable=True)
    evidence_doc_id = Column(String, nullable=True)                       # Link to uploaded document or note
    reminder_date = Column(String, nullable=True)                         # YYYY-MM-DD
    reminder_enabled = Column(Boolean, default=False)
    act_section = Column(String, nullable=True)
    jurisdiction = Column(String, nullable=True)
    last_verified_date = Column(String, nullable=True)
    explanation = Column(String, nullable=False)
    source = Column(String, nullable=False)
    generated_at = Column(DateTime, default=datetime.utcnow)

    profile = relationship("BusinessProfile", back_populates="results")


class KnowledgeDocument(Base):
    __tablename__ = "knowledge_documents"

    id = Column(Integer, primary_key=True, index=True)
    doc_id = Column(String, unique=True, index=True, nullable=False)
    title = Column(String, nullable=False)
    filename = Column(String, nullable=True)
    file_type = Column(String, nullable=True)  # pdf, docx, txt, manual, rule_seed
    source_url = Column(String, nullable=True)
    source_authority = Column(String, nullable=True)
    jurisdiction_type = Column(String, nullable=False, default="central")  # central, state, UT
    jurisdiction = Column(String, nullable=False, default="Central")
    category = Column(String, nullable=True)
    law_name = Column(String, nullable=True)
    verification_status = Column(String, nullable=False, default="verified")  # verified, pending_verification, needs_verification
    total_chunks = Column(Integer, default=0)
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    chunks = relationship("KnowledgeChunk", back_populates="document", cascade="all, delete-orphan")


class KnowledgeChunk(Base):
    __tablename__ = "knowledge_chunks"

    id = Column(Integer, primary_key=True, index=True)
    chunk_id = Column(String, unique=True, index=True, nullable=False)
    document_id = Column(Integer, ForeignKey("knowledge_documents.id"), nullable=False)
    faiss_id = Column(Integer, unique=True, index=True, nullable=False)

    title = Column(String, nullable=False)
    text = Column(String, nullable=False)
    source_url = Column(String, nullable=True)
    source_authority = Column(String, nullable=True)
    jurisdiction_type = Column(String, nullable=False, default="central")
    jurisdiction = Column(String, nullable=False, default="Central")
    law_name = Column(String, nullable=True)
    section_reference = Column(String, nullable=True)
    effective_from = Column(String, nullable=True)
    effective_until = Column(String, nullable=True)
    last_verified_at = Column(String, nullable=True)
    verification_status = Column(String, nullable=False, default="verified")
    page_number = Column(Integer, nullable=True)
    language = Column(String, nullable=False, default="English")
    created_at = Column(DateTime, default=datetime.utcnow)

    document = relationship("KnowledgeDocument", back_populates="chunks")


