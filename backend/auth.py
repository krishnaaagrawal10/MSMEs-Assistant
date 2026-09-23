"""
Authentication helpers: password hashing and JWT tokens.

SECRET_KEY comes from an environment variable in production (set it in
Render's Environment tab as SECRET_KEY). Locally it falls back to a fixed
dev value so you don't need to configure anything just to run it on your
laptop — but never rely on that fallback once this is handling real users.
"""

import os
import datetime
import bcrypt
import jwt

SECRET_KEY = os.environ.get("SECRET_KEY", "dev-only-secret-change-this-in-render")
ALGORITHM = "HS256"
TOKEN_EXPIRE_HOURS = 24 * 7  # tokens stay valid for a week


def hash_password(password: str) -> str:
    return bcrypt.hashpw(password.encode("utf-8"), bcrypt.gensalt()).decode("utf-8")


def verify_password(password: str, hashed: str) -> bool:
    try:
        return bcrypt.checkpw(password.encode("utf-8"), hashed.encode("utf-8"))
    except ValueError:
        return False


def create_token(user_id: int) -> str:
    payload = {
        "sub": str(user_id),
        "exp": datetime.datetime.utcnow() + datetime.timedelta(hours=TOKEN_EXPIRE_HOURS),
    }
    return jwt.encode(payload, SECRET_KEY, algorithm=ALGORITHM)


def decode_token(token: str):
    """Returns the user id encoded in the token, or None if it's invalid/expired."""
    try:
        payload = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
        return int(payload["sub"])
    except (jwt.PyJWTError, KeyError, ValueError):
        return None
