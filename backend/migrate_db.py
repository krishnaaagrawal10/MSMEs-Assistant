import sqlite3
import shutil
import json
from pathlib import Path
from datetime import datetime

db_path = Path("msmease.db")
backup_dir = Path("backups")
backup_dir.mkdir(exist_ok=True)
timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
backup_path = backup_dir / f"msmease_backup_{timestamp}.db"

if not db_path.exists():
    raise FileNotFoundError(f"Database not found: {db_path.resolve()}")

# Always make a fresh safe backup before migration
shutil.copy2(db_path, backup_path)
print(f"Created safe database backup at {backup_path}")

conn = sqlite3.connect(db_path)

try:
    conn.execute("PRAGMA foreign_keys = ON")
    tables = {
        row[0]
        for row in conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table'"
        )
    }

    if "business_profiles" not in tables:
        raise RuntimeError("The business_profiles table does not exist.")

    if "users" not in tables:
        raise RuntimeError("The users table does not exist.")

    # 1. Ensure user_id column on business_profiles exists
    bp_columns = {
        row[1]
        for row in conn.execute("PRAGMA table_info(business_profiles)")
    }
    if "user_id" not in bp_columns:
        conn.execute(
            "ALTER TABLE business_profiles "
            "ADD COLUMN user_id INTEGER REFERENCES users(id)"
        )
        first_user = conn.execute("SELECT id FROM users ORDER BY id LIMIT 1").fetchone()
        if first_user:
            conn.execute(
                "UPDATE business_profiles SET user_id = ? WHERE user_id IS NULL",
                (first_user[0],)
            )

    # 2. Ensure compliance_results table and new columns exist
    if "compliance_results" in tables:
        cr_columns = {
            row[1]
            for row in conn.execute("PRAGMA table_info(compliance_results)")
        }

        new_columns = [
            ("applicability", "TEXT DEFAULT 'Applicable'"),
            ("progress", "TEXT DEFAULT 'Action required'"),
            ("due_date", "TEXT"),
            ("notes", "TEXT"),
            ("evidence_doc_id", "TEXT"),
            ("reminder_date", "TEXT"),
            ("reminder_enabled", "BOOLEAN DEFAULT 0"),
            ("act_section", "TEXT"),
            ("jurisdiction", "TEXT"),
            ("last_verified_date", "TEXT"),
        ]

        for col_name, col_def in new_columns:
            if col_name not in cr_columns:
                print(f"Adding column '{col_name}' to compliance_results...")
                conn.execute(f"ALTER TABLE compliance_results ADD COLUMN {col_name} {col_def}")

        # 3. Backfill compliance_results with legal and status data
        compliance_rules_path = Path("compliance_data.json")
        rules_dict = {}
        if compliance_rules_path.exists():
            with open(compliance_rules_path, "r", encoding="utf-8") as f:
                for r in json.load(f):
                    rules_dict[r["id"]] = r

        rows = conn.execute("SELECT id, rule_id, status FROM compliance_results").fetchall()
        for row_id, rule_id, status in rows:
            rule_meta = rules_dict.get(rule_id, {})
            # Determine applicability
            if "Not Applicable" in (status or ""):
                app = "Not applicable"
                prog = "Not applicable"
            elif "Needs Verification" in (status or "") or rule_meta.get("needs_verification"):
                app = "Needs verification"
                prog = "Action required"
            else:
                app = "Applicable"
                if "Already Registered" in (status or ""):
                    prog = "Completed"
                else:
                    prog = "Action required"

            act_section = rule_meta.get("act_section")
            jurisdiction = rule_meta.get("jurisdiction")
            last_verified = rule_meta.get("last_verified_date")

            conn.execute("""
                UPDATE compliance_results 
                SET applicability = ?,
                    progress = ?,
                    act_section = ?,
                    jurisdiction = ?,
                    last_verified_date = ?
                WHERE id = ?
            """, (app, prog, act_section, jurisdiction, last_verified, row_id))

    # 4. Create knowledge_documents and knowledge_chunks if not present
    conn.execute("""
        CREATE TABLE IF NOT EXISTS knowledge_documents (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            doc_id TEXT UNIQUE NOT NULL,
            title TEXT NOT NULL,
            filename TEXT,
            file_type TEXT,
            source_url TEXT,
            source_authority TEXT,
            jurisdiction_type TEXT NOT NULL DEFAULT 'central',
            jurisdiction TEXT NOT NULL DEFAULT 'Central',
            category TEXT,
            law_name TEXT,
            verification_status TEXT NOT NULL DEFAULT 'verified',
            total_chunks INTEGER DEFAULT 0,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    """)
    conn.execute("CREATE INDEX IF NOT EXISTS ix_knowledge_documents_doc_id ON knowledge_documents(doc_id)")

    conn.execute("""
        CREATE TABLE IF NOT EXISTS knowledge_chunks (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            chunk_id TEXT UNIQUE NOT NULL,
            document_id INTEGER NOT NULL REFERENCES knowledge_documents(id) ON DELETE CASCADE,
            faiss_id INTEGER UNIQUE NOT NULL,
            title TEXT NOT NULL,
            text TEXT NOT NULL,
            source_url TEXT,
            source_authority TEXT,
            jurisdiction_type TEXT NOT NULL DEFAULT 'central',
            jurisdiction TEXT NOT NULL DEFAULT 'Central',
            law_name TEXT,
            section_reference TEXT,
            effective_from TEXT,
            effective_until TEXT,
            last_verified_at TEXT,
            verification_status TEXT NOT NULL DEFAULT 'verified',
            page_number INTEGER,
            language TEXT NOT NULL DEFAULT 'English',
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    """)
    conn.execute("CREATE INDEX IF NOT EXISTS ix_knowledge_chunks_chunk_id ON knowledge_chunks(chunk_id)")
    conn.execute("CREATE INDEX IF NOT EXISTS ix_knowledge_chunks_faiss_id ON knowledge_chunks(faiss_id)")
    conn.execute("CREATE INDEX IF NOT EXISTS ix_knowledge_chunks_document_id ON knowledge_chunks(document_id)")

    conn.commit()
    print("Database migration completed successfully.")
    print("compliance_results columns:")
    for column in conn.execute("PRAGMA table_info(compliance_results)"):
        print(f" - {column[1]} ({column[2]})")
    print("knowledge_documents and knowledge_chunks tables verified.")


except Exception as e:
    conn.rollback()
    print(f"Migration error: {e}")
    raise
finally:
    conn.close()
