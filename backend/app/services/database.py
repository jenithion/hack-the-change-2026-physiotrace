"""Async PostgreSQL pool for TigerData (PostgreSQL-compatible).

Use DATABASE_URL with a TigerData connection string. The application should
run migrations with a separate owner role and use a restricted runtime role.
"""
from contextlib import asynccontextmanager
from typing import Any

from fastapi import HTTPException

from app.config import settings

_pool = None


async def open_pool() -> None:
    global _pool
    if not settings.database_url:
        return
    try:
        import asyncpg
    except ImportError as exc:
        raise RuntimeError("Install backend dependencies, including asyncpg, to use TigerData") from exc
    _pool = await asyncpg.create_pool(
        dsn=settings.database_url,
        min_size=settings.db_pool_min,
        max_size=settings.db_pool_max,
        command_timeout=30,
        ssl="require" if settings.database_ssl else None,
    )


async def close_pool() -> None:
    global _pool
    if _pool is not None:
        await _pool.close()
        _pool = None


@asynccontextmanager
async def connection():
    if _pool is None:
        raise HTTPException(503, "TigerData is not configured. Set DATABASE_URL.")
    async with _pool.acquire() as conn:
        async with conn.transaction():
            yield conn


async def ping() -> bool:
    if _pool is None:
        return False
    async with _pool.acquire() as conn:
        return await conn.fetchval("select 1") == 1


async def fetch(query: str, *args: Any) -> list[dict[str, Any]]:
    async with connection() as conn:
        rows = await conn.fetch(query, *args)
        return [dict(row) for row in rows]

@asynccontextmanager
async def user_connection(user_id: str):
    """Open a transaction under the RLS-scoped authenticated database role."""
    async with connection() as conn:
        await conn.execute("set local role authenticated")
        await conn.execute("select set_config('request.jwt.claim.sub', $1, true)", user_id)
        yield conn
