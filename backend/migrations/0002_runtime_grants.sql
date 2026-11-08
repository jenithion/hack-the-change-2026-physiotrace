-- Apply only after the converted public schema migrations. DATABASE_URL must
-- use a dedicated login role that is a member of `authenticated`, never an
-- owner, superuser, or BYPASSRLS role.
grant usage on schema public to authenticated;
grant select, insert, update, delete on all tables in schema public to authenticated;
grant usage, select on all sequences in schema public to authenticated;

-- Only expose user-scoped care operations. Admin RPCs perform their own
-- database-side is_admin() checks. Worker/service-only functions are omitted.
grant execute on function public.is_assigned_therapist(uuid), public.can_view_care(uuid),
  public.set_care_consent(boolean, boolean), public.finish_care_session(uuid),
  public.record_care_rep(uuid, uuid, uuid, text, jsonb, jsonb),
  public.review_care_rep(uuid, text, text, text), public.attach_care_clip(uuid, text),
  public.attach_exercise_video(uuid, text), public.admin_list_accounts(),
  public.admin_list_assignments(), public.admin_set_role(uuid, text),
  public.admin_set_admin(uuid, boolean), public.admin_assign(uuid, uuid),
  public.admin_unassign(uuid, uuid)
to authenticated;

-- Deliberately NOT granted to authenticated:
-- increment_ai_usage(uuid), bootstrap_admin(uuid), claim_custom_exercise(),
-- finish_custom_exercise(uuid,jsonb,text,text), create_care_dataset(text).
-- Add a separate service connection and explicit worker policies before using.
