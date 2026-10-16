"""
Embeddings generator for MSMEase FAISS RAG system.
Supports:
1. Local deterministic 384-dimensional semantic-feature vectorizer (zero-crash offline default)
2. Google Gemini ('text-embedding-004' with dimensions=384)
3. OpenAI ('text-embedding-3-small' with dimensions=384)
All vectors are L2-normalized so that inner product equals cosine similarity.
"""

import re
import math
import hashlib
import logging
from typing import List
import numpy as np

from rag_config import (
    FAISS_DIMENSION,
    EMBEDDING_PROVIDER,
    GEMINI_API_KEY,
    OPENAI_API_KEY
)

logger = logging.getLogger("rag_embeddings")

# Regulatory keyword weights for semantic projection in local mode
LEGAL_KEYWORDS = {
    "gst": 3.5, "udyam": 3.5, "epf": 3.5, "pf": 3.2, "esic": 3.5, "esi": 3.2,
    "factory": 3.0, "factories": 3.0, "shops": 3.0, "establishment": 3.0,
    "tnpcb": 3.5, "pollution": 3.0, "consent": 2.8, "cte": 3.0, "cto": 3.0,
    "gratuity": 3.2, "bonus": 3.0, "posh": 3.5, "maternity": 3.0,
    "minimum": 2.5, "wages": 2.8, "labour": 2.8, "labor": 2.8,
    "annual": 2.5, "return": 2.8, "challan": 2.8, "filing": 2.8,
    "penalty": 2.5, "prosecution": 2.8, "fine": 2.2, "imprisonment": 2.5,
    "section": 2.6, "rule": 2.4, "act": 2.4, "regulation": 2.4,
    "licence": 2.6, "license": 2.6, "registration": 2.8, "renewal": 2.6,
    "threshold": 2.5, "employees": 2.6, "turnover": 2.6, "lakhs": 2.0, "crore": 2.0,
    "tamil": 2.8, "nadu": 2.8, "state": 2.0, "central": 2.2, "union": 2.0,
    "professional": 2.8, "tax": 2.8, "fire": 2.5, "trade": 2.5, "safety": 2.5,
    "environment": 2.5, "hazard": 2.5, "audit": 2.4, "compliance": 2.2,
    "exemption": 2.6, "micro": 2.5, "small": 2.5, "medium": 2.5, "enterprise": 2.5
}


def _local_text_to_vector(text: str, dim: int = FAISS_DIMENSION) -> np.ndarray:
    """
    Computes a deterministic 384-dimensional dense semantic feature vector.
    Uses word n-grams, subword character n-grams, and statutory domain salience.
    Vectors are L2-normalized to enable fast cosine similarity with inner product.
    """
    vec = np.zeros(dim, dtype=np.float32)
    cleaned = (text or "").lower()
    words = re.findall(r"[a-z0-9]+", cleaned)
    if not words:
        # Avoid zero vector
        vec[0] = 1.0
        return vec

    # 1. Unigrams with statutory weighting
    for w in words:
        weight = LEGAL_KEYWORDS.get(w, 1.0)
        # Hash to dimension
        h = int(hashlib.md5(w.encode("utf-8")).hexdigest(), 16)
        idx = h % dim
        sign = 1.0 if ((h >> 12) & 1) else -1.0
        vec[idx] += sign * weight

    # 2. Bigrams for phrases (e.g. "shops and establishment", "epf act")
    for i in range(len(words) - 1):
        bigram = f"{words[i]}_{words[i+1]}"
        h = int(hashlib.sha1(bigram.encode("utf-8")).hexdigest(), 16)
        idx = h % dim
        sign = 1.0 if ((h >> 8) & 1) else -1.0
        vec[idx] += sign * 1.5

    # 3. Character 3-grams for morphological stability
    compact_text = "".join(words)
    for i in range(max(0, len(compact_text) - 2)):
        tri = compact_text[i:i+3]
        h = (ord(tri[0]) * 31 * 31 + ord(tri[1]) * 31 + ord(tri[2]))
        idx = h % dim
        vec[idx] += 0.35

    # L2 normalize
    norm = np.linalg.norm(vec)
    if norm > 1e-6:
        vec = vec / norm
    else:
        vec[0] = 1.0
    return vec


def _gemini_embeddings_batch(texts: List[str]) -> np.ndarray:
    """Generate embeddings using Google Gemini text-embedding-004."""
    try:
        import google.generativeai as genai
        genai.configure(api_key=GEMINI_API_KEY)
        embeddings = []
        for t in texts:
            res = genai.embed_content(
                model="models/text-embedding-004",
                content=t,
                output_dimensionality=FAISS_DIMENSION
            )
            v = np.array(res["embedding"], dtype=np.float32)
            norm = np.linalg.norm(v)
            if norm > 1e-6:
                v = v / norm
            embeddings.append(v)
        return np.vstack(embeddings)
    except Exception as e:
        logger.warning("Gemini embedding failed (%s), falling back to local vectorizer", e)
        return np.vstack([_local_text_to_vector(t) for t in texts])


def _openai_embeddings_batch(texts: List[str]) -> np.ndarray:
    """Generate embeddings using OpenAI text-embedding-3-small."""
    try:
        import openai
        client = openai.OpenAI(api_key=OPENAI_API_KEY)
        resp = client.embeddings.create(
            model="text-embedding-3-small",
            dimensions=FAISS_DIMENSION,
            input=texts
        )
        embeddings = []
        for item in resp.data:
            v = np.array(item.embedding, dtype=np.float32)
            norm = np.linalg.norm(v)
            if norm > 1e-6:
                v = v / norm
            embeddings.append(v)
        return np.vstack(embeddings)
    except Exception as e:
        logger.warning("OpenAI embedding failed (%s), falling back to local vectorizer", e)
        return np.vstack([_local_text_to_vector(t) for t in texts])


def get_embeddings_batch(texts: List[str]) -> np.ndarray:
    """
    Returns (N, FAISS_DIMENSION) float32 numpy array of L2-normalized embeddings.
    """
    if not texts:
        return np.empty((0, FAISS_DIMENSION), dtype=np.float32)

    provider = EMBEDDING_PROVIDER
    if provider == "gemini" and GEMINI_API_KEY:
        return _gemini_embeddings_batch(texts)
    elif provider == "openai" and OPENAI_API_KEY:
        return _openai_embeddings_batch(texts)
    else:
        return np.vstack([_local_text_to_vector(t) for t in texts])


def get_embedding(text: str) -> np.ndarray:
    """
    Returns 1D float32 numpy array of shape (FAISS_DIMENSION,) for a single string.
    """
    batch = get_embeddings_batch([text])
    return batch[0]
