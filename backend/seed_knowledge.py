"""
Knowledge Base Seeder for MSMEase FAISS RAG System.
Populates the knowledge base with official central and state compliance rules
from compliance_data.json into SQLite and FAISS.
"""

import json
import logging
from pathlib import Path

from database import SessionLocal
from rag_ingest import ingest_document_content
import rag_store

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("seed_knowledge")


def seed_rules_knowledge_base():
    """Reads compliance_data.json and seeds KnowledgeDocuments and KnowledgeChunks."""
    rules_file = Path(__file__).resolve().parent / "compliance_data.json"
    if not rules_file.exists():
        logger.error("compliance_data.json not found at %s", rules_file)
        return

    with open(rules_file, "r", encoding="utf-8") as f:
        rules = json.load(f)

    db = SessionLocal()
    try:
        logger.info("Starting ingestion of %d compliance rules...", len(rules))
        seeded_count = 0
        total_chunks = 0

        for r in rules:
            rule_id = r["id"]
            name = r["name"]
            category = r.get("category", "General")
            jurisdiction = r.get("jurisdiction", "Central")
            authority = r.get("authority", "Government of India")
            source_url = r.get("source", "")
            act_section = r.get("act_section", "")
            last_verified = r.get("last_verified_date")
            is_unverified = r.get("needs_verification", False)
            verification_status = "needs_verification" if is_unverified else "verified"

            # Build a structured legal and operational passage
            doc_lines = [
                f"# {name} ({rule_id})",
                f"**Category:** {category}",
                f"**Jurisdiction:** {jurisdiction}",
                f"**Statutory Authority:** {authority}",
                f"**Legal Act & Section:** {act_section}",
                f"**Official Source:** {source_url}",
                f"**Verification Status:** {'Needs verification' if is_unverified else 'Verified'}",
                "",
                "## Overview & Requirement",
                r.get("description", ""),
                "",
                "## Applicability Conditions"
            ]

            # Conditions
            for i, group in enumerate(r.get("condition_groups", []), 1):
                conds = []
                if "min_employees" in group:
                    conds.append(f"Employees >= {group['min_employees']}")
                if "max_employees" in group:
                    conds.append(f"Employees <= {group['max_employees']}")
                if "min_turnover_lakhs" in group:
                    conds.append(f"Turnover >= ₹{group['min_turnover_lakhs']} Lakhs")
                if "business_type" in group:
                    conds.append(f"Business Type: {', '.join(group['business_type'])}")
                if "uses_power" in group:
                    conds.append(f"Uses Power: {group['uses_power']}")
                if "state" in group:
                    conds.append(f"State: {', '.join(group['state'])}")
                doc_lines.append(f"- Group {i}: " + "; ".join(conds))

            # Documents
            docs = r.get("documents", [])
            if docs:
                doc_lines.append("")
                doc_lines.append("## Required Documents")
                for d in docs:
                    doc_lines.append(f"- {d}")

            # Steps
            steps = r.get("registration_steps", [])
            if steps:
                doc_lines.append("")
                doc_lines.append("## Registration Procedure")
                for s_idx, s in enumerate(steps, 1):
                    doc_lines.append(f"{s_idx}. **{s.get('title', '')}**: {s.get('description', '')}")

            # Penalties
            penalties = r.get("penalties")
            if penalties:
                doc_lines.append("")
                doc_lines.append("## Statutory Penalties for Non-Compliance")
                doc_lines.append(str(penalties))

            full_content = "\n".join(doc_lines)

            # Ingest
            res = ingest_document_content(
                db=db,
                title=f"{name} ({rule_id})",
                raw_content=full_content,
                doc_id=f"rule_{rule_id.lower()}",
                file_type="rule_seed",
                source_url=source_url,
                source_authority=authority,
                jurisdiction=jurisdiction,
                category=category,
                law_name=act_section,
                verification_status=verification_status
            )
            seeded_count += 1
            total_chunks += res.get("total_chunks", 0)

        logger.info("Successfully seeded %d rules with %d total chunks into knowledge base!", seeded_count, total_chunks)
        stats = rag_store.get_index_stats()
        logger.info("FAISS Index Stats: %s", stats)
    finally:
        db.close()


if __name__ == "__main__":
    seed_rules_knowledge_base()
