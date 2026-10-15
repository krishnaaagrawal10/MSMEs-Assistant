import os
import sys
import unittest
from datetime import datetime, date, timedelta
import sqlite3
from fastapi import HTTPException

# Add current dir to path
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import models
import schemas
from database import engine, SessionLocal
import main
from main import (
    signup, create_profile, generate_compliance, get_results,
    update_compliance_result, _get_owned_profile, _compute_deadline_status
)
from rule_engine import evaluate_profile, load_compliance_rules


class TestMSMEaseImprovements(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        models.Base.metadata.create_all(bind=engine)
        # Verify db schema has all required columns
        conn = sqlite3.connect("msmease.db")
        cr_cols = [c[1] for c in conn.execute("PRAGMA table_info(compliance_results)").fetchall()]
        conn.close()
        required_cols = [
            "applicability", "progress", "due_date", "notes",
            "evidence_doc_id", "reminder_date", "reminder_enabled",
            "act_section", "jurisdiction", "last_verified_date"
        ]
        for col in required_cols:
            assert col in cr_cols, f"Column '{col}' must be present in compliance_results"

    def setUp(self):
        self.db = SessionLocal()

    def tearDown(self):
        self.db.close()

    def test_01_legal_accuracy_fields_in_catalog(self):
        """Test that all rules have valid legal citations, official source URLs, and last verified dates."""
        rules = load_compliance_rules()
        self.assertEqual(len(rules), 22, "Should have 22 rules in catalog")
        for r in rules:
            self.assertTrue(r.get("source"), f"Rule {r['id']} must have official source URL")
            self.assertTrue(r["source"].startswith("http"), f"Rule {r['id']} source must be a valid URL")
            if not r.get("needs_verification"):
                self.assertTrue(r.get("act_section"), f"Verified rule {r['id']} must cite exact Act/Section")
                self.assertTrue(r.get("jurisdiction"), f"Verified rule {r['id']} must specify jurisdiction")
                self.assertTrue(r.get("last_verified_date"), f"Verified rule {r['id']} must specify last verified date")

    def test_02_applicability_explanations_improved(self):
        """Test that non-applicable explanations cite exact condition thresholds."""
        profile = {
            "business_type": "Manufacturing", "industry": "Textile",
            "state": "Tamil Nadu", "employees": 4, "turnover_lakhs": 15,
            "uses_power": True, "gst_registered": False,
            "udyam_registered": False, "factory_status": False,
        }
        results = evaluate_profile(profile)
        # EPF requires 20 employees
        epf = next(r for r in results if r["rule_id"] == "C004")
        self.assertEqual(epf["applicability"], "Not applicable")
        self.assertIn("employees (4) < threshold of 20", epf["explanation"])

        # GST requires 40 lakh turnover for manufacturing in TN
        gst = next(r for r in results if r["rule_id"] == "C001")
        self.assertEqual(gst["applicability"], "Not applicable")
        self.assertIn("turnover (15 lakh) < threshold of 40 lakh", gst["explanation"])

    def test_03_deadline_and_overdue_calculations(self):
        """Test accurate calculation of overdue, due soon, upcoming, and completed statuses."""
        today = date.today()
        past_date = (today - timedelta(days=5)).isoformat()
        soon_date = (today + timedelta(days=10)).isoformat()
        future_date = (today + timedelta(days=60)).isoformat()

        # 1. Past due date + Action required => Overdue
        is_od, status, delta = _compute_deadline_status("Action required", past_date)
        self.assertTrue(is_od)
        self.assertEqual(status, "overdue")
        self.assertEqual(delta, -5)

        # 2. Past due date + Completed => NOT overdue
        is_od, status, delta = _compute_deadline_status("Completed", past_date)
        self.assertFalse(is_od)
        self.assertEqual(status, "completed")
        self.assertIsNone(delta)

        # 3. Due within 30 days => due_soon
        is_od, status, delta = _compute_deadline_status("Action required", soon_date)
        self.assertFalse(is_od)
        self.assertEqual(status, "due_soon")
        self.assertEqual(delta, 10)

        # 4. Due in 60 days => upcoming
        is_od, status, delta = _compute_deadline_status("Action required", future_date)
        self.assertFalse(is_od)
        self.assertEqual(status, "upcoming")
        self.assertEqual(delta, 60)

        # 5. No date => none
        is_od, status, delta = _compute_deadline_status("Action required", None)
        self.assertFalse(is_od)
        self.assertEqual(status, "none")

    def test_04_user_authentication_and_isolation(self):
        """Test that user ownership is strictly enforced on profile and compliance endpoints."""
        email_a = f"test_a_{int(datetime.utcnow().timestamp())}@example.com"
        email_b = f"test_b_{int(datetime.utcnow().timestamp())}@example.com"

        # Create user A
        signup(schemas.UserCreate(email=email_a, password="password123", business_name="Business A"), self.db)
        user_a = self.db.query(models.User).filter_by(email=email_a).first()

        # Create user B
        signup(schemas.UserCreate(email=email_b, password="password123", business_name="Business B"), self.db)
        user_b = self.db.query(models.User).filter_by(email=email_b).first()

        # User A creates a profile
        profile_a = create_profile(
            schemas.BusinessProfileCreate(
                business_name="Business A", business_type="Manufacturing",
                industry="Auto Parts", state="Tamil Nadu",
                employees=15, turnover_lakhs=50.0, uses_power=True
            ),
            self.db,
            user_a
        )
        self.assertEqual(profile_a.user_id, user_a.id)

        # User B tries to view or update User A's profile => must raise 403 Forbidden
        with self.assertRaises(HTTPException) as cm:
            _get_owned_profile(profile_a.id, self.db, user_b)
        self.assertEqual(cm.exception.status_code, 403)

        with self.assertRaises(HTTPException) as cm:
            generate_compliance(profile_a.id, self.db, user_b)
        self.assertEqual(cm.exception.status_code, 403)

        with self.assertRaises(HTTPException) as cm:
            update_compliance_result(
                profile_a.id, "C001",
                schemas.ComplianceProgressUpdate(progress="Completed"),
                self.db, user_b
            )
        self.assertEqual(cm.exception.status_code, 403)

    def test_05_persistent_progress_tracking_and_safe_upsert(self):
        """Test updating progress, due date, notes, reminders via PATCH, and verifying persistence."""
        email = f"test_persist_{int(datetime.utcnow().timestamp())}@example.com"
        signup(schemas.UserCreate(email=email, password="password123", business_name="Persist Co"), self.db)
        user = self.db.query(models.User).filter_by(email=email).first()

        # 1. Create profile
        profile = create_profile(
            schemas.BusinessProfileCreate(
                business_name="Persist Co", business_type="Manufacturing",
                industry="Packaging", state="Tamil Nadu",
                employees=12, turnover_lakhs=45.0, uses_power=True
            ),
            self.db,
            user
        )

        # 2. Generate compliances
        results = generate_compliance(profile.id, self.db, user)
        self.assertEqual(len(results), 22)

        # 3. Update C001 (GST Registration) progress and due date
        past_due = (date.today() - timedelta(days=3)).isoformat()
        updated = update_compliance_result(
            profile.id, "C001",
            schemas.ComplianceProgressUpdate(
                progress="In progress",
                due_date=past_due,
                notes="GST application ARN: AA3309240012345 filed on portal",
                evidence_doc_id="gst",
                reminder_date=past_due,
                reminder_enabled=True
            ),
            self.db,
            user
        )
        self.assertEqual(updated["progress"], "In progress")
        self.assertEqual(updated["due_date"], past_due)
        self.assertTrue(updated["is_overdue"])
        self.assertEqual(updated["deadline_status"], "overdue")
        self.assertEqual(updated["notes"], "GST application ARN: AA3309240012345 filed on portal")
        self.assertEqual(updated["evidence_doc_id"], "gst")
        self.assertTrue(updated["reminder_enabled"])

        # 4. Fetch results via get_results and check persistence
        stored = get_results(profile.id, self.db, user)
        c001 = next(r for r in stored if r["rule_id"] == "C001")
        self.assertEqual(c001["progress"], "In progress")
        self.assertEqual(c001["notes"], "GST application ARN: AA3309240012345 filed on portal")
        self.assertTrue(c001["is_overdue"])

        # 5. Re-generate profile: verify safe upsert preserves user-saved progress & notes!
        results_regen = generate_compliance(profile.id, self.db, user)
        c001_regen = next(r for r in results_regen if r["rule_id"] == "C001")
        self.assertEqual(c001_regen["progress"], "In progress", "Regeneration must preserve user progress")
        self.assertEqual(c001_regen["notes"], "GST application ARN: AA3309240012345 filed on portal", "Regeneration must preserve user notes")
        self.assertEqual(c001_regen["due_date"], past_due, "Regeneration must preserve user due date")

        # 6. Mark Completed => verify it is no longer overdue
        done = update_compliance_result(
            profile.id, "C001",
            schemas.ComplianceProgressUpdate(progress="Completed"),
            self.db,
            user
        )
        self.assertEqual(done["progress"], "Completed")
        self.assertFalse(done["is_overdue"], "Completed compliance must never be marked overdue")
        self.assertEqual(done["deadline_status"], "completed")


if __name__ == "__main__":
    unittest.main()
