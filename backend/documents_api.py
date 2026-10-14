"""
Reference implementation of the Documents + Vault API (see API_CONTRACT.md).

This file has no imports from the rest of the project, so it can be dropped
into your backend. You pass in the three things it needs:

    # main.py (before models.Base.metadata.create_all(...))
    import documents_api
    doc_models = documents_api.define_models(Base)

    # main.py (after get_current_user is defined)
    app.include_router(documents_api.build_router(get_db, get_current_user, doc_models))

`get_current_user` must return an object with an integer `.id`, the same
dependency your other protected endpoints already use.

What this code deliberately does NOT do: open, parse, log or inspect the blobs.
They are encrypted in the owner's browser and the server cannot read them.
"""

import json
from datetime import datetime
from types import SimpleNamespace
from typing import Optional

from fastapi import APIRouter, Depends, File, Form, HTTPException, Response, UploadFile
from sqlalchemy import Column, DateTime, Integer, LargeBinary, String, Text, UniqueConstraint
from sqlalchemy.orm import Session

ALLOWED_DOC_TYPES = {"aadhaar", "pan", "gst", "udyam", "bank", "other"}
ALLOWED_STATUSES = {"verified", "needs_review", "not_checked"}
MAX_BLOB_BYTES = 12 * 1024 * 1024  # the frontend caps files at 8 MB before encryption


def define_models(Base):
    """Create the two tables on your existing SQLAlchemy Base."""

    class UserVault(Base):
        __tablename__ = "user_vaults"
        user_id = Column(Integer, primary_key=True)
        params_json = Column(Text, nullable=False)   # public vault parameters
        created_at = Column(DateTime, default=datetime.utcnow)

    class UserDocument(Base):
        __tablename__ = "user_documents"
        __table_args__ = (UniqueConstraint("user_id", "doc_type", name="uq_user_doctype"),)
        id = Column(Integer, primary_key=True)
        user_id = Column(Integer, index=True, nullable=False)
        doc_type = Column(String, nullable=False)
        status = Column(String, nullable=False)
        detected_type = Column(String)
        method = Column(String)
        checked_at = Column(String)
        iv_b64 = Column(String)
        blob = Column(LargeBinary)                    # ciphertext only
        size_bytes = Column(Integer)
        updated_at = Column(DateTime, default=datetime.utcnow)

    return SimpleNamespace(UserVault=UserVault, UserDocument=UserDocument)


def _record(row) -> dict:
    return {
        "doc_type": row.doc_type,
        "status": row.status,
        "detected_type": row.detected_type,
        "method": row.method,
        "checked_at": row.checked_at,
        "has_encrypted_copy": row.blob is not None,
        "size_bytes": row.size_bytes,
        "iv_b64": row.iv_b64 if row.blob is not None else None,
        "updated_at": row.updated_at.isoformat() + "Z" if row.updated_at else None,
    }


def build_router(get_db, get_current_user, models) -> APIRouter:
    router = APIRouter()
    UserVault, UserDocument = models.UserVault, models.UserDocument

    def check_type(doc_type: str):
        if doc_type not in ALLOWED_DOC_TYPES:
            raise HTTPException(status_code=422, detail="Unknown document type")

    # ------------------------------------------------------------ vault
    @router.get("/api/vault")
    def get_vault(db: Session = Depends(get_db), user=Depends(get_current_user)):
        row = db.query(UserVault).filter_by(user_id=user.id).first()
        if not row:
            raise HTTPException(status_code=404, detail="No vault yet")
        return json.loads(row.params_json)

    @router.put("/api/vault")
    def put_vault(params: dict, db: Session = Depends(get_db), user=Depends(get_current_user)):
        if not params.get("salt_b64") or not params.get("kdf") or not params.get("check"):
            raise HTTPException(status_code=422, detail="Vault parameters are incomplete")
        if db.query(UserVault).filter_by(user_id=user.id).first():
            # Never overwrite: it would make every stored document undecryptable.
            raise HTTPException(status_code=409, detail="A vault already exists for this account")
        db.add(UserVault(user_id=user.id, params_json=json.dumps(params)))
        db.commit()
        return Response(status_code=204)

    @router.delete("/api/vault")
    def delete_vault(db: Session = Depends(get_db), user=Depends(get_current_user)):
        db.query(UserDocument).filter_by(user_id=user.id).delete()
        db.query(UserVault).filter_by(user_id=user.id).delete()
        db.commit()
        return Response(status_code=204)

    # ------------------------------------------------------------ documents
    @router.get("/api/documents")
    def list_documents(db: Session = Depends(get_db), user=Depends(get_current_user)):
        rows = db.query(UserDocument).filter_by(user_id=user.id).all()
        return [_record(r) for r in rows]

    @router.put("/api/documents/{doc_type}")
    async def put_document(
        doc_type: str,
        verdict: str = Form(...),
        iv: Optional[str] = Form(None),
        file: Optional[UploadFile] = File(None),
        db: Session = Depends(get_db),
        user=Depends(get_current_user),
    ):
        check_type(doc_type)
        try:
            v = json.loads(verdict)
        except ValueError:
            raise HTTPException(status_code=422, detail="verdict must be JSON")
        if v.get("status") not in ALLOWED_STATUSES:
            raise HTTPException(status_code=422, detail="Invalid verdict status")

        blob = None
        if file is not None:
            if not iv:
                raise HTTPException(status_code=422, detail="iv is required with a file")
            blob = await file.read(MAX_BLOB_BYTES + 1)
            if len(blob) > MAX_BLOB_BYTES:
                raise HTTPException(status_code=413, detail="That file is too large")

        row = db.query(UserDocument).filter_by(user_id=user.id, doc_type=doc_type).first()
        if not row:
            row = UserDocument(user_id=user.id, doc_type=doc_type)
            db.add(row)
        row.status = v["status"]
        row.detected_type = v.get("detected_type")
        row.method = v.get("method")
        row.checked_at = v.get("checked_at")
        row.iv_b64 = iv if blob is not None else None
        row.blob = blob
        row.size_bytes = len(blob) if blob is not None else None
        row.updated_at = datetime.utcnow()
        db.commit()
        db.refresh(row)
        return _record(row)

    @router.get("/api/documents/{doc_type}/blob")
    def get_blob(doc_type: str, db: Session = Depends(get_db), user=Depends(get_current_user)):
        check_type(doc_type)
        row = db.query(UserDocument).filter_by(user_id=user.id, doc_type=doc_type).first()
        if not row or row.blob is None:
            raise HTTPException(status_code=404, detail="No stored copy")
        return Response(content=row.blob, media_type="application/octet-stream")

    @router.delete("/api/documents/{doc_type}")
    def delete_document(doc_type: str, db: Session = Depends(get_db), user=Depends(get_current_user)):
        check_type(doc_type)
        db.query(UserDocument).filter_by(user_id=user.id, doc_type=doc_type).delete()
        db.commit()
        return Response(status_code=204)

    return router
