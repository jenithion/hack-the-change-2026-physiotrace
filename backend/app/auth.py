"""Verify Auth0 JWTs and resolve their opaque subject to the app's stable UUID."""
from functools import lru_cache
import json
from typing import Any

import jwt
from fastapi import Header, HTTPException
from jwt import PyJWKClient

from app.config import settings
from app.services.database import connection

@lru_cache(maxsize=1)
def _jwks_client() -> PyJWKClient:
    if not settings.auth0_domain:
        raise RuntimeError("AUTH0_DOMAIN is not configured")
    return PyJWKClient(f"https://{settings.auth0_domain}/.well-known/jwks.json", cache_keys=True)

def verify_access_token(token: str) -> dict[str, Any]:
    if not settings.auth0_domain or not settings.auth0_audience:
        raise HTTPException(503, "Auth0 is not configured. Set AUTH0_DOMAIN and AUTH0_AUDIENCE.")
    issuer = settings.auth0_issuer or f"https://{settings.auth0_domain}/"
    try:
        signing_key = _jwks_client().get_signing_key_from_jwt(token)
        claims = jwt.decode(token, signing_key.key, algorithms=["RS256"], audience=settings.auth0_audience,
                            issuer=issuer, options={"require": ["exp", "iat", "sub"]})
    except Exception as exc:
        raise HTTPException(401, "Invalid or expired access token") from exc
    return claims

async def get_current_user(authorization: str = Header(default="")) -> dict:
    scheme, _, token = authorization.partition(" ")
    if scheme.lower() != "bearer" or not token.strip():
        raise HTTPException(401, "Missing bearer token")
    claims = verify_access_token(token.strip())
    if not settings.database_url:
        raise HTTPException(503, "TigerData is not configured. Set DATABASE_URL.")
    sub = claims["sub"]
    namespaced = "https://physiotrace.app/"
    email = claims.get(f"{namespaced}email") or claims.get("email")
    email_verified = bool(claims.get(f"{namespaced}email_verified", claims.get("email_verified", False)))
    display_name = claims.get(f"{namespaced}name") or claims.get("name") or claims.get("nickname") or "Patient"
    metadata = {"display_name": display_name}
    async with connection() as conn:
        user_id = await conn.fetchval(
            "select public.resolve_auth0_identity($1,$2,$3,$4)",
            sub, email, email_verified, metadata["display_name"],
        )
    return {"id": str(user_id), "auth0_sub": sub, "email": email, "email_verified": email_verified, "user_metadata": metadata,
            "app_metadata": {}, "claims": claims}
