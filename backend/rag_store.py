"""
FAISS Vector Store Manager for MSMEase Compliance Assistant.
Maintains persistent index of L2-normalized legal compliance chunk embeddings.
Uses IndexIDMap2 wrapping IndexFlatIP for exact cosine similarity matching by ID.
Supports index rebuilding from SQLite database.
"""

import os
import logging
from pathlib import Path
from typing import List, Tuple, Dict, Any, Optional
import numpy as np
import faiss

from rag_config import FAISS_INDEX_PATH, FAISS_DIMENSION
from rag_embeddings import get_embeddings_batch

logger = logging.getLogger("rag_store")

_index_instance: Optional[faiss.IndexIDMap2] = None


def get_faiss_index() -> faiss.IndexIDMap2:
    """Singleton getter for the persistent FAISS index."""
    global _index_instance
    if _index_instance is None:
        _index_instance = load_or_create_index()
    return _index_instance


def create_empty_index() -> faiss.IndexIDMap2:
    """Creates a new empty IndexIDMap2 wrapping IndexFlatIP."""
    flat_index = faiss.IndexFlatIP(FAISS_DIMENSION)
    index = faiss.IndexIDMap2(flat_index)
    return index


def load_or_create_index() -> faiss.IndexIDMap2:
    """Loads index from disk or creates a new empty one if not present."""
    index_file = Path(FAISS_INDEX_PATH)
    if index_file.exists():
        try:
            logger.info("Loading FAISS index from %s", index_file)
            index = faiss.read_index(str(index_file))
            logger.info("FAISS index loaded successfully with %d vectors", index.ntotal)
            return index
        except Exception as e:
            logger.error("Failed to load existing FAISS index (%s). Creating new one.", e)

    index = create_empty_index()
    save_index(index)
    return index


def save_index(index: Optional[faiss.IndexIDMap2] = None) -> bool:
    """Saves the current FAISS index to disk."""
    if index is None:
        index = get_faiss_index()
    try:
        index_file = Path(FAISS_INDEX_PATH)
        index_file.parent.mkdir(parents=True, exist_ok=True)
        faiss.write_index(index, str(index_file))
        logger.info("Saved FAISS index with %d vectors to %s", index.ntotal, index_file)
        return True
    except Exception as e:
        logger.error("Failed to save FAISS index: %s", e)
        return False


def add_vectors(vectors: np.ndarray, faiss_ids: List[int]) -> bool:
    """
    Adds batch of L2-normalized vectors with explicit integer IDs to the index.
    """
    if len(vectors) == 0 or len(faiss_ids) == 0:
        return True

    index = get_faiss_index()
    vec_array = np.ascontiguousarray(vectors, dtype=np.float32)
    id_array = np.ascontiguousarray(np.array(faiss_ids, dtype=np.int64))

    # Remove any existing entries with these IDs first to avoid duplicates
    try:
        selector = faiss.IDSelectorArray(len(id_array), faiss.swig_ptr(id_array))
        index.remove_ids(selector)
    except Exception:
        pass

    index.add_with_ids(vec_array, id_array)
    save_index(index)
    return True


def remove_vectors(faiss_ids: List[int]) -> bool:
    """Removes vectors matching the given integer IDs from the index."""
    if not faiss_ids:
        return True
    index = get_faiss_index()
    try:
        id_array = np.ascontiguousarray(np.array(faiss_ids, dtype=np.int64))
        selector = faiss.IDSelectorArray(len(id_array), faiss.swig_ptr(id_array))
        removed = index.remove_ids(selector)
        save_index(index)
        logger.info("Removed %d vectors from FAISS index", removed)
        return True
    except Exception as e:
        logger.error("Error removing vectors from FAISS: %s", e)
        return False


def search(query_vector: np.ndarray, top_k: int = 10) -> List[Tuple[int, float]]:
    """
    Performs cosine similarity search against index.
    Returns list of (faiss_id, similarity_score) sorted descending by score.
    """
    index = get_faiss_index()
    if index.ntotal == 0:
        return []

    q_vec = np.ascontiguousarray(query_vector.reshape(1, -1), dtype=np.float32)
    # Search for top_k or ntotal, whichever is smaller
    k = min(top_k, index.ntotal)
    scores, indices = index.search(q_vec, k)

    results: List[Tuple[int, float]] = []
    for score, idx in zip(scores[0], indices[0]):
        if idx != -1:
            results.append((int(idx), float(score)))

    return results


def rebuild_index_from_db(db_session) -> Dict[str, Any]:
    """
    Rebuilds the entire FAISS index from the persisted SQLite KnowledgeChunk records.
    Guarantees recovery even if the FAISS binary file is corrupted or deleted.
    """
    global _index_instance
    from models import KnowledgeChunk

    chunks = db_session.query(KnowledgeChunk).all()
    new_index = create_empty_index()

    if not chunks:
        _index_instance = new_index
        save_index(new_index)
        return {"status": "success", "total_indexed": 0, "message": "Index rebuilt (0 chunks found)"}

    texts = [f"{c.title}\n{c.law_name or ''}\n{c.section_reference or ''}\n{c.text}" for c in chunks]
    faiss_ids = [c.faiss_id for c in chunks]

    batch_vectors = get_embeddings_batch(texts)
    vec_array = np.ascontiguousarray(batch_vectors, dtype=np.float32)
    id_array = np.ascontiguousarray(np.array(faiss_ids, dtype=np.int64))

    new_index.add_with_ids(vec_array, id_array)
    _index_instance = new_index
    save_index(new_index)

    logger.info("Successfully rebuilt FAISS index with %d chunks from database", len(chunks))
    return {
        "status": "success",
        "total_indexed": len(chunks),
        "message": f"Successfully rebuilt FAISS vector index with {len(chunks)} compliance chunks"
    }


def get_index_stats() -> Dict[str, Any]:
    """Returns statistics about the vector store."""
    index = get_faiss_index()
    index_file = Path(FAISS_INDEX_PATH)
    file_size_bytes = index_file.stat().st_size if index_file.exists() else 0
    return {
        "ntotal": index.ntotal,
        "dimension": FAISS_DIMENSION,
        "index_file": str(index_file),
        "file_size_bytes": file_size_bytes,
        "exists": index_file.exists()
    }
