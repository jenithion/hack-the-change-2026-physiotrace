import asyncio
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient

from app.config import settings
from app.main import app
from app.routers.physio import Care, get_care


def care(profile: dict, user: dict | None = None, calls: list | None = None) -> Care:
    ctx = Care({"id": str(uuid4()), **(user or {})}, "Bearer test")

    async def call(method: str, path: str, body: object = None, *, service: bool = False, **kwargs: object) -> object:
        if calls is not None:
            calls.append((method, path, body, service))
        if "care_profiles?" in path:
            return [dict(profile)]
        if path.endswith("/rpc/bootstrap_admin"):
            return {**profile, "is_admin": True}
        return []
    ctx.call = call
    return ctx


@pytest.fixture
def client():
    yield TestClient(app)
    app.dependency_overrides.clear()


def test_admin_routes_reject_everyone_else(client: TestClient) -> None:
    for role in ("patient", "therapist"):
        app.dependency_overrides[get_care] = lambda role=role: care({"role": role, "is_admin": False})
        assert client.get("/admin/accounts").status_code == 403
        assert client.post(f"/admin/accounts/{uuid4()}/role", json={"role": "therapist"}).status_code == 403
        assert client.post("/admin/assignments", json={"therapist_id": str(uuid4()), "patient_id": str(uuid4())}).status_code == 403


def test_admin_routes_validate_and_call_admin_functions(client: TestClient) -> None:
    calls: list = []
    app.dependency_overrides[get_care] = lambda: care({"role": "patient", "is_admin": True}, calls=calls)
    target = str(uuid4())
    assert client.post(f"/admin/accounts/{target}/role", json={"role": "admin"}).status_code == 422
    assert client.post("/admin/assignments", json={"therapist_id": target, "patient_id": target}).status_code == 422
    assert client.get("/admin/accounts").status_code == 200
    assert client.post(f"/admin/accounts/{target}/role", json={"role": "therapist"}).status_code == 200
    assert client.post(f"/admin/accounts/{target}/admin", json={"is_admin": True}).status_code == 200
    assert client.delete(f"/admin/assignments/{target}/{uuid4()}").status_code == 200
    rpcs = [path.rsplit("/", 1)[-1] for _, path, _, service in calls if "/rpc/" in path]
    assert rpcs == ["admin_list_accounts", "admin_list_assignments", "admin_set_role", "admin_set_admin", "admin_unassign"]
    assert not any(service for _, path, _, service in calls if "/rpc/admin_" in path)  # the admin's own token


def test_env_admin_needs_an_auth0_verified_email(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(settings, "admin_emails", "Owner@Example.com, other@example.com")
    verified = {"email": "owner@example.com", "claims": {"email_verified": True}}
    unverified = {"email": "owner@example.com", "claims": {"email_verified": False}}
    stranger = {"email": "someone@example.com", "claims": {"email_verified": True}}
    for user, expected in ((verified, True), (unverified, False), (stranger, False)):
        calls: list = []
        profile = asyncio.run(care({"role": "patient", "is_admin": False}, user, calls).profile())
        assert profile["is_admin"] is expected
        bootstrapped = [c for c in calls if c[1].endswith("/rpc/bootstrap_admin")]
        assert len(bootstrapped) == (1 if expected else 0)
        assert all(service for *_, service in bootstrapped)


def test_only_admins_choose_the_overview_view(client: TestClient) -> None:
    calls: list = []
    app.dependency_overrides[get_care] = lambda: care({"role": "patient", "is_admin": False}, calls=calls)
    client.get("/physio/overview?view=therapist")
    assert not any("care_assignments" in path for _, path, *_ in calls)
    calls.clear()
    app.dependency_overrides[get_care] = lambda: care({"role": "patient", "is_admin": True}, calls=calls)
    client.get("/physio/overview?view=therapist")
    assert any("care_assignments?therapist_id=eq." in path for _, path, *_ in calls)


def test_our_database_messages_reach_the_user(monkeypatch: pytest.MonkeyPatch) -> None:
    import httpx
    from fastapi import HTTPException

    async def request(self: httpx.AsyncClient, method: str, url: str, **kwargs: object) -> httpx.Response:
        return httpx.Response(400, json={"code": "P0001", "message": "Keep at least one admin"})
    monkeypatch.setattr(httpx.AsyncClient, "request", request)
    with pytest.raises(HTTPException) as error:
        asyncio.run(Care({"id": "x"}, "Bearer t").call("POST", "/rest/v1/rpc/admin_set_admin", {}))
    assert error.value.status_code == 409 and error.value.detail == "Keep at least one admin"


def test_a_missing_admin_migration_does_not_block_sign_in(monkeypatch: pytest.MonkeyPatch) -> None:
    from fastapi import HTTPException

    monkeypatch.setattr(settings, "admin_emails", "owner@example.com")
    ctx = Care({"id": "u1", "email": "owner@example.com", "app_metadata": {"providers": ["google"]}}, "Bearer t")

    async def call(method: str, path: str, body: object = None, **kwargs: object) -> object:
        if "care_profiles?" in path:
            return [{"role": "patient"}]  # no is_admin column yet
        raise HTTPException(503, "The database is missing a PhysioTrace migration.")
    ctx.call = call
    assert asyncio.run(ctx.profile())["role"] == "patient"


def test_missing_columns_or_functions_name_the_migration(monkeypatch: pytest.MonkeyPatch) -> None:
    import httpx
    from fastapi import HTTPException

    for code in ("42703", "PGRST202"):
        async def request(self: httpx.AsyncClient, method: str, url: str, code=code, **kwargs: object) -> httpx.Response:
            return httpx.Response(400, json={"code": code, "message": "missing"})
        monkeypatch.setattr(httpx.AsyncClient, "request", request)
        with pytest.raises(HTTPException) as error:
            asyncio.run(Care({"id": "x"}, "Bearer t").call("GET", "/rest/v1/care_profiles?select=is_admin"))
        assert error.value.status_code == 503 and "migration" in error.value.detail
