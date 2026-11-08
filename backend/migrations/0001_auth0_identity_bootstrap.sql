-- Run this BEFORE the converted application schema migrations.
-- Auth0 subject strings are not UUIDs. Preserve the existing UUID-based
-- PhysioTrace relational model by mapping each Auth0 subject to a stable UUID.
create extension if not exists pgcrypto;
create schema if not exists auth;

do $$ begin
  create role authenticated nologin;
exception when duplicate_object then null; end $$;
do $$ begin
  create role service_role nologin;
exception when duplicate_object then null; end $$;

create table if not exists auth.users (
  id uuid primary key default gen_random_uuid(),
  email text,
  raw_user_meta_data jsonb not null default '{}'::jsonb,
  raw_app_meta_data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.auth0_identities (
  auth0_sub text primary key,
  user_id uuid not null unique references auth.users(id) on delete cascade,
  email text,
  email_verified boolean not null default false,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);

-- RLS policies and SQL functions from the existing migrations can continue
-- using auth.uid() after the API sets request.jwt.claim.sub to the mapped UUID.
create or replace function auth.uid() returns uuid
language sql stable
as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;
$$;

grant usage on schema auth, public to authenticated, service_role;
grant execute on function auth.uid() to authenticated, service_role;
create or replace function public.resolve_auth0_identity(
  p_auth0_sub text, p_email text, p_email_verified boolean, p_display_name text
) returns uuid
language plpgsql security definer set search_path = public, auth, pg_temp
as $$
declare v_user_id uuid;
begin
  select user_id into v_user_id from public.auth0_identities where auth0_sub = p_auth0_sub;
  if v_user_id is null then
    insert into auth.users(email, raw_user_meta_data)
      values(p_email, jsonb_build_object('display_name', coalesce(nullif(p_display_name, ''), 'Patient')))
      returning id into v_user_id;
    insert into public.auth0_identities(auth0_sub, user_id, email, email_verified)
      values(p_auth0_sub, v_user_id, p_email, coalesce(p_email_verified, false));
  else
    update public.auth0_identities set email=p_email, email_verified=coalesce(p_email_verified, false), last_seen_at=now()
      where auth0_sub=p_auth0_sub;
    update auth.users set email=p_email where id=v_user_id;
  end if;
  return v_user_id;
end;
$$;
revoke all on function public.resolve_auth0_identity(text,text,boolean,text) from public;
grant execute on function public.resolve_auth0_identity(text,text,boolean,text) to authenticated, service_role;

