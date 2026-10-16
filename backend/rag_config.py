import os
from pathlib import Path
from dotenv import load_dotenv

# Load .env if present
load_dotenv()

BASE_DIR = Path(__file__).resolve().parent
DATA_DIR = BASE_DIR / "data"
DATA_DIR.mkdir(exist_ok=True)

# FAISS Vector Index configuration
FAISS_INDEX_PATH = os.getenv("FAISS_INDEX_PATH", str(DATA_DIR / "faiss_index.bin"))
FAISS_DIMENSION = 384

# Embedding configuration
# Providers: "local" (default fallback, works offline), "gemini", "openai"
EMBEDDING_PROVIDER = os.getenv("EMBEDDING_PROVIDER", "local").lower()
EMBEDDING_MODEL = os.getenv("EMBEDDING_MODEL", "msmease-compliance-embed-384")

# LLM provider configuration
# Providers: "gemini", "openai", "local" (default: auto-detected from available API keys)
GEMINI_API_KEY = os.getenv("GEMINI_API_KEY", "")
OPENAI_API_KEY = os.getenv("OPENAI_API_KEY", "")

if os.getenv("LLM_PROVIDER"):
    LLM_PROVIDER = os.getenv("LLM_PROVIDER").lower()
elif GEMINI_API_KEY:
    LLM_PROVIDER = "gemini"
elif OPENAI_API_KEY:
    LLM_PROVIDER = "openai"
else:
    LLM_PROVIDER = "local"

# Chunking settings
RAG_CHUNK_SIZE = int(os.getenv("RAG_CHUNK_SIZE", "600"))
RAG_CHUNK_OVERLAP = int(os.getenv("RAG_CHUNK_OVERLAP", "100"))
RAG_TOP_K = int(os.getenv("RAG_TOP_K", "5"))

# Administrative secret key for ingestion / reindex endpoints
ADMIN_API_KEY = os.getenv("ADMIN_API_KEY", "msmease-admin-secret-2026")

# Indian Jurisdictions (Central + 28 States + 8 Union Territories)
ALL_INDIAN_STATES = [
    "Andhra Pradesh", "Arunachal Pradesh", "Assam", "Bihar", "Chhattisgarh",
    "Goa", "Gujarat", "Haryana", "Himachal Pradesh", "Jharkhand",
    "Karnataka", "Kerala", "Madhya Pradesh", "Maharashtra", "Manipur",
    "Meghalaya", "Mizoram", "Nagaland", "Odisha", "Punjab",
    "Rajasthan", "Sikkim", "Tamil Nadu", "Telangana", "Tripura",
    "Uttar Pradesh", "Uttarakhand", "West Bengal"
]

ALL_UNION_TERRITORIES = [
    "Andaman and Nicobar Islands", "Chandigarh",
    "Dadra and Nagar Haveli and Daman and Diu", "Delhi",
    "Jammu and Kashmir", "Ladakh", "Lakshadweep", "Puducherry"
]
