"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { apiFetch } from "@/lib/api";
import {
  EXERCISES,
  MODEL_VERSION,
  RepSegmenter,
  demoFrame,
  trimLeadIn,
  type Evaluation,
  type PoseFrame,
} from "./engine";
import {
  CustomExerciseForm,
  trainingStatusLabel,
  type ExerciseSubmission,
} from "./custom-exercise-form";
import { Assistant } from "@/features/ai/assistant";
import { AdminConsole, type Account, type Assignment } from "./admin-console";
import { ExerciseSteps } from "./exercise-steps";
import { TrimmedVideo } from "./trimmed-video";
import { LiveSession } from "./live-session";
import {
  customIdOf,
  exerciseInfo,
  movementFor,
  type CustomExercise,
} from "./movement";
import {
  deleteLocalClips,
  getLocalClip,
  localClipIds,
  saveLocalClip,
} from "./local-clips";
import { PoseReplay } from "./pose-replay";
import type { Overview, Prescription, Profile, Rep, Review } from "./types";

const localDay = () => {
  const d = new Date();
  return [
    d.getFullYear(),
    String(d.getMonth() + 1).padStart(2, "0"),
    String(d.getDate()).padStart(2, "0"),
  ].join("-");
};
const demoPatient: Profile = {
  id: "demo-patient",
  display_name: "Alex Morgan",
  role: "patient",
  review_consent: false,
  training_consent: false,
};
const demoTherapist: Profile = {
  ...demoPatient,
  id: "demo-therapist",
  display_name: "Taylor Chen",
  role: "therapist",
};
const demoPlans: Prescription[] = [
  {
    id: "demo-squat",
    patient_id: demoPatient.id,
    exercise: "squat",
    daily_target: 10,
    instructions: "",
    confidence_threshold: 0.8,
    starts_on: "2020-01-01",
    ends_on: "2099-12-31",
  },
  {
    id: "demo-shoulder",
    patient_id: demoPatient.id,
    exercise: "shoulder_abduction",
    daily_target: 12,
    instructions: "",
    confidence_threshold: 0.8,
    starts_on: "2020-01-01",
    ends_on: "2099-12-31",
  },
];
// Demo data is a per-browser convenience: it survives refreshes until the
// viewer clears it. Clips live in the on-device clip store, keyed by rep id.
// ponytail: localStorage caps at a few MB; a long demo may stop saving new reps.
const DEMO_KEY = "physiotrace-demo-v1";
// Demo admin console: sample accounts kept in the saved demo state.
const demoAccounts: Account[] = [
  { id: "demo-admin", email: "you@example.com", display_name: "Demo Admin", role: "therapist", is_admin: true, provider: "google", created_at: "2026-11-01T09:00:00Z" },
  { id: "demo-therapist", email: "taylor@example.com", display_name: "Taylor Chen", role: "therapist", is_admin: false, provider: "email", created_at: "2026-11-02T09:00:00Z" },
  { id: "demo-patient", email: "alex@example.com", display_name: "Alex Morgan", role: "patient", is_admin: false, provider: "email", created_at: "2026-11-03T09:00:00Z" },
  { id: "demo-sam", email: "sam@example.com", display_name: "Sam Rivera", role: "patient", is_admin: false, provider: "google", created_at: "2026-11-04T09:00:00Z" },
  { id: "demo-jordan", email: "jordan@example.com", display_name: "Jordan Lee", role: "patient", is_admin: false, provider: "email", created_at: "2026-11-05T09:00:00Z" },
];
const demoAssignments: Assignment[] = [
  { therapist_id: "demo-therapist", patient_id: "demo-patient" },
];
type DemoState = {
  accounts?: Account[];
  assignments?: Assignment[];
  customs?: CustomExercise[];
  // Demo prescriptions of custom exercises, shown in the patient's plan.
  extraPlans?: Prescription[];
  reps: Rep[];
  reviews: Review[];
  consent: { review_consent: boolean; training_consent: boolean };
};
// Demo videos live in the on-device clip store under this prefix.
const demoVideoKey = (id: string) => "demo-video:" + id;
const sampleFrames = [175, 165, 130, 95, 120, 165, 175].map((a, i) =>
  demoFrame("squat", a, i * 300, 0.5),
);

export function PhysioApp({ demo = false }: { demo?: boolean }) {
  const token = useRef("");
  const [role, setRole] = useState<Profile["role"]>("patient");
  const [overview, setOverview] = useState<Overview | null>(
    demo ? { profile: demoPatient, prescriptions: demoPlans } : null,
  );
  const [reps, setReps] = useState<Rep[]>([]),
    [reviews, setReviews] = useState<Review[]>([]);
  const [historyVideos, setHistoryVideos] = useState<Set<string>>(new Set());
  const [history, setHistory] = useState<Rep[]>([]),
    [moreHistory, setMoreHistory] = useState(false);
  const [page, setPage] = useState("today"),
    [loading, setLoading] = useState(!demo),
    [busy, setBusy] = useState(false);
  const [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const [session, setSession] = useState<{
    id: string;
    plan: Prescription;
  } | null>(null);
  const [selected, setSelected] = useState<Rep | null>(null),
    [pose, setPose] = useState<PoseFrame[]>([]),
    [clip, setClip] = useState<string>();
  const [label, setLabel] = useState<"correct" | "incorrect">("correct"),
    [errorType, setErrorType] = useState("range_of_motion"),
    [feedback, setFeedback] = useState("");
  const [consent, setConsent] = useState({
    review_consent: false,
    training_consent: false,
  });
  const [consentOpen, setConsentOpen] = useState(false);
  const [consentDraft, setConsentDraft] = useState(consent);
  // Saving waits for the restore to render, so an empty first state never overwrites saved data.
  const [demoReady, setDemoReady] = useState(false);
  const profile = overview?.profile;
  const queue = demo
    ? reps.filter((r) => r.label === "inconclusive")
    : (overview?.queue ?? []);
  const [customs, setCustoms] = useState<CustomExercise[]>([]);
  // Admin console. viewRole is the experience an admin chose (null: their own role).
  const [adminPage, setAdminPage] = useState(false);
  const viewRole = useRef<Profile["role"] | null>(null);
  const adminOpened = useRef(false);
  const [accounts, setAccounts] = useState<Account[]>(demo ? demoAccounts : []);
  const [assignments, setAssignments] = useState<Assignment[]>(
    demo ? demoAssignments : [],
  );
  const [extraPlans, setExtraPlans] = useState<Prescription[]>([]);
  const therapistPatients = demo
    ? [{ patient_id: demoPatient.id, care_profiles: demoPatient }]
    : (overview?.patients ?? []);
  const therapistPlans = demo
    ? [...demoPlans, ...extraPlans]
    : role === "therapist"
      ? (overview?.prescriptions ?? [])
      : [];
  const plans = [
    ...(overview?.prescriptions ?? []),
    ...(demo && role === "patient" ? extraPlans : []),
  ];
  // Playable demo video URLs by custom exercise id (signed, or local in the demo).
  const [demoVideoUrls, setDemoVideoUrls] = useState<Record<string, string>>({});
  const info = (item: Parameters<typeof exerciseInfo>[0]) =>
    exerciseInfo(item, customs);
  const todayReps = reps.filter((r) => r.exercise_day === localDay());
  const accepted = todayReps.filter((r) => r.label === "correct").length;
  const pending = todayReps.filter((r) => r.label === "inconclusive").length;
  const target = plans.reduce((sum, p) => sum + p.daily_target, 0);

  const request = useCallback(
    async (path: string, method = "GET", body?: object) =>
      apiFetch("/physio" + path, token.current, {
        method,
        ...(body
          ? {
              body: JSON.stringify(body),
              headers: { "Content-Type": "application/json" },
            }
          : {}),
      }),
    [],
  );

  const load = useCallback(async () => {
    if (demo) return;
    setLoading(true);
    setError("");
    try {
      const view = viewRole.current;
      const data: Overview = await request(
        "/overview?day=" + localDay() + (view ? "&view=" + view : ""),
      );
      setOverview(data);
      setRole(view ?? data.profile.role);
      // Admins land on the console the first time the page opens.
      if (data.profile.is_admin && !adminOpened.current) {
        adminOpened.current = true;
        setAdminPage(true);
        void loadAccounts();
      }
      setReps(data.reps ?? []);
      setReviews(data.feedback ?? []);
      setCustoms(data.custom_exercises ?? []);
      setConsent({
        review_consent: data.profile.review_consent,
        training_consent: data.profile.training_consent,
      });
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Your care plan could not be loaded.",
      );
    } finally {
      setLoading(false);
    }
  }, [demo, request]);

  const adminRequest = useCallback(
    async (path: string, method = "GET", body?: object) =>
      apiFetch("/admin" + path, token.current, {
        method,
        ...(body
          ? {
              body: JSON.stringify(body),
              headers: { "Content-Type": "application/json" },
            }
          : {}),
      }),
    [],
  );
  async function loadAccounts() {
    if (demo) return;
    try {
      const data: { accounts: Account[]; assignments: Assignment[] } =
        await adminRequest("/accounts");
      setAccounts(data.accounts);
      setAssignments(data.assignments);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Accounts could not be loaded.");
    }
  }

  useEffect(() => {
    if (demo) return;
    let active = true;
    void fetch("/api/auth/token", { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) throw new Error("Not authenticated");
        return response.json() as Promise<{ accessToken: string }>;
      })
      .then(({ accessToken }) => {
        if (!active) return;
        token.current = accessToken;
        void load();
      })
      .catch(() => {
        if (!active) return;
        window.location.assign("/auth/login");
      });
    return () => { active = false; };
  }, [demo, load]);

  useEffect(() => {
    if (!demo) return;
    let saved: DemoState | null = null;
    try {
      saved = JSON.parse(localStorage.getItem(DEMO_KEY) ?? "null");
    } catch {
      /* Storage blocked or unreadable: start with fresh demo data. */
    }
    setDemoReady(true);
    if (!saved) return;
    const restored = saved;
    setReviews(restored.reviews ?? []);
    setConsent(restored.consent);
    setCustoms(restored.customs ?? []);
    if (restored.accounts) setAccounts(restored.accounts);
    if (restored.assignments) setAssignments(restored.assignments);
    setExtraPlans(restored.extraPlans ?? []);
    void (async () => {
      const urls: Record<string, string> = {};
      for (const c of restored.customs ?? []) {
        const blob = await getLocalClip(demoVideoKey(c.id));
        if (blob) urls[c.id] = URL.createObjectURL(blob);
      }
      setDemoVideoUrls((current) => ({ ...current, ...urls }));
    })();
    setOverview((current) =>
      current?.profile.role === "patient"
        ? { ...current, profile: { ...current.profile, ...restored.consent } }
        : current,
    );
    setReps(restored.reps ?? []);
    void localClipIds().then(async (ids) => {
      const urls = new Map<string, string>();
      for (const rep of restored.reps ?? []) {
        if (!ids.has(rep.id)) continue;
        const blob = await getLocalClip(rep.id);
        if (blob) urls.set(rep.id, URL.createObjectURL(blob));
      }
      if (urls.size)
        setReps((current) =>
          current.map((r) =>
            urls.has(r.id) ? { ...r, local_clip_url: urls.get(r.id) } : r,
          ),
        );
    });
  }, [demo]);

  useEffect(() => {
    if (!demo || !demoReady) return;
    const state: DemoState = {
      // Object URLs die with the page; clips are restored from the clip store.
      reps: reps.map(({ local_clip_url: _url, ...rep }) => rep),
      reviews,
      consent,
      customs,
      extraPlans,
      accounts,
      assignments,
    };
    try {
      localStorage.setItem(DEMO_KEY, JSON.stringify(state));
    } catch {
      /* Quota reached or storage blocked: keep the demo in memory. */
    }
  }, [demo, demoReady, reps, reviews, consent, customs, extraPlans, accounts, assignments]);

  async function clearDemo() {
    if (
      !window.confirm(
        "Clear all demo reps, therapist feedback, privacy choices, custom exercises, and recorded demo clips from this browser?",
      )
    )
      return;
    try {
      localStorage.removeItem(DEMO_KEY);
    } catch {
      /* Nothing stored. */
    }
    await deleteLocalClips([
      ...reps.map((r) => r.id),
      ...customs.map((c) => demoVideoKey(c.id)),
    ]);
    Object.values(demoVideoUrls).forEach((url) => URL.revokeObjectURL(url));
    setCustoms([]);
    setExtraPlans([]);
    setAccounts(demoAccounts);
    setAssignments(demoAssignments);
    setAdminPage(false);
    setDemoVideoUrls({});
    reps.forEach((r) => r.local_clip_url && URL.revokeObjectURL(r.local_clip_url));
    const fresh = { review_consent: false, training_consent: false };
    setReps([]);
    setReviews([]);
    setHistory([]);
    setHistoryVideos(new Set());
    setConsent(fresh);
    setSelected(null);
    setSession(null);
    setRole("patient");
    setPage("today");
    setOverview({ profile: demoPatient, prescriptions: demoPlans });
    setError("");
    setNotice("Demo data cleared. You are starting fresh.");
  }

  // Poll while the worker trains a submitted exercise.
  const training = customs.some((c) => c.status === "queued" || c.status === "training");
  useEffect(() => {
    if (demo || role !== "therapist" || !training) return;
    const timer = setInterval(async () => {
      try {
        const rows: CustomExercise[] = await request("/exercises");
        setCustoms(rows);
      } catch {
        /* Try again on the next tick. */
      }
    }, 5000);
    return () => clearInterval(timer);
  }, [demo, role, training, request]);

  async function submitExercise(form: ExerciseSubmission): Promise<boolean> {
    let ok = false;
    await guarded(async () => {
      if (demo) {
        // The demo has no worker, so it keeps the browser fit right away.
        const id = crypto.randomUUID();
        const segmenter = new RepSegmenter(form.preview.spec);
        const sample = form.frames
          .map((f) => segmenter.push(f))
          .find((r): r is PoseFrame[] => r !== null);
        await saveLocalClip(demoVideoKey(id), form.video);
        setDemoVideoUrls((current) => ({
          ...current,
          [id]: URL.createObjectURL(form.video),
        }));
        setCustoms((current) => [
          {
            id,
            therapist_id: demoTherapist.id,
            name: form.name,
            description: form.description,
            steps: form.steps,
            view: form.view,
            status: "ready",
            status_detail: null,
            model: form.preview,
            model_version: form.preview.version,
            demo_video_path: null,
            demo_start_ms: Math.round(form.trim.start * 1000),
            demo_end_ms: Math.round(form.trim.end * 1000),
            created_at: new Date().toISOString(),
            sample_rep: sample ? trimLeadIn(form.preview.spec, sample) : undefined,
          },
          ...current,
        ]);
        setNotice(form.name + " is trained and ready to prescribe.");
      } else {
        const row: CustomExercise = await request("/exercises", "POST", {
          name: form.name,
          description: form.description,
          steps: form.steps,
          view: form.view,
          demo_frames: form.frames,
          demo_start_ms: Math.round(form.trim.start * 1000),
          demo_end_ms: Math.round(form.trim.end * 1000),
        });
        setCustoms((current) => [row, ...current]);
        try {
          await apiFetch("/physio/exercises/" + row.id + "/video", token.current, {
            method: "PUT",
            headers: { "Content-Type": form.video.type },
            body: form.video,
          });
        } catch (e) {
          setError(
            "The exercise is queued for training, but its demo video was not uploaded. " +
              (e instanceof Error ? e.message : ""),
          );
        }
        setNotice(form.name + " was sent to the trainer. It shows Ready when its model is built.");
      }
      ok = true;
    });
    return ok;
  }

  // Admin actions resolve to a confirmation sentence, or null when they failed.
  async function adminAction(apply: () => Promise<void>, message: string) {
    let ok = false;
    await guarded(async () => {
      await apply();
      ok = true;
    });
    return ok ? message : null;
  }
  const isTherapistLike = (a: Account) => a.role === "therapist" || a.is_admin;
  function setAccountRole(account: Account, nextRole: Account["role"]) {
    return adminAction(async () => {
      if (demo)
        setAccounts((list) =>
          list.map((a) => (a.id === account.id ? { ...a, role: nextRole } : a)),
        );
      else {
        await adminRequest("/accounts/" + account.id + "/role", "POST", { role: nextRole });
        await loadAccounts();
      }
    }, `${account.display_name} is now a ${nextRole}.`);
  }
  function setAccountAdmin(account: Account, value: boolean) {
    const self = account.id === (demo ? "demo-admin" : profile?.id);
    return adminAction(async () => {
      if (demo) {
        if (!value && accounts.filter((a) => a.is_admin).length <= 1)
          throw new Error("Keep at least one admin");
        setAccounts((list) =>
          list.map((a) => (a.id === account.id ? { ...a, is_admin: value } : a)),
        );
        if (self && !value) setAdminPage(false);
      } else {
        await adminRequest("/accounts/" + account.id + "/admin", "POST", { is_admin: value });
        if (self && !value) {
          setAdminPage(false);
          viewRole.current = null;
          await load();
        } else await loadAccounts();
      }
    }, value ? `${account.display_name} is now an admin.` : `${account.display_name} is no longer an admin.`);
  }
  function assignPatient(therapist: Account, patient: Account) {
    return adminAction(async () => {
      if (demo) {
        if (!isTherapistLike(therapist)) throw new Error("Make this account a therapist first");
        setAssignments((list) =>
          list.some((a) => a.therapist_id === therapist.id && a.patient_id === patient.id)
            ? list
            : [...list, { therapist_id: therapist.id, patient_id: patient.id }],
        );
      } else {
        await adminRequest("/assignments", "POST", {
          therapist_id: therapist.id,
          patient_id: patient.id,
        });
        await loadAccounts();
      }
    }, `${patient.display_name} is now cared for by ${therapist.display_name}.`);
  }
  function unassignPatient(therapist: Account, patient: Account) {
    return adminAction(async () => {
      if (demo)
        setAssignments((list) =>
          list.filter((a) => !(a.therapist_id === therapist.id && a.patient_id === patient.id)),
        );
      else {
        await adminRequest(`/assignments/${therapist.id}/${patient.id}`, "DELETE");
        await loadAccounts();
      }
    }, `${patient.display_name} is no longer assigned to ${therapist.display_name}.`);
  }
  // Admin tabs: the console, or the admin's own therapist or patient experience.
  function switchView(next: "admin" | Profile["role"]) {
    setSelected(null);
    setPage("today");
    setError("");
    if (next === "admin") {
      setAdminPage(true);
      void loadAccounts();
      return;
    }
    setAdminPage(false);
    viewRole.current = next;
    setRole(next);
    void load();
  }

  async function guarded(action: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await action();
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "The action could not be completed.",
      );
    } finally {
      setBusy(false);
    }
  }
  function switchDemo(next: Profile["role"]) {
    setAdminPage(false);
    setRole(next);
    setSelected(null);
    setPage("today");
    setOverview({
      profile:
        next === "patient" ? { ...demoPatient, ...consent } : demoTherapist,
      prescriptions: demoPlans,
    });
    if (next === "therapist" && !reps.some((r) => r.label === "inconclusive"))
      setReps((current) => [
        ...current,
        {
          id: crypto.randomUUID(),
          session_id: "demo-session",
          prescription_id: "demo-squat",
          patient_id: demoPatient.id,
          exercise: "squat",
          exercise_day: localDay(),
          created_at: new Date().toISOString(),
          label: "inconclusive",
          error_type: "tracking",
          confidence: 0.5,
          feedback: "Tracking was uncertain.",
          model_version: MODEL_VERSION,
          frames: sampleFrames,
        },
      ]);
  }
  async function demoVideoFor(customId: string) {
    if (demo || demoVideoUrls[customId]) return;
    try {
      const { url } = await request("/exercises/" + customId + "/video");
      setDemoVideoUrls((current) => ({ ...current, [customId]: url }));
    } catch {
      setNotice("The demo video is unavailable right now. The steps are still shown.");
    }
  }
  async function start(plan: Prescription) {
    if (plan.exercise === "custom" && !movementFor("custom", info(plan).custom)) {
      setError("This exercise's model is not ready yet. Ask your therapist, then refresh.");
      return;
    }
    if (plan.custom_exercise_id) void demoVideoFor(plan.custom_exercise_id);
    await guarded(async () => {
      const data = demo
        ? [{ id: crypto.randomUUID() }]
        : await request("/sessions", "POST", {
            prescription_id: plan.id,
            timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
            ...consent,
          });
      setSession({ id: data[0].id, plan });
    });
  }
  async function record(
    frames: PoseFrame[],
    evaluation: Evaluation,
    video?: Blob,
  ): Promise<Evaluation> {
    if (!session) throw new Error("Start an exercise session first.");
    const rep: Rep = demo
      ? {
          ...evaluation,
          id: crypto.randomUUID(),
          session_id: session.id,
          patient_id: demoPatient.id,
          prescription_id: session.plan.id,
          exercise: session.plan.exercise,
          exercise_day: localDay(),
          created_at: new Date().toISOString(),
          frames,
        }
      : await request("/sessions/" + session.id + "/reps", "POST", {
          client_rep_id: crypto.randomUUID(),
          frames,
        });
    // Link the rep to its custom exercise so lists can show its name.
    rep.prescription ??= {
      custom_exercise_id: session.plan.custom_exercise_id ?? null,
    };
    if (video) {
      // Keep every rep's video on this device for the patient's own history.
      rep.local_clip_url = URL.createObjectURL(video);
      void saveLocalClip(rep.id, video);
    }
    setReps((current) => [rep, ...current.filter((r) => r.id !== rep.id)]);
    if (
      !demo &&
      rep.label === "inconclusive" &&
      consent.review_consent &&
      video
    ) {
      try {
        await apiFetch("/physio/reps/" + rep.id + "/clip", token.current, {
          method: "PUT",
          headers: { "Content-Type": video.type },
          body: video,
        });
      } catch (e) {
        setError(
          "The pose rep was saved, but its clip was not uploaded. " +
            (e instanceof Error ? e.message : ""),
        );
      }
    }
    return rep;
  }
  async function endSession() {
    await guarded(async () => {
      if (!demo && session)
        await request("/sessions/" + session.id + "/finish", "POST");
      setSession(null);
      setNotice("Session complete. Every comfortable repetition is progress.");
      if (!demo) await load();
    });
  }
  async function inspect(rep: Rep) {
    await guarded(async () => {
      setSelected(null);
      setPose([]);
      setClip(undefined);
      setFeedback("");
      setLabel("correct");
      setPose(
        demo
          ? (rep.frames ?? sampleFrames)
          : (await request("/reps/" + rep.id + "/pose")).frames,
      );
      setSelected(rep);
      if (demo) setClip(rep.local_clip_url);
      else if (rep.clip_path) {
        try {
          setClip((await request("/reps/" + rep.id + "/clip")).url);
        } catch {
          setNotice(
            "The private clip is unavailable. The recorded pose is ready to review.",
          );
        }
      }
    });
  }
  async function saveReview(event: React.FormEvent) {
    event.preventDefault();
    if (!selected) return;
    await guarded(async () => {
      const body = {
        label,
        error_type: label === "incorrect" ? errorType : null,
        feedback: feedback.trim(),
      };
      const review: Review = demo
        ? {
            ...body,
            id: crypto.randomUUID(),
            rep_id: selected.id,
            patient_id: selected.patient_id,
            created_at: new Date().toISOString(),
          }
        : await request("/reps/" + selected.id + "/review", "POST", body);
      setReviews((current) => [review, ...current]);
      setReps((current) =>
        current.map((r) => (r.id === selected.id ? { ...r, ...body } : r)),
      );
      setSelected(null);
      setNotice("Review saved. The patient can see your feedback.");
      if (!demo) await load();
    });
  }
  async function saveConsent() {
    await guarded(async () => {
      if (!demo) await request("/consent", "PATCH", consentDraft);
      setOverview((current) =>
        current
          ? { ...current, profile: { ...current.profile, ...consentDraft } }
          : current,
      );
      setConsent(consentDraft);
      setConsentOpen(false);
      setNotice("Your privacy choices have been saved.");
    });
  }
  async function openPage(next: string) {
    setPage(next);
    setSelected(null);
    setError("");
    if (next === "history")
      await guarded(async () => {
        const data: Rep[] = demo ? reps : await request("/history");
        setHistory(data);
        const ids = demo ? new Set<string>() : await localClipIds();
        setHistoryVideos(
          new Set(
            data
              .filter((r) => r.local_clip_url || r.clip_path || ids.has(r.id))
              .map((r) => r.id),
          ),
        );
        setMoreHistory(data.length === 50);
      });
    if (next === "feedback" && !demo) await load();
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <Link href="/" className="brand">
          <span className="brand-mark">
            <svg viewBox="0 0 32 32">
              <path d="M3 17h6l4-10 6 19 4-12h6" />
            </svg>
          </span>
          <span>
            physio<span className="brand-light">trace</span>
            <small>SMALL MOVES. REAL PROGRESS.</small>
          </span>
        </Link>
        <span className="nav-label">
          {adminPage
            ? "ADMINISTRATION"
            : role === "patient"
              ? "YOUR RECOVERY"
              : "YOUR PRACTICE"}
        </span>
        <nav aria-label="Main navigation">
          {adminPage ? (
            <button className="nav-item selected">
              <span>⚙</span>Accounts &amp; roles
            </button>
          ) : (
            <>
          <button
            className={"nav-item " + (page === "today" ? "selected" : "")}
            onClick={() => void openPage("today")}
          >
            <span>◫</span>
            {role === "patient" ? "Today’s plan" : "Review queue"}
            {role === "therapist" && queue.length > 0 && (
              <span className="nav-number">{queue.length}</span>
            )}
          </button>
          {role === "therapist" && (
            <>
              <button
                className={"nav-item " + (page === "plans" ? "selected" : "")}
                onClick={() => void openPage("plans")}
              >
                <span>☰</span>Patients &amp; plans
              </button>
              <button
                className={"nav-item " + (page === "exercises" ? "selected" : "")}
                onClick={() => void openPage("exercises")}
              >
                <span>✚</span>Add exercise
                {training && <span className="nav-number">…</span>}
              </button>
            </>
          )}
          {role === "patient" && (
            <>
              <button
                className={"nav-item " + (page === "history" ? "selected" : "")}
                onClick={() => void openPage("history")}
              >
                <span>◷</span>Session history
              </button>
              <button
                className={
                  "nav-item " + (page === "feedback" ? "selected" : "")
                }
                onClick={() => void openPage("feedback")}
              >
                <span>☷</span>Therapist feedback
                {reviews.length > 0 && (
                  <span className="nav-number">{reviews.length}</span>
                )}
              </button>
            </>
          )}
              <button
                className={"nav-item " + (page === "assistant" ? "selected" : "")}
                onClick={() => void openPage("assistant")}
              >
                <span>?</span>Ask PhysioTrace
              </button>
            </>
          )}
        </nav>
        <div className="sidebar-bottom">
          <div className="privacy-card">
            <span>⌁</span>
            <strong>Your space is private.</strong>
            <p>
              Movement is processed on your device. You choose what to share.
            </p>
            {role === "patient" && (
              <button
                onClick={() => {
                  setConsentOpen(true);
                  setConsentDraft({
                    review_consent: profile?.review_consent ?? false,
                    training_consent: profile?.training_consent ?? false,
                  });
                }}
              >
                Privacy choices ↗
              </button>
            )}
          </div>
          <div className="user-card">
            <span className="avatar">
              {(demo && adminPage ? "Demo Admin" : profile?.display_name)
                ?.split(" ")
                .map((w) => w[0])
                .slice(0, 2)
                .join("") || "PT"}
            </span>
            <div>
              <strong>
                {demo && adminPage
                  ? "Demo Admin"
                  : profile?.display_name || "Your account"}
              </strong>
              <small>
                {demo && adminPage
                  ? "Admin"
                  : role === "patient"
                    ? "Patient"
                    : "Physical therapist"}
                {!demo && profile?.is_admin ? " · Admin" : ""}
                {demo ? " · Demo" : ""}
              </small>
            </div>
            {!demo && (
              <form action="/logout" method="post">
                <button className="text-button" aria-label="Log out">
                  ↪
                </button>
              </form>
            )}
          </div>
        </div>
      </aside>
      <div className="main-shell">
        <header className="topbar">
          <div>
            <span className="breadcrumb">Your care / </span>
            {adminPage
              ? "Admin console"
              : session
              ? "Live session"
              : role === "therapist"
                ? "Therapist workspace"
                : "Overview"}
          </div>
          <div className="topbar-right">
            {role === "patient" && !adminPage && (
              <button
                className="topbar-privacy"
                onClick={() => {
                  setConsentDraft(consent);
                  setConsentOpen(true);
                }}
              >
                Privacy choices
              </button>
            )}
            {demo && (
              <>
                <span className="demo-badge">INTERACTIVE DEMO</span>
                <div className="role-switch" aria-label="Demo role">
                  <button
                    disabled={!!session}
                    className={!adminPage && role === "patient" ? "active" : ""}
                    onClick={() => switchDemo("patient")}
                  >
                    Patient
                  </button>
                  <button
                    disabled={!!session}
                    className={!adminPage && role === "therapist" ? "active" : ""}
                    onClick={() => switchDemo("therapist")}
                  >
                    Therapist
                  </button>
                  <button
                    disabled={!!session}
                    className={adminPage ? "active" : ""}
                    onClick={() => {
                      setSelected(null);
                      setAdminPage(true);
                    }}
                  >
                    Admin
                  </button>
                </div>
              </>
            )}
            {!demo && profile?.is_admin && (
              <div className="role-switch" aria-label="Admin view">
                {(["admin", "therapist", "patient"] as const).map((v) => (
                  <button
                    key={v}
                    disabled={!!session || loading}
                    className={
                      (v === "admin" ? adminPage : !adminPage && role === v)
                        ? "active"
                        : ""
                    }
                    onClick={() => switchView(v)}
                  >
                    {v === "admin" ? "Admin" : v === "therapist" ? "Therapist" : "Patient"}
                  </button>
                ))}
              </div>
            )}
            {/* The server and browser can disagree on today's date (time zones, midnight). */}
            <span className="date-label" suppressHydrationWarning>
              {new Date().toLocaleDateString([], {
                month: "short",
                day: "numeric",
              })}
            </span>
          </div>
        </header>
        <main className="workspace">
          {demo && (
            <div className="demo-strip">
              <span>
                A space to explore PhysioTrace. Demo data is saved in this
                browser until you clear it.
              </span>
              <span className="demo-strip-actions">
                <button
                  type="button"
                  className="text-button"
                  disabled={
                    !!session ||
                    (!reps.length && !reviews.length && !customs.length)
                  }
                  onClick={() => void clearDemo()}
                >
                  Clear demo data
                </button>
                <Link href="/signup">Create your account ↗</Link>
              </span>
            </div>
          )}
          {error && (
            <div className="error" role="alert">
              {error}
              {!demo && (
                <button className="text-button" onClick={() => void load()}>
                  Retry
                </button>
              )}
            </div>
          )}
          {notice && (
            <div className="notice" role="status">
              {notice}
              <button
                aria-label="Dismiss message"
                onClick={() => setNotice("")}
              >
                ×
              </button>
            </div>
          )}
          {adminPage ? (
            <AdminConsole
              accounts={accounts}
              assignments={assignments}
              selfId={demo ? "demo-admin" : (profile?.id ?? "")}
              busy={busy}
              demo={demo}
              onSetRole={setAccountRole}
              onSetAdmin={setAccountAdmin}
              onAssign={assignPatient}
              onUnassign={unassignPatient}
              onRefresh={() => void loadAccounts()}
            />
          ) : loading && !profile ? (
            <div className="empty-state">
              <h2>Opening your care plan…</h2>
            </div>
          ) : session ? (
            <LiveSession
              key={session.id}
              plan={session.plan}
              movement={movementFor(session.plan.exercise, info(session.plan).custom)!}
              info={info(session.plan)}
              demoVideoUrl={demoVideoUrls[customIdOf(session.plan) ?? ""]}
              demo={demo}
              uploadConsent={consent.review_consent}
              todayCount={
                todayReps.filter(
                  (r) =>
                    r.prescription_id === session.plan.id &&
                    r.label === "correct",
                ).length
              }
              onRep={record}
              onClose={endSession}
            />
          ) : role === "therapist" ? (
            page === "assistant" ? (
              <Assistant
                token={() => token.current}
                demo={demo}
                audience="therapist"
              />
            ) : page === "plans" ? (
              <>
              <div className="page-heading">
                <div>
                  <span className="eyebrow">THE RIGHT PLAN FOR EACH PERSON</span>
                  <h1>Patients &amp; plans.</h1>
                  <p>See what each patient is working on and prescribe what comes next.</p>
                </div>
              </div>
              <div className="patient-plans">
                {therapistPatients.length === 0 ? (
                  <div className="panel">
                    <Empty
                      title="No assigned patients yet."
                      text="An administrator links patients to your account. They appear here once assigned."
                    />
                  </div>
                ) : (
                  therapistPatients.map((p) => {
                    const theirs = therapistPlans.filter((plan) => plan.patient_id === p.patient_id);
                    return (
                      <article className="panel patient-plan-card" key={p.patient_id}>
                        <div className="section-heading">
                          <h2>{p.care_profiles.display_name}</h2>
                          <span className="muted">
                            {theirs.length} active plan{theirs.length === 1 ? "" : "s"}
                          </span>
                        </div>
                        {theirs.length ? (
                          <ul className="plan-list">
                            {theirs.map((plan) => (
                              <li key={plan.id}>
                                <strong>{info(plan).name}</strong>
                                <span className="muted">
                                  {plan.daily_target} reps a day · {plan.starts_on} to {plan.ends_on}
                                </span>
                              </li>
                            ))}
                          </ul>
                        ) : (
                          <p className="muted">No active plans. Prescribe one below.</p>
                        )}
                      </article>
                    );
                  })
                )}
              </div>
              <div className="panel prescription-panel">
                <h2>Prescribe an exercise</h2>
                <p className="muted">
                  Set a daily target for a patient already assigned to you.
                </p>
                <PrescriptionForm
                  customs={customs.filter((c) => c.status === "ready")}
                  patients={
                    demo
                      ? [
                          {
                            patient_id: demoPatient.id,
                            care_profiles: demoPatient,
                          },
                        ]
                      : (overview?.patients ?? [])
                  }
                  busy={busy}
                  onSubmit={async (body) => {
                    let ok = false;
                    await guarded(async () => {
                      if (!demo) await request("/prescriptions", "POST", body);
                      else if (body.exercise === "custom")
                        setExtraPlans((current) => [
                          ...current,
                          {
                            ...(body as unknown as Prescription),
                            id: crypto.randomUUID(),
                            patient_id: demoPatient.id,
                            instructions: String(body.instructions ?? ""),
                          },
                        ]);
                      ok = true;
                    });
                    if (ok && !demo) void load();
                    return ok
                      ? demo && body.exercise !== "custom"
                        ? "Previewed only: the demo plan already includes this exercise. Sign in to save real plans."
                        : demo
                          ? "Switch to Patient to try it."
                          : "Your patient sees it after refreshing their plan."
                      : null;
                  }}
                />
              </div>
              </>
            ) : page === "exercises" ? (
              <>
              <div className="page-heading">
                <div>
                  <span className="eyebrow">MOVEMENTS MADE FOR YOUR PATIENTS</span>
                  <h1>Add exercise.</h1>
                  <p>Add a movement from a demo video. Once its model is ready, prescribe it like any other exercise.</p>
                </div>
              </div>
              <div className="panel custom-panel">
                {customs.length > 0 && (
                  <h2 className="custom-subhead">Saved exercises</h2>
                )}
                {customs.length > 0 && (
                  <ul className="custom-list">
                    {customs.map((c) => (
                      <li key={c.id}>
                        <span className={"badge status-" + c.status}>
                          {trainingStatusLabel(c.status)}
                        </span>
                        <div>
                          <strong>{c.name}</strong>
                          <small>
                            {c.status === "failed"
                              ? c.status_detail || "The demo could not be used. Record it again."
                              : c.status === "ready" && c.model
                                ? `${c.model.demoReps} demo reps · ${c.view === "front" ? "facing camera" : "side-on"} · ${c.model_version}`
                                : "The trainer will pick this up shortly."}
                          </small>
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
                <h2 className="custom-subhead">Add an exercise</h2>
                <p className="muted">
                  Upload or record a demo, trim it to the reps you want, then save.
                </p>
                <CustomExerciseForm busy={busy} demo={demo} onSubmit={submitExercise} />
              </div>
              </>
            ) : (
              <>
              <div className="page-heading">
                <div>
                  <span className="eyebrow">
                    A HUMAN EYE MAKES THE DIFFERENCE
                  </span>
                  <h1>Care, with a closer look.</h1>
                  <p>
                    Review uncertain movements and help your patients move
                    forward.
                  </p>
                </div>
                <button
                  className="secondary"
                  onClick={() =>
                    demo ? setNotice("Demo queue is up to date.") : void load()
                  }
                  disabled={loading}
                >
                  ↻ Refresh queue
                </button>
              </div>
              <div className="stats-grid">
                <Stat
                  label="Awaiting your review"
                  value={String(queue.length)}
                  detail="Uncertain repetitions"
                  color="peach"
                />
                <Stat
                  label="Patients in your care"
                  value={demo ? "1" : String(overview?.patients?.length ?? 0)}
                  detail="Only your assigned patients"
                  color="sage"
                />
                <Stat
                  label="Exercise models"
                  {...modelStat(customs)}
                  color="cream"
                />
              </div>
              <div className="review-layout">
                <div className="panel">
                  <div className="section-heading">
                    <h2>
                      Review queue{" "}
                      <span className="subtle-count">{queue.length}</span>
                    </h2>
                    <span className="muted">Oldest first</span>
                  </div>
                  {!queue.length ? (
                    <Empty
                      title="All caught up."
                      text="Uncertain repetitions from your assigned patients will appear here."
                    />
                  ) : (
                    queue.map((rep) => (
                      <button
                        className={
                          "queue-item " +
                          (selected?.id === rep.id ? "queue-selected" : "")
                        }
                        key={rep.id}
                        disabled={busy}
                        onClick={() => void inspect(rep)}
                      >
                        <span className="exercise-symbol">
                          {rep.exercise === "squat" ? "↧" : "↟"}
                        </span>
                        <span>
                          <strong>
                            {demo
                              ? demoPatient.display_name
                              : (overview?.patients?.find(
                                  (p) => p.patient_id === rep.patient_id,
                                )?.care_profiles.display_name ?? "Patient")}
                          </strong>
                          <small>
                            {info(rep).name} ·{" "}
                            {Math.round(rep.confidence * 100)}% confidence
                          </small>
                        </span>
                        <span className="queue-time">
                          {rep.exercise_day}
                          <br />
                          Review →
                        </span>
                      </button>
                    ))
                  )}
                </div>
                <div className="panel">
                  {selected ? (
                    <>
                      <div className="section-heading">
                        <h2>{info(selected).short}</h2>
                        <span className="badge inconclusive">
                          Needs your review
                        </span>
                      </div>
                      <PoseReplay frames={pose} videoUrl={clip} />
                      <p className="review-reason">
                        <strong>Why it was flagged:</strong> {selected.feedback}{" "}
                        <span className="muted">
                          {Math.round(selected.confidence * 100)}% confidence ·{" "}
                          {selected.model_version} · {selected.exercise_day}
                        </span>
                      </p>
                      {!clip && (
                        <p className="muted">
                          {demo
                            ? "Simulated reps have no video. Turn on the camera in a patient session to record one."
                            : "This patient has not shared video for this rep, so only the recorded pose is shown."}
                        </p>
                      )}
                      <form onSubmit={saveReview} className="review-form">
                        <fieldset>
                          <legend>Your assessment</legend>
                          <label>
                            <input
                              type="radio"
                              name="label"
                              checked={label === "correct"}
                              onChange={() => setLabel("correct")}
                            />
                            Correct
                          </label>
                          <label>
                            <input
                              type="radio"
                              name="label"
                              checked={label === "incorrect"}
                              onChange={() => setLabel("incorrect")}
                            />
                            Needs adjustment
                          </label>
                        </fieldset>
                        {label === "incorrect" && (
                          <label>
                            Error type
                            <select
                              value={errorType}
                              onChange={(e) => setErrorType(e.target.value)}
                            >
                              <option value="range_of_motion">
                                Range of motion
                              </option>
                              <option value="tempo">Movement tempo</option>
                              <option value="uneven_movement">
                                Uneven movement
                              </option>
                              <option value="other">Other</option>
                            </select>
                          </label>
                        )}
                        <label>
                          Feedback for your patient
                          <textarea
                            value={feedback}
                            onChange={(e) => setFeedback(e.target.value)}
                            placeholder="A clear cue for their next repetition…"
                            required
                            maxLength={2000}
                            rows={3}
                          />
                        </label>
                        <p className="muted">
                          A correct label counts toward the original exercise
                          day. Training requires separate consent.
                        </p>
                        <button
                          className="primary"
                          disabled={busy || !feedback.trim()}
                        >
                          Save review & send feedback →
                        </button>
                      </form>
                    </>
                  ) : (
                    <Empty
                      title="A little context. Better care."
                      text="Select a repetition to inspect its pose replay and leave feedback."
                    />
                  )}
                </div>
              </div>
              </>
            )
          ) : page === "assistant" ? (
            <Assistant token={() => token.current} demo={demo} />
          ) : page === "today" ? (
            <>
              <div className="page-heading">
                <div>
                  <span className="eyebrow">A LITTLE BETTER, EVERY DAY</span>
                  <h1>
                    Your pace. Your progress
                    <span className="accent-dot">.</span>
                  </h1>
                  <p>
                    Welcome back
                    {profile ? ", " + profile.display_name.split(" ")[0] : ""}.
                    Let’s make room for a little movement.
                  </p>
                </div>
                <span className="care-pill">
                  <span className="status-dot" /> Guided by your therapist
                </span>
              </div>
              <div className="stats-grid">
                <Stat
                  label="Today’s accepted reps"
                  value={String(accepted).padStart(2, "0")}
                  suffix={"/ " + target}
                  detail={
                    target
                      ? Math.round(Math.min(1, accepted / target) * 100) +
                        "% of your daily plan"
                      : "Your plan is ready when assigned"
                  }
                  color="sage"
                />
                <Stat
                  label="Exercises in your plan"
                  value={String(plans.length).padStart(2, "0")}
                  detail="Move at a comfortable pace"
                  color="cream"
                />
                <Stat
                  label="Waiting for a closer look"
                  value={String(pending).padStart(2, "0")}
                  detail="Your therapist reviews uncertain reps"
                  color="peach"
                />
              </div>
              <div className="patient-grid">
                <section>
                  <div className="section-heading">
                    <h2>Your movement plan</h2>
                    <span className="muted">
                      Today · {plans.length} exercises
                    </span>
                  </div>
                  {!plans.length ? (
                    <div className="panel">
                      <Empty
                        title="Your recovery starts with a plan."
                        text="Your assigned therapist can prescribe exercises and a daily target. Refresh once your plan is ready."
                      />
                      <button className="secondary" onClick={() => void load()}>
                        Refresh plan
                      </button>
                    </div>
                  ) : (
                    plans.map((plan, i) => {
                      const count = todayReps.filter(
                        (r) =>
                          r.prescription_id === plan.id &&
                          r.label === "correct",
                      ).length;
                      return (
                        <article className="exercise-card" key={plan.id}>
                          <div
                            className={
                              "exercise-art " +
                              (i % 2 ? "art-peach" : "art-sage")
                            }
                          >
                            <MovementIllustration exercise={plan.exercise} />
                            <span className="art-number">0{i + 1}</span>
                          </div>
                          <div className="exercise-content">
                            <span className="eyebrow">
                              {info(plan).focus}
                            </span>
                            <h3>{info(plan).name}</h3>
                            <p>
                              {plan.instructions ||
                                (plan.exercise === "squat"
                                  ? "Build a steady foundation, one controlled movement at a time."
                                  : plan.exercise === "custom"
                                    ? info(plan).instruction
                                    : "Find a little more freedom in every comfortable reach.")}
                            </p>
                            <ExerciseSteps steps={info(plan).steps} />
                            {plan.custom_exercise_id && (
                              <DemoVideo
                                url={demoVideoUrls[plan.custom_exercise_id]}
                                custom={info(plan).custom}
                                onOpen={() => demoVideoFor(plan.custom_exercise_id!)}
                                name={info(plan).name}
                              />
                            )}
                            <div className="exercise-progress">
                              <span>
                                {count}{" "}
                                <span className="muted">
                                  / {plan.daily_target} reps
                                </span>
                              </span>
                              <span>
                                {count >= plan.daily_target
                                  ? "Daily target reached ✓"
                                  : "Daily target"}
                              </span>
                            </div>
                            <div className="progress-track">
                              <span
                                style={{
                                  width:
                                    Math.min(
                                      100,
                                      (count / plan.daily_target) * 100,
                                    ) + "%",
                                }}
                              />
                            </div>
                            <button
                              className={
                                (i % 2 ? "secondary" : "primary") +
                                " start-exercise"
                              }
                              disabled={busy}
                              onClick={() => void start(plan)}
                            >
                              {count >= plan.daily_target
                                ? "Practice again"
                                : "Start exercise"}
                              <span>↗</span>
                            </button>
                          </div>
                        </article>
                      );
                    })
                  )}
                </section>
                <aside>
                  <div className="panel note-panel">
                    <span className="eyebrow">A NOTE FOR YOUR JOURNEY</span>
                    <span className="note-flower">✳</span>
                    <h2>
                      Progress doesn’t
                      <br />
                      have to be perfect.
                    </h2>
                    <p>
                      Some days feel easier than others. Showing up, moving
                      comfortably, and listening to your body all count.
                    </p>
                    <div className="divider" />
                    <span className="muted">Small moves. Real progress.</span>
                  </div>
                  <div className="panel feedback-preview">
                    <div className="section-heading">
                      <h3>From your therapist</h3>
                    </div>
                    {reviews.length ? (
                      <>
                        <p>“{reviews[0].feedback}”</p>
                        <button
                          className="text-button"
                          onClick={() => void openPage("feedback")}
                        >
                          See all feedback →
                        </button>
                      </>
                    ) : (
                      <p className="muted">
                        Your therapist’s cues and reviewed repetitions will
                        appear here.
                      </p>
                    )}
                  </div>
                </aside>
              </div>
              <div className="safety-inline">
                <span>ⓘ</span>
                <p>
                  <strong>Move with care.</strong> Stop if you feel pain.
                  PhysioTrace supports your therapist’s care and does not
                  replace it.
                </p>
              </div>
            </>
          ) : page === "history" ? (
            <>
              <div className="page-heading">
                <div>
                  <span className="eyebrow">EVERY STEP FORWARD</span>
                  <h1>Your movement history.</h1>
                  <p>
                    Accepted reps, adjustments, and movements waiting for
                    review.
                  </p>
                </div>
              </div>
              <div className="panel">
                {!history.length ? (
                  <Empty
                    title="Your first rep is a fresh start."
                    text="Complete an exercise to see your history here."
                  />
                ) : (
                  <RepList
                    reps={history}
                    customs={customs}
                    loadReplay={async (rep) => {
                      const frames: PoseFrame[] = demo
                        ? (rep.frames ?? [])
                        : rep.frames ??
                          (await request("/reps/" + rep.id + "/pose")).frames;
                      if (rep.local_clip_url)
                        return { frames, url: rep.local_clip_url };
                      const local = demo ? undefined : await getLocalClip(rep.id);
                      if (local)
                        return {
                          frames,
                          url: URL.createObjectURL(local),
                          revoke: true,
                        };
                      if (!demo && rep.clip_path) {
                        try {
                          const shared = await request(
                            "/reps/" + rep.id + "/clip",
                          );
                          return { frames, url: shared.url as string };
                        } catch {
                          /* Sharing was revoked: fall back to the pose. */
                        }
                      }
                      return { frames };
                    }}
                    videoIds={historyVideos}
                  />
                )}
                {moreHistory && (
                  <button
                    className="secondary"
                    disabled={busy}
                    onClick={() =>
                      void guarded(async () => {
                        const next: Rep[] = await request(
                          "/history?offset=" + history.length,
                        );
                        setHistory((current) => [...current, ...next]);
                        setMoreHistory(next.length === 50);
                      })
                    }
                  >
                    Load more
                  </button>
                )}
              </div>
            </>
          ) : (
            <>
              <div className="page-heading">
                <div>
                  <span className="eyebrow">CARE THAT STAYS CONNECTED</span>
                  <h1>A little guidance goes a long way.</h1>
                  <p>Personal feedback from your physical therapist.</p>
                </div>
              </div>
              <div className="feedback-feed">
                {reviews.length ? (
                  reviews.map((review) => (
                    <article className="panel" key={review.id}>
                      <div className="section-heading">
                        <span className={"badge " + review.label}>
                          {review.label === "correct"
                            ? "Rep accepted"
                            : "Movement cue"}
                        </span>
                        <span className="muted">
                          {new Date(review.created_at).toLocaleDateString()}
                        </span>
                      </div>
                      <h3>{review.feedback}</h3>
                      <p className="muted">
                        {review.label === "correct"
                          ? "This review counts toward the original exercise day."
                          : "Use this cue during your next comfortable repetition."}
                      </p>
                    </article>
                  ))
                ) : (
                  <div className="panel">
                    <Empty
                      title="You’re connected to your care."
                      text="After your therapist reviews an uncertain rep, their feedback will appear here."
                    />
                  </div>
                )}
              </div>
            </>
          )}
        </main>
        <footer className="app-footer">
          <span>PHYSIOTRACE</span>
          <span>Made for the way you recover.</span>
          <span>Private by default</span>
        </footer>
      </div>
      {consentOpen && (
        <div className="modal-backdrop">
          <section
            onKeyDown={(e) => {
              if (e.key === "Escape") setConsentOpen(false);
              if (e.key === "Tab") {
                const items = e.currentTarget.querySelectorAll<HTMLElement>(
                  "button:not(:disabled), input:not(:disabled)",
                );
                const first = items[0],
                  last = items[items.length - 1];
                if (e.shiftKey && document.activeElement === first) {
                  e.preventDefault();
                  last?.focus();
                }
                if (!e.shiftKey && document.activeElement === last) {
                  e.preventDefault();
                  first?.focus();
                }
              }
            }}
            className="panel consent-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="consent-title"
          >
            <button
              autoFocus
              className="close-modal"
              aria-label="Close privacy choices"
              onClick={() => setConsentOpen(false)}
            >
              ×
            </button>
            <span className="eyebrow">YOUR MOVEMENT. YOUR CHOICE.</span>
            <h2 id="consent-title">A little clarity on privacy.</h2>
            <p>
              Camera video stays on this device by default. Pose keypoints and
              rep results are saved as care records when you sign in.
            </p>
            <label className="consent-choice">
              <input
                type="checkbox"
                checked={consentDraft.review_consent}
                onChange={(e) =>
                  setConsentDraft((c) => ({
                    ...c,
                    review_consent: e.target.checked,
                  }))
                }
              />
              <span>
                <strong>Share uncertain clips with my therapist</strong>
                <small>
                  Only flagged clips may upload. Turning this off hides shared
                  clips; an existing signed link can last up to 60 seconds.
                </small>
              </span>
            </label>
            <label className="consent-choice">
              <input
                type="checkbox"
                checked={consentDraft.training_consent}
                onChange={(e) =>
                  setConsentDraft((c) => ({
                    ...c,
                    training_consent: e.target.checked,
                  }))
                }
              />
              <span>
                <strong>
                  Allow reviewed pose data in future training datasets
                </strong>
                <small>
                  This is separate from care and clip sharing. Revoking it
                  removes your samples from future manifests. Training never
                  runs automatically.
                </small>
              </span>
            </label>
            <button
              className="primary"
              disabled={busy}
              onClick={() => void saveConsent()}
            >
              Save my choices →
            </button>
            <p className="muted">New choices apply to your next session.</p>
          </section>
        </div>
      )}
    </div>
  );
}

// The therapist's own exercise models, as the offline trainer reports them.
function modelStat(customs: CustomExercise[]) {
  const count = (status: CustomExercise["status"]) =>
    customs.filter((c) => c.status === status).length;
  const ready = count("ready");
  const waiting = count("queued") + count("training");
  const failed = count("failed");
  if (!customs.length)
    return { value: "None", detail: "Add one in Add exercise" };
  return {
    value: String(ready),
    suffix: " ready",
    detail: waiting
      ? `${waiting} training now`
      : failed
        ? `${failed} failed, see Add exercise`
        : "All up to date",
  };
}

function Stat({
  label,
  value,
  suffix,
  detail,
  color,
}: {
  label: string;
  value: string;
  suffix?: string;
  detail: string;
  color: string;
}) {
  return (
    <div className={"stat-card " + color}>
      <span className="stat-label">{label}</span>
      <div className="stat-value">
        {value}
        <span>{suffix}</span>
      </div>
      <span className="stat-detail">{detail}</span>
    </div>
  );
}
function Empty({ title, text }: { title: string; text: string }) {
  return (
    <div className="empty-state">
      <span className="empty-flower">✳</span>
      <h3>{title}</h3>
      <p>{text}</p>
    </div>
  );
}
type Replay = { frames: PoseFrame[]; url?: string; revoke?: boolean };
function RepList({
  reps,
  customs,
  loadReplay,
  videoIds,
}: {
  reps: Rep[];
  customs: CustomExercise[];
  loadReplay: (rep: Rep) => Promise<Replay>;
  videoIds: Set<string>;
}) {
  const [open, setOpen] = useState<string | null>(null);
  const [replay, setReplay] = useState<Replay | null>(null);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  useEffect(
    () => () => {
      if (replay?.revoke && replay.url) URL.revokeObjectURL(replay.url);
    },
    [replay],
  );
  async function toggle(rep: Rep) {
    setReplay(null);
    setFailed(false);
    if (open === rep.id) {
      setOpen(null);
      return;
    }
    setOpen(rep.id);
    setLoading(true);
    try {
      setReplay(await loadReplay(rep));
    } catch {
      setFailed(true);
    } finally {
      setLoading(false);
    }
  }
  return (
    <div className="rep-list">
      {reps.map((rep) => (
        <div className="rep-item" key={rep.id}>
          <div className="rep-row">
            <span className="exercise-symbol">
              {rep.exercise === "squat" ? "↧" : "↟"}
            </span>
            <div>
              <strong>{exerciseInfo(rep, customs).name}</strong>
              <small>
                {rep.exercise_day} · {Math.round(rep.confidence * 100)}%
                confidence
              </small>
              <p>{rep.feedback}</p>
            </div>
            <span className={"badge " + rep.label}>
              {rep.label === "correct"
                ? "Accepted"
                : rep.label === "incorrect"
                  ? "Adjustment"
                  : "Pending review"}
            </span>
            <button
              type="button"
              className="secondary watch-button"
              aria-expanded={open === rep.id}
              onClick={() => void toggle(rep)}
            >
              {open === rep.id
                ? "Close"
                : videoIds.has(rep.id)
                  ? "▶ Watch video"
                  : "▶ Pose replay"}
            </button>
          </div>
          {open === rep.id && (
            <div className="history-replay">
              {loading ? (
                <p className="muted">Loading replay…</p>
              ) : failed || !replay ? (
                <p className="muted">This replay could not be loaded.</p>
              ) : (
                <PoseReplay frames={replay.frames} videoUrl={replay.url} />
              )}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
function MovementIllustration({
  exercise,
}: {
  exercise: Prescription["exercise"];
}) {
  return (
    <svg
      viewBox="0 0 240 200"
      aria-label={exercise === "custom" ? "Therapist exercise" : EXERCISES[exercise].name}
      role="img"
    >
      <ellipse
        cx="123"
        cy="176"
        rx="75"
        ry="9"
        fill="currentColor"
        opacity=".08"
      />
      <path
        d="M42 166h154"
        stroke="currentColor"
        opacity=".15"
        strokeDasharray="3 5"
      />
      <circle
        cx={exercise === "squat" ? 137 : 120}
        cy={exercise === "squat" ? 50 : 38}
        r="13"
        fill="#f0ae8c"
      />
      {exercise === "custom" ? (
        <>
          <path
            d="M120 61v58m0 0-18 45m18-45 18 45"
            fill="none"
            stroke="#4d6258"
            strokeWidth="17"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <path
            d="M113 72 92 98l14 22m21-48 21 26-14 22"
            fill="none"
            stroke="#f0ae8c"
            strokeWidth="10"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <path
            d="M78 110q-10-22 6-40m78 40q10-22-6-40"
            stroke="#b97a5a"
            strokeWidth="2"
            fill="none"
            strokeDasharray="4 4"
          />
          <path
            d="M89 168h19m24 0h19"
            stroke="#293d36"
            strokeWidth="8"
            strokeLinecap="round"
          />
        </>
      ) : exercise === "squat" ? (
        <>
          {/* Side view, facing right: hips back, chest up, knee over the toes. */}
          <path
            d="M125 70 103 112l45 9-17 41"
            fill="none"
            stroke="#426255"
            strokeWidth="19"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <path
            d="M123 79l33 13 28-3"
            fill="none"
            stroke="#f0ae8c"
            strokeWidth="10"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <path
            d="M122 168h29"
            stroke="#293d36"
            strokeWidth="8"
            strokeLinecap="round"
          />
        </>
      ) : (
        <>
          <path
            d="M120 61v58m0 0-22 45m22-45 22 45"
            fill="none"
            stroke="#4d6258"
            strokeWidth="17"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <path
            d="M113 70 76 65 48 60m79 10 37-5 28-5"
            fill="none"
            stroke="#f0ae8c"
            strokeWidth="10"
            strokeLinecap="round"
          />
          <path
            d="M87 168h19m27 0h20"
            stroke="#293d36"
            strokeWidth="8"
            strokeLinecap="round"
          />
          <path
            d="M50 90q-6-14 0-28m140 28q6-14 0-28"
            stroke="#b97a5a"
            strokeWidth="2"
            fill="none"
            strokeDasharray="4 4"
          />
        </>
      )}
      <circle cx="191" cy="35" r="20" fill="#fff" opacity=".55" />
      <path
        d="m183 35 6 6 10-12"
        fill="none"
        stroke="#52735f"
        strokeWidth="2"
      />
    </svg>
  );
}
function DemoVideo({
  url,
  custom,
  onOpen,
  name,
}: {
  url?: string;
  custom?: CustomExercise;
  onOpen: () => Promise<void>;
  name: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="demo-video-inline">
      <button
        type="button"
        className="text-button"
        aria-expanded={open}
        onClick={() => {
          setOpen(!open);
          if (!open) void onOpen();
        }}
      >
        {open ? "Hide demo video" : "▶ Watch your therapist's demo"}
      </button>
      {open &&
        (url ? (
          <TrimmedVideo
            src={url}
            start={(custom?.demo_start_ms ?? 0) / 1000}
            end={custom?.demo_end_ms ? custom.demo_end_ms / 1000 : null}
            controls
            muted
            loop
            playsInline
            aria-label={"Demo of " + name}
          />
        ) : (
          <p className="muted">Loading the demo video…</p>
        ))}
    </div>
  );
}

function PrescriptionForm({
  patients,
  customs,
  busy,
  onSubmit,
}: {
  patients: NonNullable<Overview["patients"]>;
  customs: CustomExercise[];
  busy: boolean;
  // Resolves to a follow-up sentence on success, or null when saving failed.
  onSubmit: (body: Record<string, unknown>) => Promise<string | null>;
}) {
  const [saved, setSaved] = useState("");
  return (
    <form
      className="prescription-form"
      onChange={() => setSaved("")}
      onSubmit={async (event) => {
        event.preventDefault();
        const form = event.currentTarget;
        const d = new FormData(form);
        const choice = String(d.get("exercise"));
        const custom = choice.startsWith("custom:") ? choice.slice(7) : null;
        const select = form.elements.namedItem("exercise") as HTMLSelectElement;
        const patient = form.elements.namedItem("patient_id") as HTMLSelectElement;
        const exerciseName = select.selectedOptions[0]?.textContent ?? "The exercise";
        const patientName = patient.selectedOptions[0]?.textContent ?? "your patient";
        setSaved("");
        const next = await onSubmit({
          patient_id: d.get("patient_id"),
          exercise: custom ? "custom" : choice,
          custom_exercise_id: custom,
          daily_target: Number(d.get("daily_target")),
          starts_on: d.get("starts_on"),
          ends_on: d.get("ends_on"),
          instructions: d.get("instructions"),
          confidence_threshold: Number(d.get("confidence_threshold")),
        });
        if (next !== null)
          setSaved(
            `${exerciseName} prescribed to ${patientName}: ${d.get("daily_target")} reps a day, ${d.get("starts_on")} to ${d.get("ends_on")}. ${next}`,
          );
      }}
    >
      <label>
        Patient
        <select name="patient_id" required disabled={!patients.length}>
          {patients.map((p) => (
            <option value={p.patient_id} key={p.patient_id}>
              {p.care_profiles.display_name}
            </option>
          ))}
        </select>
      </label>
      <label>
        Exercise
        <select name="exercise">
          <option value="squat">Bodyweight squat</option>
          <option value="shoulder_abduction">Shoulder abduction</option>
          {customs.length > 0 && (
            <optgroup label="Your exercises">
              {customs.map((c) => (
                <option value={"custom:" + c.id} key={c.id}>
                  {c.name}
                </option>
              ))}
            </optgroup>
          )}
        </select>
      </label>
      <label>
        Daily target
        <input
          name="daily_target"
          type="number"
          min={1}
          max={200}
          defaultValue={10}
          required
        />
      </label>
      <label>
        Start date
        <input
          name="starts_on"
          type="date"
          defaultValue={localDay()}
          required
        />
      </label>
      <label>
        End date
        <input name="ends_on" type="date" min={localDay()} required />
      </label>
      <label>
        Confidence threshold
        <input
          name="confidence_threshold"
          type="number"
          min={0.6}
          max={0.99}
          step={0.01}
          defaultValue={0.8}
          required
        />
      </label>
      <label className="full-width">
        Movement cue
        <input
          name="instructions"
          maxLength={2000}
          placeholder="Your prescribed range and setup cue"
        />
      </label>
      <div className="form-actions">
        <button className="primary" disabled={busy || !patients.length}>
          {busy ? "Saving…" : "Save prescription →"}
        </button>
        {saved && (
          <p className="form-success" role="status">
            ✓ {saved}
          </p>
        )}
      </div>
    </form>
  );
}
