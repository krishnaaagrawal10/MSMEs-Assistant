from pydantic import BaseModel, Field
from typing import Optional
from datetime import datetime


# ---------- auth ----------
class UserCreate(BaseModel):
    business_name: str = Field(..., min_length=2)
    email: str = Field(..., min_length=3)
    password: str = Field(..., min_length=6)


class UserLogin(BaseModel):
    email: str
    password: str


class UserOut(BaseModel):
    id: int
    business_name: str
    email: str
    created_at: datetime

    class Config:
        from_attributes = True


class Token(BaseModel):
    access_token: str
    token_type: str = "bearer"


# ---------- business profile ----------
class BusinessProfileCreate(BaseModel):
    business_name: str = Field(..., min_length=2)
    business_type: str = Field(..., description="Manufacturing | Service | Trading")
    industry: str = Field(..., min_length=2)
    state: str = "Tamil Nadu"
    employees: int = Field(..., ge=0)
    turnover_lakhs: float = Field(..., ge=0)
    uses_power: bool = True
    gst_registered: bool = False
    udyam_registered: bool = False
    factory_status: bool = False


class BusinessProfileOut(BusinessProfileCreate):
    id: int
    created_at: datetime

    class Config:
        from_attributes = True


# ---------- compliance results ----------
class RegistrationStep(BaseModel):
    title: str
    description: str


class ComplianceProgressUpdate(BaseModel):
    progress: Optional[str] = None
    due_date: Optional[str] = None
    notes: Optional[str] = None
    evidence_doc_id: Optional[str] = None
    reminder_date: Optional[str] = None
    reminder_enabled: Optional[bool] = None


class ComplianceResultOut(BaseModel):
    rule_id: str
    rule_name: str
    category: str
    status: str
    applicability: str = "Applicable"
    progress: str = "Action required"
    due_date: Optional[str] = None
    is_overdue: bool = False
    deadline_status: Optional[str] = "none"  # "overdue" | "due_soon" | "upcoming" | "completed" | "none"
    days_remaining: Optional[int] = None
    notes: Optional[str] = None
    evidence_doc_id: Optional[str] = None
    reminder_date: Optional[str] = None
    reminder_enabled: bool = False
    act_section: Optional[str] = None
    jurisdiction: Optional[str] = None
    last_verified_date: Optional[str] = None
    needs_verification: bool = False
    explanation: str
    frequency: Optional[str] = None
    authority: Optional[str] = None
    documents: Optional[list] = None
    source: str
    registration_steps: Optional[list[RegistrationStep]] = None

