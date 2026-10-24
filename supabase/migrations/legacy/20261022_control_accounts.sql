-- TEMPLATE: e-mails, UUIDs e hashes abaixo são placeholders. Troque pelas identidades reais do seu deployment antes de aplicar.
-- Commercial identity only. No conversation, key, WhatsApp session or calendar token.
-- Keep worker admission closed until the private data plane passes its own QA.
create schema if not exists suco_control authorization postgres;
revoke all on schema suco_control from public, anon, authenticated, service_role;

create table if not exists suco_control.accounts (
  user_id uuid primary key references auth.users(id) on delete cascade,
  legacy_account_source_id text unique references suco_migration.legacy_accounts(source_id),
  created_at timestamptz not null default now(),
  private_state text not null default 'private_setup_pending'
    check (private_state = 'private_setup_pending')
);

create table if not exists suco_control.admission (
  singleton boolean primary key default true check (singleton),
  mode text not null default 'closed' check (mode = 'closed'),
  tenant_capacity integer not null default 0 check (tenant_capacity = 0),
  updated_at timestamptz not null default now()
);
insert into suco_control.admission(singleton, mode, tenant_capacity)
values (true, 'closed', 0) on conflict (singleton) do nothing;

-- A pending grant has no effect. Enabling it requires the release gate and
-- a separate migration; verified email is rechecked on every account lookup.
create table if not exists suco_control.email_grants (
  email text primary key check (email = lower(email) and length(email) between 3 and 254),
  tier text not null check (tier in ('owner', 'partner_full')),
  enabled boolean not null default false check (enabled = false),
  created_at timestamptz not null default now()
);
insert into suco_control.email_grants(email, tier, enabled)
values ('owner@example.com', 'owner', false),
       ('partner@example.com', 'partner_full', false)
on conflict (email) do nothing;

alter table suco_control.accounts enable row level security;
alter table suco_control.admission enable row level security;
alter table suco_control.email_grants enable row level security;
alter table suco_control.accounts force row level security;
alter table suco_control.admission force row level security;
alter table suco_control.email_grants force row level security;
revoke all on all tables in schema suco_control from public, anon, authenticated, service_role;
alter default privileges for role postgres in schema suco_control
  revoke all on tables from public, anon, authenticated, service_role;

-- Authenticated users can create/read exactly their own commercial account.
-- Email confirmation and anonymous status are read from auth.users, never
-- from editable user_metadata or client-supplied parameters.
create or replace function public.suco_account_status()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid;
  v_email text;
  v_legacy_source text;
  v_legacy_matches integer;
  v_account suco_control.accounts%rowtype;
  v_mode text;
  v_capacity integer;
  v_tier text;
begin
  v_user_id := auth.uid();
  if v_user_id is null then
    raise exception 'AUTH_REQUIRED' using errcode = '28000';
  end if;

  select lower(u.email) into v_email
  from auth.users as u
  where u.id = v_user_id
    and u.email is not null
    and u.email_confirmed_at is not null
    and u.is_anonymous = false;
  if v_email is null then
    raise exception 'VERIFIED_EMAIL_REQUIRED' using errcode = '28000';
  end if;

  select count(*)::integer, min(a.source_id)
    into v_legacy_matches, v_legacy_source
  from suco_migration.legacy_users as u
  join suco_migration.legacy_accounts as a
    on pg_catalog.regexp_replace(a.identity, '^.*\|', '') = u.source_id
  where u.email = v_email and u.email_verified_at is not null;
  if v_legacy_matches > 1 then
    raise exception 'LEGACY_LINK_AMBIGUOUS' using errcode = '23505';
  end if;

  insert into suco_control.accounts(user_id, legacy_account_source_id)
  values (v_user_id, v_legacy_source)
  on conflict (user_id) do nothing;
  select * into strict v_account from suco_control.accounts where user_id = v_user_id;
  select mode, tenant_capacity into strict v_mode, v_capacity
    from suco_control.admission where singleton = true;
  select tier into v_tier from suco_control.email_grants
    where email = v_email and enabled = true;

  return pg_catalog.jsonb_build_object(
    'accountId', v_account.user_id,
    'email', v_email,
    'entitlement', coalesce(v_tier, 'free'),
    'legacyLinked', v_account.legacy_account_source_id is not null,
    'privateState', v_account.private_state,
    'admissionMode', v_mode,
    'tenantCapacity', v_capacity
  );
end;
$$;
revoke all on function public.suco_account_status() from public, anon, service_role;
grant execute on function public.suco_account_status() to authenticated;
