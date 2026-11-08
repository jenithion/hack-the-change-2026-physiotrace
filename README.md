> **Infrastructure migration in progress:** this working copy contains the first Auth0/TigerData/Vultr migration foundation. It is **not yet a complete Supabase removal**. See [MIGRATION_STATUS.md](MIGRATION_STATUS.md) for implemented work, remaining Supabase dependencies, and the safe cutover order. Do not disconnect the original Supabase project yet.

# PhysioTrace

Private exercise feedback for physiotherapy patients, with a review loop for their physical therapist.

The implemented MVP includes bodyweight squat and standing shoulder abduction, browser pose tracking and skeleton overlay, complete-rep segmentation, a versioned rule classifier, daily targets and history, therapist prescriptions, a review queue, and patient feedback. An uncertain rep counts only after an assigned therapist accepts it.

No training has been run. The optional offline ML group uses CUDA PyTorch on Windows and Linux and MLX on Apple Silicon. The app uses a rule baseline, not a trained exercise classifier.

## Run the implementation on this Windows workspace

The local tools are already downloaded under the ignored `.tools/` folder, and dependencies are installed.

Open two PowerShell terminals at the repository root:

```powershell
.\scripts\backend.ps1
```

```powershell
.\scripts\frontend.ps1
```

Open [the interactive demo](http://127.0.0.1:3000/demo). It needs no account and never uploads anything. Demo reps, feedback, and clips are saved in this browser across refreshes until you press Clear demo data. Use the Patient and Therapist switches to exercise the entire feedback loop. Simulated good, incorrect, and uncertain reps work without camera access.

The backend script creates the single root `.env` from `.env.example` if it is missing. Fill in the Supabase values to use saved care records. The landing page and demo work with blank values. Camera use requires HTTPS or localhost and explicit browser permission. Opening the dev server from a phone at the LAN address over plain HTTP will not expose the camera. The in-app browser of some editors blocks the camera, so test live sessions in Chrome, Edge, Safari, or Firefox.

## Run on macOS or Linux

```bash
cp -n .env.example .env
cd backend && uv sync && uv run uvicorn app.main:app --host 127.0.0.1 --port 8000
```

```bash
cd frontend && npm ci && npm run dev
```

## Set up a fresh checkout

Install Node.js 24 LTS and uv. Keep exactly one `.env` at the repository root.

```powershell
Copy-Item .env.example .env
cd backend
uv python install 3.12.16
uv sync
cd ..\frontend
npm ci
npm run pose:setup
```

The pose setup copies the installed MediaPipe WASM runtime and downloads the pinned pretrained pose detector from Google. It does not download training data or train a model. Run it again after changing the MediaPipe package version.

For the offline ML accelerator (CUDA or MLX):

```bash
cd backend
uv sync --group ml
uv run --group ml python check_accelerator.py
```

`backend/.python-version` pins uv-managed Python 3.12.16. `backend/uv.lock` locks the dependencies. The optional `ml` group installs NumPy plus one accelerator stack per platform:

| Platform | Stack | Device |
| --- | --- | --- |
| Windows, Linux | PyTorch from the explicit CUDA 12.8 index | `cuda` |
| macOS on Apple Silicon | MLX | Apple GPU through Metal |

`check_accelerator.py` picks CUDA first, then MLX, and exits non-zero when neither is usable. There is no CPU fallback. The API and production image do not need the `ml` group. A CUDA check needs an accessible NVIDIA GPU and driver; installing the wheel does not install or change a driver. Intel Macs have no supported accelerator.

## Therapist-defined exercises

Therapists can add their own exercises from the workspace with an uploaded or recorded demo video, then trim it to the part with two or more reps (2 to 60 s, starting and ending at rest). Only that part is used for the model, and patients see it looped. Pose keypoints are extracted in the browser, and a background trainer fits a model:

```bash
scripts/worker.sh
```

On Windows run `scripts\worker.ps1`. It reads the root `.env`, claims queued exercises every 5 seconds, and marks each one Ready or Failed with a reason shown to the therapist. Ready exercises can be prescribed like the built-in ones. The demo needs no worker: it fits the model in the browser right away.

## Ask PhysioTrace assistant

Signed-in patients and therapists can open "Ask PhysioTrace" in the sidebar for general questions about technique, camera setup, and the app. Therapists get their own version, with suggestions and a system prompt about the review queue, prescriptions, custom exercises, and coaching cues; it is reminded that clinical judgement is the therapist's and to keep identifying details out. It uses the OpenAI-compatible LLM settings in `.env` (`LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL`; Gemini by default) and allows 20 questions per person per day. Only the typed conversation is sent to the provider, never plans, reps, feedback, or video, and answers always defer to the therapist.

## Connect Supabase

1. Set `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, and the backend-only `SUPABASE_SECRET_KEY` in the root `.env`. Keep the existing key names.
2. Apply the migrations from `backend/supabase/migrations/` to your intended local or linked project using the Supabase CLI. No remote migration is applied automatically by this implementation.
3. Sign up patient and therapist accounts, by email or with Google. Every account starts as a patient. Never grant roles from signup metadata.
4. Make yourself an admin (see below), then open `/dashboard`: the Admin tab sets therapist roles and assigns patients to therapists. Without an admin, `backend/supabase/admin-care.sql` still grants a therapist role and an assignment with database access.
5. The therapist signs in at `/dashboard` and prescribes an exercise, date range, daily target, confidence threshold, and movement cue. The patient sees that plan after refreshing.

### Google sign-in

1. In Google Cloud, create an OAuth client (type Web application) with the authorized redirect URI `https://<your-project>.supabase.co/auth/v1/callback`.
2. In the Supabase dashboard, open Authentication > Providers > Google, turn it on, and paste the client ID and secret.
3. In Authentication > URL Configuration, add `http://localhost:3000/auth/callback` (and your deployed `/auth/callback` URL) to the redirect URLs.

The "Continue with Google" button then signs people in through Supabase and returns to `/auth/callback`. Google accounts start as patients and take their name from Google. For a local `supabase start`, enable the `[auth.external.google]` block in `backend/supabase/config.toml` instead.

### Admins

Admins manage accounts from the Admin tab: set patient or therapist, promote or demote admins (at least one is always kept), and assign or unassign patients. They can also open the Therapist and Patient views for their own relationships. Admins get no access to other patients' reps, clips, or feedback.

To create the first admin, put your email in `ADMIN_EMAILS` in the root `.env` (comma separated) and sign in with Google; the API grants admin on that sign-in. Only Google-verified emails qualify, because email confirmation is off and anyone could otherwise register your address by password. For a password-only admin, run `backend/supabase/admin-grant.sql` with database access.

Use the Supabase CLI from `backend/`. Retain the starter's private storage, RLS, and email/password setup. Native Supabase auth, private storage URLs, and a live camera must still be verified against your configured project.

## Privacy and safety

Pose processing runs in the browser. The API verifies deterministic pose checks before recording results. Raw video is held only in a bounded local memory buffer, and uncertain clips upload only with separate review consent. Training consent is independent and off by default. A therapist can access only assigned patients.

Revoking review consent hides shared clips; existing signed URLs expire within 60 seconds. Revoking training consent removes dataset membership and opts prior reps out of future exports. Offline dataset version functions exist, but labels never trigger exports or training.

The baseline uses prototype joint-angle ranges and tracking visibility as its confidence score. It needs therapist validation before clinical use. Stop if you feel pain. PhysioTrace supports physical therapy care and does not replace a clinician.

## Verify

```powershell
cd frontend
npm run typecheck
npm test
npm run build
cd ..\backend
uv run pytest
```

`uv run pytest` syncs only the default groups. Use `uv run --group ml pytest` to preserve an installed CUDA or MLX environment. The seven backend tests cover routing, authentication, role checks, replay-safe submission, review validation, and secret-header handling. Three Node tests cover both exercise state machines and confidence routing.

For the disposable PostgreSQL checks, install a local verification runtime without changing app dependencies:

```powershell
npm install --prefix .tools/verification --no-audit --no-fund @electric-sql/pglite
node scripts/check-care-db.mjs .tools/verification/node_modules/@electric-sql/pglite/dist/index.js
```

These checks execute the migration and test RLS, role protection, retry idempotency, review correction, and consent revocation. They never connect to Supabase or train a model.

Deploying to your own server and domain (AWS or Vultr) is covered step by step in `docs/deployment.md`.

See `docs/architecture.md` for the approved proposal, `docs/decisions.md` for implementation choices, and `docs/verification.md` for the checks and remaining environment limits.
