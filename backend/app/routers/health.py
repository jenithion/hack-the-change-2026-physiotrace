from fastapi import APIRouter
from app.services.database import ping

router = APIRouter()

@router.get("/health")
def health():
    # Liveness probe: process is running. Use /ready for dependency readiness.
    return {"status": "ok"}

@router.get("/ready")
async def ready():
    database_ok = await ping()
    return {"status": "ready" if database_ok else "not_ready", "database": "up" if database_ok else "down"}
