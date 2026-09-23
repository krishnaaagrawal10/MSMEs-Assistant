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


class ComplianceResultOut(BaseModel):
    rule_id: str
    rule_name: str
    category: str
    status: str
    explanation: str
    frequency: Optional[str] = None
    authority: Optional[str] = None
    documents: Optional[list] = None
    source: str
    registration_steps: Optional[list[RegistrationStep]] = None
