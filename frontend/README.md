# PhysioTrace web app

Next.js App Router, strict TypeScript, React, Auth0 Universal Login authentication, and MediaPipe browser pose estimation. Pages remain thin; the patient and therapist features live in `src/features/physio/`.

## Run

```powershell
npm ci
npm run pose:setup
npm run dev -- --hostname 127.0.0.1
```

The root `.env` is loaded by `next.config.ts`. Do not create an env file in this folder. Browser code reads only `NEXT_PUBLIC_*` variables. The secret key never enters a browser bundle.

Routes:

- `/`: introduction and entry points.
- `/demo`: patient and therapist demo with in-memory sample data and no uploads.
- `/login` and `/signup`: Supabase email/password authentication.
- `/dashboard`: the signed-in patient's plan or the therapist's assigned-patient queue.

## Movement session

Camera permission is requested only after a click. Setup checks cover body visibility, image brightness, and distance. MediaPipe runs at about ten samples per second and draws a skeleton on the camera. Two state machines segment complete squat and shoulder-abduction repetitions. The classifier implements a common interface with a versioned rule baseline.

Correct reps count after persistence. Incorrect reps pause for corrective feedback and local replay. Uncertain reps wait for therapist review and do not count until accepted. The API independently repeats the rule checks on keypoints. Camera frames are never sent for classification.

A bounded local video recording starts at detected movement. Only uncertain clips are uploaded, only with current and session review consent. MediaRecorder support varies by browser; pose replay remains available. Training consent is separate from upload consent and does not start any training.

## Check

```powershell
npm run typecheck
npm test
npm run build
```

Tests use Node's built-in runner, without adding a test framework. Pose assets are generated into ignored `public/mediapipe/`. `npm run dev` and `npm run build` run `pose:setup` first, so the assets exist before serving or deploying. Without them the camera turns on but pose tracking cannot load. The model path is pinned to MediaPipe's full float16 version 1, which tracks floor exercises such as push-ups better than the lite model.


## Auth0 setup (migration in progress)

The Next.js app now uses the Auth0 Next.js SDK v4 middleware. Configure `AUTH0_DOMAIN`, `AUTH0_CLIENT_ID`, `AUTH0_CLIENT_SECRET`, `AUTH0_SECRET`, `APP_BASE_URL`, and `AUTH0_AUDIENCE` in the root `.env`. Auth0 callback is `/auth/callback`; logout returns to the app root. The notes and upload widgets still contain Supabase dependencies pending the Vultr Object Storage and API migration; see the root `MIGRATION_STATUS.md`.
