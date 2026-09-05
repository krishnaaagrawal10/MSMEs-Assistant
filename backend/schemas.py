from pydantic import BaseModel, Field
from typing import Optional
from datetime import datetime


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

    class Config:
        from_attributes = True
