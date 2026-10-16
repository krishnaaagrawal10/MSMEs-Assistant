"""
RAG Retrieval & Grounded LLM Answering Engine for MSMEase.
Executes semantic retrieval with jurisdiction filtering, combines central and state
statutory laws, grounds the prompt in verified knowledge chunks, and returns
structured answers with official legal citations and regulatory disclaimers.
"""

import os
import re
import logging
from typing import List, Dict, Any, Optional
from sqlalchemy.orm import Session

from models import KnowledgeChunk, KnowledgeDocument
from rag_config import (
    RAG_TOP_K,
    LLM_PROVIDER,
    GEMINI_API_KEY,
    OPENAI_API_KEY
)
import rag_embeddings
import rag_store

logger = logging.getLogger("rag_llm")

LEGAL_DISCLAIMER = (
    "Disclaimer: MSMEase is an AI-powered regulatory assistant providing informational "
    "guidance based on indexed statutory provisions. This does not constitute certified legal, "
    "tax, or financial counsel. Please verify with official gazette notifications or a qualified professional."
)


def retrieve_relevant_passages(
    db: Session,
    query: str,
    jurisdiction: Optional[str] = None,
    category: Optional[str] = None,
    top_k: int = RAG_TOP_K
) -> List[Dict[str, Any]]:
    """
    Retrieves most relevant compliance passages from FAISS and SQLite.
    Applies jurisdiction filtering (Central regulations are always retained alongside State rules).
    """
    if not query.strip():
        return []

    q_vector = rag_embeddings.get_embedding(query)
    # Retrieve broader pool for filtering
    search_candidates = rag_store.search(q_vector, top_k=max(20, top_k * 4))
    if not search_candidates:
        return []

    faiss_id_map = {fid: score for fid, score in search_candidates}
    faiss_ids = list(faiss_id_map.keys())

    # Fetch chunks from DB
    chunks = db.query(KnowledgeChunk).filter(KnowledgeChunk.faiss_id.in_(faiss_ids)).all()

    filtered_chunks = []
    target_jurisdiction = jurisdiction.strip().lower() if jurisdiction else None
    target_category = category.strip().lower() if category else None

    for c in chunks:
        # Jurisdiction rule:
        # Keep if no specific jurisdiction requested OR chunk is central/national OR chunk matches target jurisdiction
        c_juris = (c.jurisdiction or "").strip().lower()
        c_type = (c.jurisdiction_type or "").strip().lower()
        if target_jurisdiction:
            is_central = (
                c_type == "central" 
                or "central" in c_juris 
                or "all india" in c_juris 
                or "india" in c_juris 
                or "national" in c_juris
            )
            is_match = (
                target_jurisdiction in c_juris 
                or c_juris in target_jurisdiction
            )
            if not (is_central or is_match):
                continue

        # Category rule

        if target_category and target_category != "all":
            if (c.law_name or "").lower().find(target_category) == -1 and target_category not in c.title.lower():
                pass

        score = faiss_id_map.get(c.faiss_id, 0.0)

        # Lexical boost for exact subject term matches in title, law name, and text
        stopwords = {
            "what", "is", "the", "are", "and", "in", "for", "to", "of", "a", "an", "on",
            "with", "by", "at", "from", "do", "does", "how", "can", "applicable", "apply",
            "requirement", "requirements", "compliance", "law", "statutory", "provisions"
        }
        jurisdiction_words = set(re.findall(r"\b[a-z0-9]+\b", target_jurisdiction or ""))
        q_words = {
            w for w in re.findall(r"\b[a-zA-Z0-9]{3,}\b", query.lower())
            if w not in stopwords and w not in jurisdiction_words
        }

        title_lower = c.title.lower()
        law_lower = (c.law_name or "").lower()
        text_lower = c.text.lower()

        title_matches = sum(1 for w in q_words if w in title_lower)
        law_matches = sum(1 for w in q_words if w in law_lower)
        text_matches = sum(1 for w in q_words if w in text_lower)

        lexical_boost = (title_matches * 0.35) + (law_matches * 0.25) + min(0.3, text_matches * 0.05)
        combined_score = score + lexical_boost

        filtered_chunks.append({

            "chunk_id": c.chunk_id,
            "faiss_id": c.faiss_id,
            "document_id": c.document_id,
            "title": c.title,
            "text": c.text,
            "source_url": c.source_url or "https://www.india.gov.in",
            "source_authority": c.source_authority or "Government Authority",
            "jurisdiction": c.jurisdiction,
            "jurisdiction_type": c.jurisdiction_type,
            "law_name": c.law_name or "Applicable Statutory Regulation",
            "section_reference": c.section_reference,
            "verification_status": c.verification_status,
            "page_number": c.page_number,
            "score": combined_score
        })

    # Sort by descending combined score
    filtered_chunks.sort(key=lambda x: x["score"], reverse=True)
    return filtered_chunks[:top_k]


def build_local_grounded_answer(query: str, passages: List[Dict[str, Any]], jurisdiction: Optional[str]) -> str:
    """
    Offline/local answer synthesizer: extracts legal citations, requirements,
    and procedures directly from retrieved passages without external LLM API dependency.
    """
    if not passages:
        return (
            "I could not locate specific verified statutory compliance provisions matching your query "
            f"for '{jurisdiction or 'India'}' in the local knowledge base.\n\n"
            "**Recommended Action:** Please check official government portals (e.g., udyamregistration.gov.in, "
            "gst.gov.in, epfindia.gov.in) or submit this document to MSMEase for administrative ingestion.\n\n"
            f"> [!NOTE]\n> {LEGAL_DISCLAIMER}"
        )

    # Compile synthesis from the most relevant passages
    primary = passages[0]
    ans_lines = [
        f"### Compliance Overview: {primary.get('title', 'Applicable Law')}",
        "",
        f"Based on **{primary.get('law_name', 'Applicable Act')}** under the authority of **{primary.get('source_authority', 'Regulatory Authority')}**:"
    ]

    # Extract bullet points or key facts from primary and secondary passages
    extracted_points = []
    for p in passages[:3]:
        text = p["text"]
        # Look for headers or bullet lines
        lines = [line.strip() for line in text.split("\n") if line.strip()]
        for line in lines:
            if line.startswith("-") or line.startswith("*") or line.startswith("1.") or line.startswith("2."):
                if line not in extracted_points:
                    extracted_points.append(line)
            elif any(k in line.lower() for k in ("threshold", "turnover", "employees", "mandatory", "penalty", "due date", "section")):
                if len(line) < 250 and line not in extracted_points:
                    extracted_points.append(f"- {line}")

    if extracted_points:
        ans_lines.append("")
        ans_lines.append("#### Key Provisions & Thresholds")
        ans_lines.extend(extracted_points[:6])
    else:
        # Fallback to snippet from top chunk
        ans_lines.append("")
        summary_snippet = primary["text"][:350].strip() + ("..." if len(primary["text"]) > 350 else "")
        ans_lines.append(f"> {summary_snippet}")

    # Add citations summary
    ans_lines.append("")
    ans_lines.append("#### Relevant Statutory Citation")
    for i, p in enumerate(passages[:2], 1):
        status_label = "Verified Law" if p.get("verification_status") == "verified" else "Needs verification"
        sec = f" | Section: {p['section_reference']}" if p.get('section_reference') else ""
        ans_lines.append(
            f"{i}. **{p.get('law_name') or p.get('title')}** ({p.get('jurisdiction')}){sec}\n"
            f"   - Authority: {p.get('source_authority')}\n"
            f"   - Official Portal: [{p.get('source_url')}]({p.get('source_url')})\n"
            f"   - Status: `{status_label}`"
        )

    ans_lines.append("")
    ans_lines.append(f"*{LEGAL_DISCLAIMER}*")
    return "\n".join(ans_lines)


def generate_llm_answer(
    query: str,
    passages: List[Dict[str, Any]],
    jurisdiction: Optional[str] = None
) -> Dict[str, Any]:
    """
    Constructs grounded prompt and queries configured LLM (Gemini / OpenAI / Local).
    Returns answer text and structured citations.
    """
    # 1. Structure citations
    citations = []
    for p in passages:
        citations.append({
            "chunk_id": p["chunk_id"],
            "title": p["title"],
            "law_name": p["law_name"],
            "section_reference": p.get("section_reference"),
            "source_authority": p["source_authority"],
            "source_url": p["source_url"],
            "jurisdiction": p["jurisdiction"],
            "jurisdiction_type": p["jurisdiction_type"],
            "verification_status": p["verification_status"],
            "page_number": p.get("page_number"),
            "relevance_score": round(p["score"], 3),
            "excerpt": p["text"][:220].strip() + ("..." if len(p["text"]) > 220 else "")
        })

    if not passages:
        return {
            "answer": build_local_grounded_answer(query, [], jurisdiction),
            "citations": [],
            "provider": "offline",
            "passages_count": 0
        }

    # 2. Build Grounded Context
    context_blocks = []
    for idx, p in enumerate(passages, 1):
        block = (
            f"[Source {idx}]\n"
            f"Title: {p['title']}\n"
            f"Act/Section: {p.get('law_name', '')} {p.get('section_reference', '')}\n"
            f"Jurisdiction: {p['jurisdiction']} ({p['jurisdiction_type']})\n"
            f"Authority: {p['source_authority']}\n"
            f"Official URL: {p['source_url']}\n"
            f"Status: {p['verification_status']}\n"
            f"Content:\n{p['text']}\n"
        )
        context_blocks.append(block)

    full_context = "\n---\n".join(context_blocks)

    system_prompt = (
        "You are MSMEase, an authoritative Indian legal compliance assistant for MSMEs.\n"
        "Your task is to answer the user's question using ONLY the provided verified legal passages.\n"
        "RULES:\n"
        "1. Strictly cite the applicable Act, Section, and issuing authority when stating legal obligations.\n"
        "2. State both Central regulations and State-specific rules where applicable.\n"
        "3. Never invent citation numbers, deadlines, or penalties. If a provision is not in the context, explicitly state: 'Information not specified in the current compliance index.'\n"
        "4. If a source is marked as 'Needs verification', highlight this clearly to the user.\n"
        f"5. Conclude your answer with this exact disclaimer:\n'{LEGAL_DISCLAIMER}'\n"
    )

    user_prompt = (
        f"User Jurisdiction: {jurisdiction or 'Central / All-India'}\n"
        f"Question: {query}\n\n"
        f"Compliance Passages:\n{full_context}\n\n"
        "Provide a clear, structured compliance answer with headings, applicability thresholds, required filings, and citations."
    )

    # 3. Call External LLM or Fallback to Local
    provider = LLM_PROVIDER
    if provider == "gemini" and GEMINI_API_KEY:
        try:
            import google.generativeai as genai
            genai.configure(api_key=GEMINI_API_KEY)
            model = genai.GenerativeModel(
                model_name="gemini-1.5-flash",
                system_instruction=system_prompt
            )
            resp = model.generate_content(user_prompt)
            answer_text = resp.text.strip()
            return {
                "answer": answer_text,
                "citations": citations,
                "provider": "gemini",
                "passages_count": len(passages)
            }
        except Exception as e:
            logger.warning("Gemini LLM call failed (%s). Falling back to local synthesizer.", e)

    elif provider == "openai" and OPENAI_API_KEY:
        try:
            import openai
            client = openai.OpenAI(api_key=OPENAI_API_KEY)
            resp = client.chat.completions.create(
                model="gpt-4o-mini",
                messages=[
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": user_prompt}
                ],
                temperature=0.2
            )
            answer_text = resp.choices[0].message.content.strip()
            return {
                "answer": answer_text,
                "citations": citations,
                "provider": "openai",
                "passages_count": len(passages)
            }
        except Exception as e:
            logger.warning("OpenAI LLM call failed (%s). Falling back to local synthesizer.", e)

    # Default: Grounded Local Synthesizer
    local_answer = build_local_grounded_answer(query, passages, jurisdiction)
    return {
        "answer": local_answer,
        "citations": citations,
        "provider": "local_synthesizer",
        "passages_count": len(passages)
    }
