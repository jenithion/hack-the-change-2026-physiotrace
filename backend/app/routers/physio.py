from datetime import date, datetime, timedelta, timezone
from typing import Annotated, Literal
from uuid import UUID, uuid4

import httpx
from fastapi import APIRouter, Depends, Header, HTTPException, Query, Request, Response
from pydantic import BaseModel, Field, model_validator
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from app.auth import get_current_user
from app.config import settings
from app.physio import MODEL_VERSION, PoseFrame, classify
from app.template import TEMPLATE_VERSION, TemplateModel, classify_template

router = APIRouter(prefix="/physio", tags=["physio"])
# The embedded prescription tells the UI which custom exercise a rep belongs to.
REP_FIELDS = ("id,session_id,prescription_id,patient_id,exercise,exercise_day,label,error_type,confidence,feedback,"
              "model_version,clip_path,created_at,prescription:exercise_prescriptions(custom_exercise_id)")
CUSTOM_FIELDS = ("id,therapist_id,name,description,steps,view,status,status_detail,model,model_version,demo_video_path,"
                 "demo_start_ms,demo_end_ms,created_at")


class Care:
    def __init__(self, user: dict, token: str) -> None:
        self.user = user
        self.token = token

    async def call(self, method: str, path: str, body: object = None, *, service: bool = False, headers: dict | None = None) -> object:
        key = settings.supabase_secret_key if service else settings.supabase_publishable_key
        if not key or not settings.supabase_url:
            raise HTTPException(503, "Configure Supabase before using saved care records.")
        auth_headers = {"apikey": key, "Prefer": "return=representation"}
        if not service:
            auth_headers["Authorization"] = self.token
        try:
            async with httpx.AsyncClient(timeout=20) as client:
                r = await client.request(method, f"{settings.supabase_url}{path}", json=body, headers=auth_headers | (headers or {}))
        except httpx.HTTPError as exc:
            raise HTTPException(503, "Care storage is unavailable. Please retry.") from exc
        if r.is_error:
            data = r.json() if "json" in r.headers.get("content-type", "") else {}
            code = data.get("code", "") if isinstance(data, dict) else ""
            # A column or function the code expects is missing: a migration was not applied.
            if code in ("42703", "42P01", "42883", "PGRST202", "PGRST204", "PGRST205"):
                raise HTTPException(503, "The database is missing a PhysioTrace migration. Apply the files in "
                                         "backend/supabase/migrations (supabase db push), then retry.")
            # P0001 messages are written in our own migrations for people to read.
            if code == "P0001" and data.get("message"):
                raise HTTPException(409, data["message"])
            if code in ("42501", "P0001") or r.status_code in (401, 403):
                raise HTTPException(403, "This action is not allowed for this care relationship.")
            if code == "23505":
                raise HTTPException(409, "This record already exists.")
            raise HTTPException(502, "Care storage could not complete the request.")
        return r.json() if r.content else None

    async def profile(self, role: str | None = None) -> dict:
        rows = await self.call("GET", f"/rest/v1/care_profiles?id=eq.{self.user['id']}&select=*")
        if not rows:
            raise HTTPException(409, "Apply the PhysioTrace migration to create your care profile.")
        profile = rows[0]
        if not profile.get("is_admin") and self.is_env_admin():
            try:
                granted = await self.call("POST", "/rest/v1/rpc/bootstrap_admin", {"p_user": self.user["id"]}, service=True)
                profile = granted[0] if isinstance(granted, list) else granted
            except HTTPException:
                # Granting admin must never lock someone out of their own care plan (for example when
                # the admin migration is not applied yet). They stay a regular account until it works.
                pass
        # Admins can use the patient and therapist features for their own relationships.
        if role and profile["role"] != role and not profile.get("is_admin"):
            raise HTTPException(403, f"This action requires a {role} account.")
        return profile

    def is_env_admin(self) -> bool:
        """True for an ADMIN_EMAILS address whose email Google verified.

        Password sign-ups are not email-confirmed in this project, so anyone could register a listed
        address by password. Only Google sign-in proves the address.
        """
        allowed = {e.strip().lower() for e in settings.admin_emails.split(",") if e.strip()}
        email = (self.user.get("email") or "").lower()
        verified = bool((self.user.get("claims") or {}).get("email_verified"))
        return bool(email) and email in allowed and verified


def get_care(user: dict = Depends(get_current_user), authorization: str = Header(default="")) -> Care:
    return Care(user, authorization)


Context = Annotated[Care, Depends(get_care)]


class Consent(BaseModel):
    review_consent: bool
    training_consent: bool


class SessionInput(Consent):
    prescription_id: UUID
    timezone: str = Field(max_length=80)


class RepInput(BaseModel):
    client_rep_id: UUID
    frames: list[PoseFrame] = Field(min_length=6, max_length=180)


class ReviewInput(BaseModel):
    label: Literal["correct", "incorrect"]
    error_type: Literal["range_of_motion", "tempo", "uneven_movement", "other"] | None = None
    feedback: str = Field(min_length=1, max_length=2000)


class PrescriptionInput(BaseModel):
    patient_id: UUID
    exercise: Literal["squat", "shoulder_abduction", "custom"]
    custom_exercise_id: UUID | None = None
    daily_target: int = Field(ge=1, le=200)
    instructions: str = Field(default="", max_length=2000)
    starts_on: date
    ends_on: date
    confidence_threshold: float = Field(default=0.8, ge=0.6, le=0.99)

    @model_validator(mode="after")
    def custom_needs_exercise(self) -> "PrescriptionInput":
        if (self.exercise == "custom") != (self.custom_exercise_id is not None):
            raise ValueError("Choose a custom exercise for a custom prescription.")
        return self


@router.get("/model")
def model() -> dict:
    return {"version": MODEL_VERSION, "kind": "rules", "exercises": ["squat", "shoulder_abduction"],
            "custom": {"kind": "template", "version": TEMPLATE_VERSION, "trained_by": "offline worker"},
            "training_enabled": False}


@router.get("/overview")
async def overview(ctx: Context, day: date | None = None, view: Literal["patient", "therapist"] | None = None) -> dict:
    profile = await ctx.profile()
    chosen = day or datetime.now(timezone.utc).date()
    uid = ctx.user["id"]
    # Admins pick the view; everyone else gets their role's view.
    as_therapist = view == "therapist" if profile.get("is_admin") and view else profile["role"] == "therapist"
    if as_therapist:
        # Filter to this account as the therapist: an admin may also be someone's patient.
        patients = await ctx.call("GET", f"/rest/v1/care_assignments?therapist_id=eq.{uid}"
                                         "&select=patient_id,care_profiles!care_assignments_patient_id_fkey(*)")
        reps = await ctx.call("GET", f"/rest/v1/exercise_reps?label=eq.inconclusive&patient_id=neq.{uid}"
                                     f"&select={REP_FIELDS}&order=created_at.asc&limit=100")
        customs = await ctx.call("GET", f"/rest/v1/custom_exercises?therapist_id=eq.{uid}"
                                        f"&select={CUSTOM_FIELDS}&order=created_at.desc&limit=100")
        # Current and upcoming plans this therapist wrote, for the Patients & plans section.
        plans = await ctx.call("GET", f"/rest/v1/exercise_prescriptions?therapist_id=eq.{ctx.user['id']}"
                                      f"&ends_on=gte.{chosen}&select=*&order=created_at.desc&limit=200")
        return {"profile": profile, "patients": patients, "queue": reps, "custom_exercises": customs,
                "prescriptions": plans}
    user_id = ctx.user["id"]
    prescriptions = await ctx.call("GET", f"/rest/v1/exercise_prescriptions?patient_id=eq.{user_id}&starts_on=lte.{chosen}&ends_on=gte.{chosen}&select=*")
    reps = await ctx.call("GET", f"/rest/v1/exercise_reps?patient_id=eq.{user_id}&exercise_day=eq.{chosen}&select={REP_FIELDS}&order=created_at.desc&limit=1000")
    feedback = await ctx.call("GET", f"/rest/v1/rep_reviews?patient_id=eq.{user_id}&select=*&order=created_at.desc&limit=30")
    # RLS shows a patient only the custom exercises prescribed to them.
    customs = await ctx.call("GET", f"/rest/v1/custom_exercises?select={CUSTOM_FIELDS}&limit=100")
    return {"profile": profile, "prescriptions": prescriptions, "reps": reps, "feedback": feedback,
            "custom_exercises": customs}


@router.get("/history")
async def history(ctx: Context, offset: int = Query(default=0, ge=0, le=10000)) -> object:
    await ctx.profile("patient")
    return await ctx.call("GET", f"/rest/v1/exercise_reps?patient_id=eq.{ctx.user['id']}&select={REP_FIELDS}&order=created_at.desc&offset={offset}&limit=50")


@router.patch("/consent")
async def consent(data: Consent, ctx: Context) -> object:
    await ctx.profile("patient")
    return await ctx.call("POST", "/rest/v1/rpc/set_care_consent", {"p_review": data.review_consent, "p_training": data.training_consent})


@router.post("/sessions", status_code=201)
async def start_session(data: SessionInput, ctx: Context) -> object:
    profile = await ctx.profile("patient")
    if data.review_consent != profile["review_consent"] or data.training_consent != profile["training_consent"]:
        raise HTTPException(409, "Save your consent choices before starting the session.")
    try:
        ZoneInfo(data.timezone)
    except (ZoneInfoNotFoundError, ValueError):
        raise HTTPException(422, "Choose a valid IANA timezone.")
    return await ctx.call("POST", "/rest/v1/exercise_sessions", {
        "patient_id": ctx.user["id"], "prescription_id": str(data.prescription_id),
        "timezone": data.timezone, "review_consent": data.review_consent, "training_consent": data.training_consent,
    })


@router.post("/sessions/{session_id}/finish")
async def finish_session(session_id: UUID, ctx: Context) -> object:
    await ctx.profile("patient")
    return await ctx.call("POST", "/rest/v1/rpc/finish_care_session", {"p_session": str(session_id)})


@router.post("/sessions/{session_id}/reps", status_code=201)
async def submit_rep(session_id: UUID, data: RepInput, ctx: Context, response: Response) -> object:
    await ctx.profile("patient")
    sessions = await ctx.call("GET", f"/rest/v1/exercise_sessions?id=eq.{session_id}&patient_id=eq.{ctx.user['id']}&select=*,exercise_prescriptions(*)")
    if not sessions:
        raise HTTPException(404, "Session not found.")
    session = sessions[0]
    # Check the idempotency key before rejecting a finished session: retrying a saved rep is safe.
    existing = await ctx.call("GET", f"/rest/v1/exercise_reps?session_id=eq.{session_id}&client_rep_id=eq.{data.client_rep_id}&select=*")
    if existing:
        response.status_code = 200
        return existing[0]
    if session["ended_at"]:
        raise HTTPException(409, "This exercise session has ended.")
    if datetime.now(timezone.utc) - datetime.fromisoformat(session["started_at"].replace("Z", "+00:00")) > timedelta(hours=2):
        raise HTTPException(409, "Start a new session after two hours.")
    plan = session["exercise_prescriptions"]
    if plan["exercise"] == "custom":
        rows = await ctx.call("GET", f"/rest/v1/custom_exercises?id=eq.{plan['custom_exercise_id']}&select=model,status")
        if not rows or rows[0]["status"] != "ready":
            raise HTTPException(409, "This exercise's model is not ready yet.")
        evaluation = classify_template(TemplateModel.model_validate(rows[0]["model"]), data.frames,
                                       plan["confidence_threshold"])
    else:
        evaluation = classify(plan["exercise"], data.frames, plan["confidence_threshold"])
    saved = await ctx.call("POST", "/rest/v1/rpc/record_care_rep", {
        "p_patient": ctx.user["id"], "p_session": str(session_id), "p_client_id": str(data.client_rep_id),
        "p_exercise": plan["exercise"],
        "p_evaluation": evaluation.model_dump(), "p_frames": [f.model_dump() for f in data.frames],
    }, service=True)
    return saved[0] if isinstance(saved, list) else saved


@router.get("/reps/{rep_id}/pose")
async def rep_pose(rep_id: UUID, ctx: Context) -> object:
    await ctx.profile()
    rows = await ctx.call("GET", f"/rest/v1/exercise_reps?id=eq.{rep_id}&select=id,frames")
    if not rows:
        raise HTTPException(404, "Rep not found.")
    return rows[0]


@router.post("/reps/{rep_id}/review")
async def review(rep_id: UUID, data: ReviewInput, ctx: Context) -> object:
    await ctx.profile("therapist")
    if data.label == "incorrect" and not data.error_type:
        raise HTTPException(422, "Choose an error type for an incorrect rep.")
    if not data.feedback.strip():
        raise HTTPException(422, "Write feedback for the patient.")
    saved = await ctx.call("POST", "/rest/v1/rpc/review_care_rep", {
        "p_rep": str(rep_id), "p_label": data.label,
        "p_error": data.error_type if data.label == "incorrect" else None, "p_feedback": data.feedback.strip(),
    })
    return saved[0] if isinstance(saved, list) else saved


@router.post("/prescriptions", status_code=201)
async def prescribe(data: PrescriptionInput, ctx: Context) -> object:
    await ctx.profile("therapist")
    if data.ends_on < data.starts_on or (data.ends_on - data.starts_on).days > 366:
        raise HTTPException(422, "Choose a date range of up to one year.")
    body = data.model_dump(mode="json") | {"therapist_id": ctx.user["id"]}
    return await ctx.call("POST", "/rest/v1/exercise_prescriptions", body)


@router.put("/reps/{rep_id}/clip", status_code=201)
async def upload_clip(rep_id: UUID, request: Request, ctx: Context) -> dict:
    profile = await ctx.profile("patient")
    if not profile["review_consent"]:
        raise HTTPException(403, "Review-upload consent is required.")
    rows = await ctx.call("GET", f"/rest/v1/exercise_reps?id=eq.{rep_id}&patient_id=eq.{ctx.user['id']}&select=*,exercise_sessions(review_consent)")
    if not rows or rows[0]["label"] != "inconclusive" or not rows[0]["exercise_sessions"]["review_consent"]:
        raise HTTPException(403, "Only a consented, uncertain rep may have a review clip.")
    mime = request.headers.get("content-type", "").split(";")[0]
    if mime not in ("video/webm", "video/mp4"):
        raise HTTPException(415, "Upload a WebM or MP4 clip.")
    clip = bytearray()
    async for chunk in request.stream():
        clip.extend(chunk)
        if len(clip) > 10 * 1024 * 1024:
            raise HTTPException(413, "Review clips must be at most 10 MiB.")
    if not clip:
        raise HTTPException(422, "The clip is empty.")
    # No arbitrary storage paths or reusable upload tokens are accepted from the browser.
    ext = "webm" if mime == "video/webm" else "mp4"
    path = f"{ctx.user['id']}/{rep_id}/{uuid4()}.{ext}"
    headers = {"apikey": settings.supabase_secret_key, "Content-Type": mime}
    async with httpx.AsyncClient(timeout=30) as client:
        r = await client.post(f"{settings.supabase_url}/storage/v1/object/review-clips/{path}", headers=headers, content=bytes(clip))
    if r.is_error:
        raise HTTPException(502, "The clip could not be uploaded. The pose rep is still saved.")
    try:
        # Recheck consent in the database after the upload to handle concurrent revocation.
        await ctx.call("POST", "/rest/v1/rpc/attach_care_clip", {"p_rep": str(rep_id), "p_path": path})
    except HTTPException:
        async with httpx.AsyncClient(timeout=20) as client:
            await client.delete(f"{settings.supabase_url}/storage/v1/object/review-clips/{path}", headers=headers)
        raise
    return {"uploaded": True}


@router.get("/reps/{rep_id}/clip")
async def clip_url(rep_id: UUID, ctx: Context) -> dict:
    await ctx.profile()
    rows = await ctx.call("GET", f"/rest/v1/exercise_reps?id=eq.{rep_id}&select=clip_path,patient_id,care_profiles!exercise_reps_patient_id_fkey(review_consent)")
    if not rows or not rows[0]["clip_path"] or not rows[0]["care_profiles"]["review_consent"]:
        raise HTTPException(404, "No consented clip is available. Use the pose replay.")
    path = rows[0]["clip_path"]
    signed = await ctx.call("POST", f"/storage/v1/object/sign/review-clips/{path}", {"expiresIn": 60}, service=True)
    return {"url": f"{settings.supabase_url}/storage/v1{signed['signedURL']}"}
