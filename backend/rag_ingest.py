"""
Document Ingestion & Text Processing Pipeline for MSMEase FAISS RAG.
Supports:
- PDF (via pypdf with page number tracking)
- DOCX (via python-docx)
- Plain text / Markdown
- Compliance rule records / dictionaries
- Official source URLs (HTML text stripping)
Extracts structure, splits into overlapping semantic chunks, embeds,
stores in SQLite (KnowledgeDocument & KnowledgeChunk), and indexes in FAISS.
"""

import io
import re
import uuid
import logging
import urllib.request
from datetime import datetime
from typing import List, Dict, Any, Optional, Tuple
from sqlalchemy.orm import Session

from models import KnowledgeDocument, KnowledgeChunk
from rag_config import RAG_CHUNK_SIZE, RAG_CHUNK_OVERLAP, ALL_INDIAN_STATES, ALL_UNION_TERRITORIES
from rag_embeddings import get_embeddings_batch
import rag_store

logger = logging.getLogger("rag_ingest")


def determine_jurisdiction_type(jurisdiction: str) -> str:
    """Classifies jurisdiction into 'central', 'state', or 'UT'."""
    clean = (jurisdiction or "").strip().lower()
    if not clean or "central" in clean or "all india" in clean or "national" in clean:
        return "central"
    for ut in ALL_UNION_TERRITORIES:
        if ut.lower() in clean:
            return "UT"
    return "state"



def extract_text_from_pdf(file_bytes: bytes) -> List[Tuple[int, str]]:
    """
    Extracts text page by page from PDF bytes using pypdf.
    Returns list of (page_number, text).
    """
    from pypdf import PdfReader
    pages_text: List[Tuple[int, str]] = []
    reader = PdfReader(io.BytesIO(file_bytes))
    for idx, page in enumerate(reader.pages):
        text = page.extract_text() or ""
        text = clean_text(text)
        if text:
            pages_text.append((idx + 1, text))
    return pages_text


def extract_text_from_docx(file_bytes: bytes) -> str:
    """Extracts text from DOCX bytes using python-docx."""
    import docx
    doc = docx.Document(io.BytesIO(file_bytes))
    full_text = []
    for para in doc.paragraphs:
        t = para.text.strip()
        if t:
            full_text.append(t)
    return clean_text("\n\n".join(full_text))


def extract_text_from_url(url: str, timeout: int = 10) -> str:
    """Fetches URL and strips HTML tags, extracting body text."""
    req = urllib.request.Request(
        url,
        headers={"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) MSMEaseCompliance/1.0"}
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        raw_html = resp.read().decode("utf-8", errors="ignore")

    # Simple HTML cleaning: remove script/style then strip tags
    no_scripts = re.sub(r"<(script|style)[^>]*>.*?</\1>", " ", raw_html, flags=re.DOTALL | re.IGNORECASE)
    no_tags = re.sub(r"<[^>]+>", " ", no_scripts)
    return clean_text(no_tags)


def clean_text(text: str) -> str:
    """Removes irrelevant headers, repetitive blank lines, and normalizes whitespace."""
    if not text:
        return ""
    # Normalize multiple newlines and spaces
    text = re.sub(r"\r\n|\r", "\n", text)
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def extract_legal_references(text: str) -> Tuple[Optional[str], Optional[str]]:
    """
    Attempts to identify Act name and Section / Rule references from text snippet.
    """
    act_match = re.search(r"([A-Z][A-Za-z\s,]+(?:Act|Rules|Code|Regulation|Order),\s*\d{4})", text)
    sec_match = re.search(r"(Section\s+\d+[A-Za-z0-9\(\)]*|Rule\s+\d+[A-Za-z0-9\(\)]*|Schedule\s+[A-Z0-9]+)", text, re.IGNORECASE)

    law_name = act_match.group(1).strip() if act_match else None
    sec_ref = sec_match.group(1).strip() if sec_match else None
    return law_name, sec_ref


def split_text_into_chunks(text: str, chunk_size: int = RAG_CHUNK_SIZE, overlap: int = RAG_CHUNK_OVERLAP) -> List[str]:
    """
    Splits text into overlapping semantic passages.
    Prioritizes splitting on paragraphs, clauses, or periods.
    """
    if len(text) <= chunk_size:
        return [text] if text.strip() else []

    paragraphs = re.split(r"\n\s*\n", text)
    chunks = []
    current_chunk = ""

    for para in paragraphs:
        para = para.strip()
        if not para:
            continue

        if len(current_chunk) + len(para) + 2 <= chunk_size:
            current_chunk = f"{current_chunk}\n\n{para}".strip()
        else:
            if current_chunk:
                chunks.append(current_chunk)
                # Overlap: keep tail of current_chunk
                if overlap > 0 and len(current_chunk) > overlap:
                    tail = current_chunk[-overlap:]
                    current_chunk = f"{tail}\n{para}"
                else:
                    current_chunk = para
            else:
                # Single paragraph exceeds chunk_size, split by sentences
                sentences = re.split(r"(?<=[.!?])\s+", para)
                for sent in sentences:
                    if len(current_chunk) + len(sent) + 1 <= chunk_size:
                        current_chunk = f"{current_chunk} {sent}".strip()
                    else:
                        if current_chunk:
                            chunks.append(current_chunk)
                            current_chunk = sent
                        else:
                            # Hard split if sentence itself is longer than chunk_size
                            chunks.append(sent[:chunk_size])
                            current_chunk = sent[chunk_size:]

    if current_chunk.strip():
        chunks.append(current_chunk.strip())

    return [c for c in chunks if len(c.strip()) > 30]


def generate_stable_faiss_id(chunk_id: str) -> int:
    """Generates a positive 63-bit integer from chunk_id string for FAISS IndexIDMap2."""
    import zlib
    # Use crc32 + high bits from uuid hash to avoid collisions while fitting in int64
    crc = zlib.crc32(chunk_id.encode("utf-8"))
    # Ensure strictly positive
    return abs(crc)


def ingest_document_content(
    db: Session,
    title: str,
    raw_content: str,
    doc_id: Optional[str] = None,
    filename: Optional[str] = None,
    file_type: str = "text",
    source_url: Optional[str] = None,
    source_authority: Optional[str] = None,
    jurisdiction: str = "Central",
    category: Optional[str] = "General",
    law_name: Optional[str] = None,
    verification_status: str = "verified",
    pages_data: Optional[List[Tuple[int, str]]] = None,
    effective_from: Optional[str] = None,
    effective_until: Optional[str] = None
) -> Dict[str, Any]:
    """
    Ingests, chunks, embeds, and indexes a compliance document into DB and FAISS.
    Handles duplicate doc_id by updating cleanly.
    """
    if not doc_id:
        doc_id = f"doc_{uuid.uuid4().hex[:12]}"

    jurisdiction_type = determine_jurisdiction_type(jurisdiction)

    # 1. Check if document exists and clean up old chunks from FAISS & DB
    existing_doc = db.query(KnowledgeDocument).filter(KnowledgeDocument.doc_id == doc_id).first()
    if existing_doc:
        old_faiss_ids = [c.faiss_id for c in existing_doc.chunks]
        rag_store.remove_vectors(old_faiss_ids)
        db.delete(existing_doc)
        db.commit()

    # 2. Create KnowledgeDocument record
    doc_record = KnowledgeDocument(
        doc_id=doc_id,
        title=title,
        filename=filename,
        file_type=file_type,
        source_url=source_url,
        source_authority=source_authority,
        jurisdiction_type=jurisdiction_type,
        jurisdiction=jurisdiction,
        category=category,
        law_name=law_name,
        verification_status=verification_status,
        total_chunks=0
    )
    db.add(doc_record)
    db.flush()

    # 3. Create Chunks
    chunk_objects = []
    chunk_texts = []
    faiss_ids = []

    if pages_data:
        # Structured PDF with pages
        for page_num, page_text in pages_data:
            chunks = split_text_into_chunks(page_text)
            for i, c_text in enumerate(chunks):
                cid = f"{doc_id}_p{page_num}_c{i+1}"
                fid = generate_stable_faiss_id(cid)
                c_law, c_sec = extract_legal_references(c_text)
                
                chunk_obj = KnowledgeChunk(
                    chunk_id=cid,
                    document_id=doc_record.id,
                    faiss_id=fid,
                    title=f"{title} (Page {page_num})",
                    text=c_text,
                    source_url=source_url,
                    source_authority=source_authority,
                    jurisdiction_type=jurisdiction_type,
                    jurisdiction=jurisdiction,
                    law_name=law_name or c_law,
                    section_reference=c_sec,
                    effective_from=effective_from,
                    effective_until=effective_until,
                    last_verified_at=datetime.utcnow().strftime("%Y-%m-%d"),
                    verification_status=verification_status,
                    page_number=page_num,
                    language="English"
                )
                chunk_objects.append(chunk_obj)
                chunk_texts.append(f"{title}\n{law_name or ''}\n{c_text}")
                faiss_ids.append(fid)
    else:
        # Plain text / docx / rule text
        chunks = split_text_into_chunks(raw_content)
        for i, c_text in enumerate(chunks):
            cid = f"{doc_id}_c{i+1}"
            fid = generate_stable_faiss_id(cid)
            c_law, c_sec = extract_legal_references(c_text)

            chunk_obj = KnowledgeChunk(
                chunk_id=cid,
                document_id=doc_record.id,
                faiss_id=fid,
                title=f"{title} (Part {i+1})",
                text=c_text,
                source_url=source_url,
                source_authority=source_authority,
                jurisdiction_type=jurisdiction_type,
                jurisdiction=jurisdiction,
                law_name=law_name or c_law,
                section_reference=c_sec,
                effective_from=effective_from,
                effective_until=effective_until,
                last_verified_at=datetime.utcnow().strftime("%Y-%m-%d"),
                verification_status=verification_status,
                page_number=None,
                language="English"
            )
            chunk_objects.append(chunk_obj)
            chunk_texts.append(f"{title}\n{law_name or ''}\n{c_text}")
            faiss_ids.append(fid)

    if chunk_objects:
        db.add_all(chunk_objects)
        doc_record.total_chunks = len(chunk_objects)
        db.commit()

        # 4. Generate batch embeddings and add to FAISS
        embeddings = get_embeddings_batch(chunk_texts)
        rag_store.add_vectors(embeddings, faiss_ids)

    return {
        "status": "success",
        "doc_id": doc_id,
        "title": title,
        "total_chunks": len(chunk_objects),
        "jurisdiction": jurisdiction,
        "verification_status": verification_status
    }


def delete_knowledge_document(db: Session, doc_id: str) -> bool:
    """Removes a document and its chunks from both SQLite and FAISS."""
    doc = db.query(KnowledgeDocument).filter(KnowledgeDocument.doc_id == doc_id).first()
    if not doc:
        return False

    faiss_ids = [c.faiss_id for c in doc.chunks]
    rag_store.remove_vectors(faiss_ids)
    db.delete(doc)
    db.commit()
    return True
