"""
Stage 2 / Stage 6 support: database connection setup.

Uses SQLite for the Review-1 prototype (roadmap allows "PostgreSQL or another
relational DB for prototype" — SQLite needs zero setup, which keeps the
20% milestone easy to run and demo).
"""

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker, declarative_base

DATABASE_URL = "sqlite:///./msmease.db"

engine = create_engine(
    DATABASE_URL, connect_args={"check_same_thread": False}
)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
Base = declarative_base()


def get_db():
    """FastAPI dependency: yields a DB session per request, always closes it."""
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
