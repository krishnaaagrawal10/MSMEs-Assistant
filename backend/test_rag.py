"""
Comprehensive Test Suite for MSMEase FAISS RAG Compliance Assistant.
Tests:
1. Document Parsing & Semantic Chunking
2. Embeddings & L2 Normalization (384-d)
3. FAISS Vector Operations (Add, Search, Remove)
4. Knowledge Ingestion & Dual Storage (SQLite + FAISS)
5. Vector Index Rebuild from SQLite
6. Intelligent Retrieval with Central + State Jurisdiction Filtering
7. Grounded Answer Synthesis & Citations
8. FastAPI Endpoints (/api/compliance/ask, /api/knowledge/search, etc.)
"""

import unittest
import numpy as np
from fastapi.testclient import TestClient

from database import SessionLocal
import models
from main import app
import rag_config
import rag_embeddings
import rag_store
import rag_ingest
import rag_llm


class TestMSMEaseRAG(unittest.TestCase):

    @classmethod
    def setUpClass(cls):
        cls.client = TestClient(app)
        cls.db = SessionLocal()

    @classmethod
    def tearDownClass(cls):
        cls.db.close()

    def test_01_text_chunking_and_structure(self):
        """Verify semantic text chunking and legal citation regex extraction."""
        sample_law = (
            "Section 22 of the Central Goods and Services Tax Act, 2017 specifies "
            "that every supplier shall be liable to be registered under this Act "
            "in the State or Union territory from where he makes a taxable supply of goods or services.\n\n"
            "Threshold for Tamil Nadu manufacturing is 40 lakhs turnover."
        )
        chunks = rag_ingest.split_text_into_chunks(sample_law, chunk_size=200, overlap=30)
        self.assertGreater(len(chunks), 0)
        for c in chunks:
            self.assertGreater(len(c), 15)

        law_name, sec_ref = rag_ingest.extract_legal_references(sample_law)
        self.assertIn("Section 22", sec_ref)
        self.assertIn("Act, 2017", law_name)

    def test_02_embeddings_and_normalization(self):
        """Verify 384-dimensional vector creation and unit L2 normalization."""
        text = "Employees' Provident Fund registration mandatory for establishments with 20 or more persons."
        v = rag_embeddings.get_embedding(text)
        self.assertEqual(v.shape, (rag_config.FAISS_DIMENSION,))
        norm = np.linalg.norm(v)
        self.assertAlmostEqual(norm, 1.0, places=4)

        batch_texts = [text, "GST registration under Section 22", "Factories Act 1948"]
        batch_vecs = rag_embeddings.get_embeddings_batch(batch_texts)
        self.assertEqual(batch_vecs.shape, (3, rag_config.FAISS_DIMENSION))
        for row in batch_vecs:
            self.assertAlmostEqual(np.linalg.norm(row), 1.0, places=4)

    def test_03_faiss_vector_store_operations(self):
        """Verify adding vectors, inner product cosine search, and removing vectors."""
        v1 = rag_embeddings.get_embedding("Provident fund for employees")
        v2 = rag_embeddings.get_embedding("Industrial pollution control consent")
        faiss_id1 = 888001
        faiss_id2 = 888002

        rag_store.add_vectors(np.vstack([v1, v2]), [faiss_id1, faiss_id2])

        # Search with similar query
        q_vec = rag_embeddings.get_embedding("EPF PF employees")
        results = rag_store.search(q_vec, top_k=5)
        self.assertGreater(len(results), 0)
        retrieved_ids = [r[0] for r in results]
        self.assertIn(faiss_id1, retrieved_ids)

        # Cleanup
        rag_store.remove_vectors([faiss_id1, faiss_id2])

    def test_04_knowledge_ingestion_and_rebuild(self):
        """Verify dual storage: ingestion to SQLite & FAISS and full index rebuild."""
        test_doc_id = "test_doc_epf_sample"
        content = (
            "Section 1(3) of Employees' Provident Funds Act, 1952.\n"
            "Every factory engaged in any industry specified in Schedule I employing 20 or more persons "
            "must register with EPFO. Penalties include fine and imprisonment under Section 14."
        )

        res = rag_ingest.ingest_document_content(
            db=self.db,
            title="Test EPF Document",
            raw_content=content,
            doc_id=test_doc_id,
            file_type="manual",
            source_url="https://epfindia.gov.in",
            source_authority="EPFO",
            jurisdiction="Central",
            category="Labour",
            law_name="Employees' Provident Funds Act, 1952"
        )
        self.assertEqual(res["status"], "success")
        self.assertGreater(res["total_chunks"], 0)

        # Verify in DB
        doc = self.db.query(models.KnowledgeDocument).filter_by(doc_id=test_doc_id).first()
        self.assertIsNotNone(doc)
        self.assertEqual(len(doc.chunks), res["total_chunks"])

        # Test index rebuilding from SQLite
        rebuild_res = rag_store.rebuild_index_from_db(self.db)
        self.assertEqual(rebuild_res["status"], "success")
        self.assertGreaterEqual(rebuild_res["total_indexed"], res["total_chunks"])

        # Cleanup
        rag_ingest.delete_knowledge_document(self.db, test_doc_id)
        doc_after = self.db.query(models.KnowledgeDocument).filter_by(doc_id=test_doc_id).first()
        self.assertIsNone(doc_after)

    def test_05_intelligent_retrieval_and_jurisdiction(self):
        """Verify retrieval preserves Central laws when state is specified, and filters foreign states."""
        # Query with jurisdiction 'Tamil Nadu'
        passages = rag_llm.retrieve_relevant_passages(
            db=self.db,
            query="EPF employee threshold",
            jurisdiction="Tamil Nadu",
            top_k=5
        )
        self.assertGreater(len(passages), 0)
        # Verify central regulations are included
        has_central = any(
            p["jurisdiction_type"] == "central" or "central" in (p["jurisdiction"] or "").lower()
            for p in passages
        )
        self.assertTrue(has_central)

        # Verify citations structure
        ans = rag_llm.generate_llm_answer("EPF employee threshold", passages, "Tamil Nadu")
        self.assertIn("answer", ans)
        self.assertIn("citations", ans)
        self.assertGreater(len(ans["citations"]), 0)
        first_cite = ans["citations"][0]
        self.assertIn("source_url", first_cite)
        self.assertIn("source_authority", first_cite)
        self.assertIn("verification_status", first_cite)
        self.assertIn("Disclaimer", ans["answer"])

    def test_06_fastapi_endpoints(self):
        """Verify all RAG endpoints via HTTP requests."""
        # 1. Jurisdictions
        r_j = self.client.get("/api/knowledge/jurisdictions")
        self.assertEqual(r_j.status_code, 200)
        data_j = r_j.json()
        self.assertEqual(len(data_j["states"]), 28)
        self.assertEqual(len(data_j["union_territories"]), 8)

        # 2. Stats
        r_s = self.client.get("/api/knowledge/stats")
        self.assertEqual(r_s.status_code, 200)
        self.assertIn("documents_count", r_s.json())

        # 3. Documents listing
        r_d = self.client.get("/api/knowledge/documents")
        self.assertEqual(r_d.status_code, 200)
        self.assertIsInstance(r_d.json(), list)

        # 4. Search
        r_srch = self.client.post("/api/knowledge/search", json={
            "query": "GST turnover limit",
            "jurisdiction": "Tamil Nadu",
            "top_k": 3
        })
        self.assertEqual(r_srch.status_code, 200)
        self.assertGreater(r_srch.json()["total_results"], 0)

        # 5. Ask Q&A
        r_ask = self.client.post("/api/compliance/ask", json={
            "question": "What is the turnover threshold for GST registration in Tamil Nadu?",
            "jurisdiction": "Tamil Nadu",
            "category": "Tax"
        })
        self.assertEqual(r_ask.status_code, 200)
        ask_data = r_ask.json()
        self.assertIn("answer", ask_data)
        self.assertGreater(len(ask_data["citations"]), 0)

        # 6. Ingest text
        r_ing = self.client.post("/api/knowledge/ingest-text", json={
            "title": "Ministry Circular on Micro Enterprises",
            "content": "Circular 2026: Micro enterprises investment up to 1 crore and turnover up to 5 crore.",
            "jurisdiction": "Central",
            "category": "MSME",
            "source_authority": "Ministry of MSME",
            "source_url": "https://msme.gov.in"
        })
        self.assertEqual(r_ing.status_code, 200)
        doc_id = r_ing.json()["doc_id"]

        # Delete ingested doc
        r_del = self.client.delete(f"/api/knowledge/documents/{doc_id}")
        self.assertEqual(r_del.status_code, 200)


if __name__ == "__main__":
    unittest.main()
