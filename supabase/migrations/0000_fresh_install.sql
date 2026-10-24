-- Fresh install for a NEW deployment: control plane + zero-knowledge private
-- plane in one idempotent file, in dependency order. The incremental files of
-- the reference deployment (including its legacy import plane) live under
-- legacy/ for history only — do NOT apply them on top of this file.
--
-- Prerequisite: Supabase Auth (auth.users). The two grant rows below are
-- TEMPLATE placeholders; replace the e-mails and enable them with your own
-- data migration. Everything starts closed: admission closed, grants
-- disabled, private writes disabled.
create schema if not exists suco_control authorization postgres;
revoke all on schema suco_control from public, anon, authenticated, service_role;

-- Commercial identity only. No conversation, key, WhatsApp session or token.
create table if not exists suco_control.accounts (
  user_id uuid primary key references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  private_state text not null default 'private_setup_pending'
    check (private_state in ('private_setup_pending', 'active', 'suspended')),
  consent_version text,
  consented_at timestamptz
);

create table if not exists suco_control.admission (
  singleton boolean primary key default true check (singleton),
  mode text not null default 'closed' check (mode = 'closed'),
  tenant_capacity integer not null default 0 check (tenant_capacity = 0),
  updated_at timestamptz not null default now()
);
insert into suco_control.admission(singleton, mode, tenant_capacity)
values (true, 'closed', 0) on conflict (singleton) do nothing;

-- A pending grant has no effect. Enabling one requires your own data
-- migration; verified email is rechecked on every account lookup.
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

-- Global kill switch for every private-plane mutation. Off by default.
create table if not exists suco_control.private_storage_gate (
  singleton boolean primary key default true check (singleton),
  writes_enabled boolean not null default false,
  updated_at timestamptz not null default now()
);
insert into suco_control.private_storage_gate(singleton, writes_enabled)
values (true, false) on conflict (singleton) do nothing;

alter table suco_control.accounts enable row level security;
alter table suco_control.admission enable row level security;
alter table suco_control.email_grants enable row level security;
alter table suco_control.private_storage_gate enable row level security;
alter table suco_control.accounts force row level security;
alter table suco_control.admission force row level security;
alter table suco_control.email_grants force row level security;
alter table suco_control.private_storage_gate force row level security;
revoke all on all tables in schema suco_control from public, anon, authenticated, service_role;
alter default privileges for role postgres in schema suco_control
  revoke all on tables from public, anon, authenticated, service_role;

-- Verified identity comes from auth.users only: confirmed e-mail, not
-- anonymous. Never from editable user_metadata or client parameters.
create or replace function public.suco_verified_uid()
returns uuid language sql stable security definer set search_path = '' as $$
  select u.id from auth.users as u
  where u.id = auth.uid()
    and u.email is not null
    and u.email_confirmed_at is not null
    and u.is_anonymous = false
$$;
revoke all on function public.suco_verified_uid() from public, anon, service_role;

-- Shared mutation gate: global switch ON and the account active. Row locks
-- (FOR SHARE) serialize the decision with a concurrent gate/state change.
create or replace function suco_control.require_private_write(p_verified_uid uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_enabled boolean;
  v_state text;
begin
  if p_verified_uid is null or p_verified_uid is distinct from public.suco_verified_uid() then
    raise exception 'VERIFIED_EMAIL_REQUIRED' using errcode = '28000';
  end if;
  select g.writes_enabled into v_enabled
    from suco_control.private_storage_gate as g
   where g.singleton = true for share;
  if v_enabled is distinct from true then
    raise exception 'PRIVATE_STORAGE_DISABLED' using errcode = '55000';
  end if;
  select a.private_state into v_state
    from suco_control.accounts as a
   where a.user_id = p_verified_uid for share;
  if v_state is distinct from 'active' then
    raise exception 'PRIVATE_ACCOUNT_INACTIVE' using errcode = '55000';
  end if;
end;
$$;
revoke all on function suco_control.require_private_write(uuid)
  from public, anon, authenticated, service_role;

-- Authenticated users can create/read exactly their own commercial account.
create or replace function public.suco_account_status()
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_user_id uuid;
  v_email text;
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

  insert into suco_control.accounts(user_id) values (v_user_id)
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
    'legacyLinked', false,
    'resetPending', false,
    'privateState', v_account.private_state,
    'admissionMode', v_mode,
    'tenantCapacity', v_capacity
  );
end;
$$;
revoke all on function public.suco_account_status() from public, anon, service_role;
grant execute on function public.suco_account_status() to authenticated;

-- Private plane: opaque blobs only. Ciphertext must carry the magic prefix
-- "SUCAUTH1" where marked; nothing here is ever readable in clear.
create table if not exists public.suco_auth_state (
  owner_id uuid primary key references auth.users(id) on delete cascade,
  revision bigint not null default 1 check (revision > 0),
  ciphertext bytea not null
    check (octet_length(ciphertext) between 38 and 4194304
      and substring(ciphertext from 1 for 9) = decode('5355434f4155544831', 'hex')),
  updated_at timestamptz not null default now()
);

create table if not exists public.suco_auth_archive (
  owner_id uuid not null references auth.users(id) on delete cascade,
  archive_id uuid not null default gen_random_uuid(),
  source_revision bigint not null check (source_revision > 0),
  ciphertext bytea not null
    check (octet_length(ciphertext) between 38 and 4194304
      and substring(ciphertext from 1 for 9) = decode('5355434f4155544831', 'hex')),
  archived_at timestamptz not null default now(),
  primary key (owner_id, archive_id),
  unique (owner_id, source_revision)
);

create table if not exists public.suco_cipher_objects (
  owner_id uuid not null references auth.users(id) on delete cascade,
  object_id uuid not null,
  key_epoch integer not null check (key_epoch between 1 and 1000000000),
  nonce bytea not null check (octet_length(nonce) = 12),
  ciphertext bytea not null check (octet_length(ciphertext) between 32 and 4194304),
  revision bigint not null default 1 check (revision > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (owner_id, object_id),
  unique (owner_id, key_epoch, nonce)
);

create table if not exists public.suco_ingestion_spool (
  owner_id uuid not null references auth.users(id) on delete cascade,
  object_id uuid not null,
  key_epoch integer not null check (key_epoch between 1 and 1000000000),
  nonce bytea not null check (octet_length(nonce) = 12),
  ciphertext bytea not null check (octet_length(ciphertext) between 32 and 4194304),
  revision bigint not null default 1 check (revision = 1),
  staged_at timestamptz not null default now(),
  primary key (owner_id, object_id),
  unique (owner_id, key_epoch, nonce)
);

create table if not exists public.suco_private_messages (
  owner_id uuid not null references auth.users(id) on delete cascade,
  object_id uuid not null,
  key_epoch integer not null check (key_epoch between 1 and 1000000000),
  nonce bytea not null check (octet_length(nonce) = 12),
  ciphertext bytea not null check (octet_length(ciphertext) between 32 and 4194304),
  revision bigint not null default 1 check (revision = 1),
  stored_at timestamptz not null default now(),
  primary key (owner_id, object_id),
  unique (owner_id, key_epoch, nonce)
);

create table if not exists public.suco_private_metadata (
  owner_id uuid not null references auth.users(id) on delete cascade,
  object_id uuid not null,
  key_epoch integer not null check (key_epoch between 1 and 1000000000),
  nonce bytea not null check (octet_length(nonce) = 12),
  ciphertext bytea not null check (octet_length(ciphertext) between 32 and 4194304),
  revision bigint not null default 1 check (revision > 0),
  updated_at timestamptz not null default now(),
  primary key (owner_id, object_id)
);

alter table public.suco_auth_state enable row level security;
alter table public.suco_auth_archive enable row level security;
alter table public.suco_cipher_objects enable row level security;
alter table public.suco_ingestion_spool enable row level security;
alter table public.suco_private_messages enable row level security;
alter table public.suco_private_metadata enable row level security;
alter table public.suco_auth_state force row level security;
alter table public.suco_auth_archive force row level security;
alter table public.suco_cipher_objects force row level security;
alter table public.suco_ingestion_spool force row level security;
alter table public.suco_private_messages force row level security;
alter table public.suco_private_metadata force row level security;
revoke all on all tables in schema public
  from anon;  -- default public grant removed for the private plane

drop policy if exists suco_auth_state_own on public.suco_auth_state;
create policy suco_auth_state_own on public.suco_auth_state
  for all to authenticated
  using (owner_id = public.suco_verified_uid())
  with check (owner_id = public.suco_verified_uid());

drop policy if exists suco_auth_archive_own on public.suco_auth_archive;
create policy suco_auth_archive_own on public.suco_auth_archive
  for all to authenticated
  using (owner_id = public.suco_verified_uid())
  with check (owner_id = public.suco_verified_uid());

drop policy if exists suco_private_metadata_own on public.suco_private_metadata;
create policy suco_private_metadata_own on public.suco_private_metadata
  for all to authenticated
  using (owner_id = public.suco_verified_uid())
  with check (owner_id = public.suco_verified_uid());

-- Cipher objects are append-only via RPC; direct SELECT keeps owner-scoped
-- recovery possible without any write path.
drop policy if exists suco_cipher_select_own on public.suco_cipher_objects;
create policy suco_cipher_select_own on public.suco_cipher_objects
  for select to authenticated
  using (owner_id = public.suco_verified_uid());

-- Sealed Signal-protocol state, browser-born: CAS on a single row.
create or replace function public.suco_auth_read()
returns table (revision text, ciphertext_hex text)
language plpgsql security definer set search_path = '' as $$
declare v_uid uuid;
begin
  v_uid := public.suco_verified_uid();
  if v_uid is null then
    raise exception 'VERIFIED_EMAIL_REQUIRED' using errcode = '28000';
  end if;
  return query select s.revision::text, pg_catalog.encode(s.ciphertext, 'hex')
    from public.suco_auth_state as s where s.owner_id = v_uid;
end;
$$;

create or replace function public.suco_auth_cas(p_expected_revision bigint, p_ciphertext_hex text)
returns text language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid;
  v_next bigint;
begin
  v_uid := public.suco_verified_uid();
  if v_uid is null then
    raise exception 'VERIFIED_EMAIL_REQUIRED' using errcode = '28000';
  end if;
  perform suco_control.require_private_write(v_uid);
  if p_expected_revision is null or p_expected_revision < 0 or
     p_expected_revision = 9223372036854775807 or
     p_ciphertext_hex is null or
     p_ciphertext_hex !~ '^[0-9a-f]+$' or
     length(p_ciphertext_hex) not between 76 and 8388608 or
     length(p_ciphertext_hex) % 2 <> 0 or
     left(p_ciphertext_hex, 18) <> '5355434f4155544831' then
    raise exception 'INVALID_AUTH_OBJECT' using errcode = '22023';
  end if;

  if p_expected_revision = 0 then
    insert into public.suco_auth_state (owner_id, ciphertext)
      values (v_uid, pg_catalog.decode(p_ciphertext_hex, 'hex'))
      on conflict (owner_id) do nothing
      returning revision into v_next;
  else
    update public.suco_auth_state
       set ciphertext = pg_catalog.decode(p_ciphertext_hex, 'hex'),
           revision = revision + 1,
           updated_at = now()
     where owner_id = v_uid and revision = p_expected_revision
     returning revision into v_next;
  end if;
  if v_next is null then
    raise exception 'REVISION_CONFLICT' using errcode = '40001';
  end if;
  return v_next::text;
end;
$$;

create or replace function public.suco_auth_archive(p_expected_revision bigint, p_ciphertext_hex text)
returns boolean language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid;
  v_sealed bytea;
  v_archived bytea;
begin
  v_uid := public.suco_verified_uid();
  if v_uid is null then
    raise exception 'VERIFIED_EMAIL_REQUIRED' using errcode = '28000';
  end if;
  perform suco_control.require_private_write(v_uid);
  if p_expected_revision is null or p_expected_revision < 1 or
     p_ciphertext_hex is null or p_ciphertext_hex !~ '^[0-9a-f]+$' or
     length(p_ciphertext_hex) not between 76 and 8388608 or
     length(p_ciphertext_hex) % 2 <> 0 or
     left(p_ciphertext_hex, 18) <> '5355434f4155544831' then
    raise exception 'INVALID_AUTH_OBJECT' using errcode = '22023';
  end if;
  v_sealed := pg_catalog.decode(p_ciphertext_hex, 'hex');
  select a.ciphertext into v_archived from public.suco_auth_archive as a
   where a.owner_id = v_uid and a.source_revision = p_expected_revision;
  if found then
    if v_archived <> v_sealed then
      raise exception 'REVISION_CONFLICT' using errcode = '40001';
    end if;
    return true;
  end if;
  insert into public.suco_auth_archive(owner_id, source_revision, ciphertext)
    select s.owner_id, s.revision, s.ciphertext
      from public.suco_auth_state as s
     where s.owner_id = v_uid and s.revision = p_expected_revision
       and s.ciphertext = v_sealed
    on conflict (owner_id, source_revision) do nothing;
  if not found then
    raise exception 'REVISION_CONFLICT' using errcode = '40001';
  end if;
  return true;
end;
$$;

-- Generic opaque objects (worker storage): CAS by (owner, object).
create or replace function public.suco_cipher_put(p_object_id uuid, p_expected_revision bigint,
  p_key_epoch integer, p_nonce bytea, p_ciphertext bytea)
returns bigint language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid;
  v_revision bigint;
begin
  v_uid := public.suco_verified_uid();
  if v_uid is null then
    raise exception 'VERIFIED_EMAIL_REQUIRED' using errcode = '28000';
  end if;
  perform suco_control.require_private_write(v_uid);
  if p_object_id is null or p_expected_revision is null or p_expected_revision < 0
     or p_expected_revision = 9223372036854775807 then
    raise exception 'INVALID_REVISION' using errcode = '22023';
  end if;

  if p_expected_revision = 0 then
    insert into public.suco_cipher_objects
      (owner_id, object_id, key_epoch, nonce, ciphertext)
    values (v_uid, p_object_id, p_key_epoch, p_nonce, p_ciphertext)
    on conflict (owner_id, object_id) do nothing
    returning revision into v_revision;
  else
    update public.suco_cipher_objects
    set key_epoch = p_key_epoch, nonce = p_nonce,
        ciphertext = p_ciphertext, revision = revision + 1,
        updated_at = now()
    where owner_id = v_uid and object_id = p_object_id
      and revision = p_expected_revision
    returning revision into v_revision;
  end if;
  if v_revision is null then
    raise exception 'REVISION_CONFLICT' using errcode = '40001';
  end if;
  return v_revision;
end;
$$;

-- Delete is a mutation like any other: gated by require_private_write too.
create or replace function public.suco_cipher_delete(p_object_id uuid, p_expected_revision bigint)
returns boolean language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid;
  v_deleted uuid;
begin
  v_uid := public.suco_verified_uid();
  if v_uid is null then
    raise exception 'VERIFIED_EMAIL_REQUIRED' using errcode = '28000';
  end if;
  perform suco_control.require_private_write(v_uid);
  if p_object_id is null or p_expected_revision is null or p_expected_revision < 1 then
    raise exception 'INVALID_REVISION' using errcode = '22023';
  end if;
  delete from public.suco_cipher_objects
    where owner_id = v_uid and object_id = p_object_id
      and revision = p_expected_revision
    returning object_id into v_deleted;
  return v_deleted is not null;
end;
$$;

-- Ingestion landing zone: stage from the worker, list, ack after commit.
create or replace function public.suco_ingestion_stage(p_object_id uuid, p_key_epoch integer,
  p_nonce_hex text, p_ciphertext_hex text)
returns bigint language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid;
  v_revision bigint;
begin
  v_uid := public.suco_verified_uid();
  if v_uid is null then
    raise exception 'VERIFIED_EMAIL_REQUIRED' using errcode = '28000';
  end if;
  perform suco_control.require_private_write(v_uid);
  if p_object_id is null or p_key_epoch is null
     or p_key_epoch not between 1 and 1000000000
     or p_nonce_hex is null or p_nonce_hex !~ '^[0-9a-f]{24}$'
     or p_ciphertext_hex is null or p_ciphertext_hex !~ '^[0-9a-f]+$'
     or length(p_ciphertext_hex) not between 64 and 8388608
     or length(p_ciphertext_hex) % 2 <> 0 then
    raise exception 'INVALID_INGESTION_OBJECT' using errcode = '22023';
  end if;

  insert into public.suco_ingestion_spool
    (owner_id, object_id, key_epoch, nonce, ciphertext)
  values (v_uid, p_object_id, p_key_epoch,
          pg_catalog.decode(p_nonce_hex, 'hex'),
          pg_catalog.decode(p_ciphertext_hex, 'hex'))
  on conflict (owner_id, object_id) do nothing;
  select revision into strict v_revision
    from public.suco_ingestion_spool
   where owner_id = v_uid and object_id = p_object_id;
  return v_revision;
end;
$$;

create or replace function public.suco_ingestion_list(p_after uuid default null, p_limit integer default 100)
returns table (object_id uuid, key_epoch integer, nonce_hex text, ciphertext_hex text, revision bigint)
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid;
begin
  v_uid := public.suco_verified_uid();
  if v_uid is null then
    raise exception 'VERIFIED_EMAIL_REQUIRED' using errcode = '28000';
  end if;
  if p_limit is null or p_limit not between 1 and 100 then
    raise exception 'INVALID_LIMIT' using errcode = '22023';
  end if;
  return query
    select s.object_id, s.key_epoch,
           pg_catalog.encode(s.nonce, 'hex'),
           pg_catalog.encode(s.ciphertext, 'hex'), s.revision
      from public.suco_ingestion_spool as s
     where s.owner_id = v_uid
       and (p_after is null or s.object_id > p_after)
     order by s.object_id
     limit p_limit;
end;
$$;

create or replace function public.suco_ingestion_ack(p_object_id uuid, p_expected_revision bigint)
returns boolean language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid;
  v_revision bigint;
begin
  v_uid := public.suco_verified_uid();
  if v_uid is null then
    raise exception 'VERIFIED_EMAIL_REQUIRED' using errcode = '28000';
  end if;
  perform suco_control.require_private_write(v_uid);
  if p_object_id is null or p_expected_revision is null or p_expected_revision <> 1 then
    raise exception 'INVALID_REVISION' using errcode = '22023';
  end if;
  delete from public.suco_ingestion_spool
   where owner_id = v_uid and object_id = p_object_id
     and revision = p_expected_revision;
  if found then return true; end if;
  select revision into v_revision
    from public.suco_ingestion_spool
   where owner_id = v_uid and object_id = p_object_id;
  if v_revision is null then return true; end if;
  raise exception 'REVISION_CONFLICT' using errcode = '40001';
end;
$$;

-- Committed messages: write-once objects with read-back for verification.
create or replace function public.suco_message_commit(p_object_id uuid, p_key_epoch integer,
  p_nonce_hex text, p_ciphertext_hex text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid;
  v_revision bigint;
  v_created boolean := false;
begin
  v_uid := public.suco_verified_uid();
  if v_uid is null then
    raise exception 'VERIFIED_EMAIL_REQUIRED' using errcode = '28000';
  end if;
  perform suco_control.require_private_write(v_uid);
  if p_object_id is null or p_key_epoch is null
     or p_key_epoch not between 1 and 1000000000
     or p_nonce_hex is null or p_nonce_hex !~ '^[0-9a-f]{24}$'
     or p_ciphertext_hex is null or p_ciphertext_hex !~ '^[0-9a-f]+$'
     or length(p_ciphertext_hex) not between 64 and 8388608
     or length(p_ciphertext_hex) % 2 <> 0 then
    raise exception 'INVALID_MESSAGE_OBJECT' using errcode = '22023';
  end if;
  insert into public.suco_private_messages
    (owner_id, object_id, key_epoch, nonce, ciphertext)
  values (v_uid, p_object_id, p_key_epoch,
          pg_catalog.decode(p_nonce_hex, 'hex'),
          pg_catalog.decode(p_ciphertext_hex, 'hex'))
  on conflict (owner_id, object_id) do nothing
  returning revision into v_revision;
  if v_revision is not null then
    v_created := true;
  else
    select revision into strict v_revision
      from public.suco_private_messages
     where owner_id = v_uid and object_id = p_object_id;
  end if;
  return pg_catalog.jsonb_build_object('revision', v_revision, 'created', v_created);
end;
$$;

create or replace function public.suco_message_list(p_after uuid default null, p_limit integer default 100)
returns table (object_id uuid, key_epoch integer, nonce_hex text, ciphertext_hex text, revision bigint)
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid;
begin
  v_uid := public.suco_verified_uid();
  if v_uid is null then
    raise exception 'VERIFIED_EMAIL_REQUIRED' using errcode = '28000';
  end if;
  if p_limit is null or p_limit not between 1 and 100 then
    raise exception 'INVALID_LIMIT' using errcode = '22023';
  end if;
  return query
    select m.object_id, m.key_epoch,
           pg_catalog.encode(m.nonce, 'hex'),
           pg_catalog.encode(m.ciphertext, 'hex'), m.revision
      from public.suco_private_messages as m
     where m.owner_id = v_uid
       and (p_after is null or m.object_id > p_after)
     order by m.object_id
     limit p_limit;
end;
$$;

create or replace function public.suco_message_read(p_object_id uuid)
returns table (object_id uuid, key_epoch integer, nonce_hex text, ciphertext_hex text, revision bigint)
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid;
begin
  v_uid := public.suco_verified_uid();
  if v_uid is null then
    raise exception 'VERIFIED_EMAIL_REQUIRED' using errcode = '28000';
  end if;
  if p_object_id is null then
    raise exception 'INVALID_MESSAGE_OBJECT' using errcode = '22023';
  end if;
  return query
    select m.object_id, m.key_epoch,
           pg_catalog.encode(m.nonce, 'hex'),
           pg_catalog.encode(m.ciphertext, 'hex'), m.revision
      from public.suco_private_messages as m
     where m.owner_id = v_uid and m.object_id = p_object_id;
end;
$$;

-- Account metadata (timezone, group list, …): CAS, revision as text.
create or replace function public.suco_meta_put(p_object_id uuid, p_expected_revision bigint,
  p_key_epoch integer, p_nonce_hex text, p_ciphertext_hex text)
returns text language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid;
  v_next bigint;
begin
  v_uid := public.suco_verified_uid();
  if v_uid is null then
    raise exception 'VERIFIED_EMAIL_REQUIRED' using errcode = '28000';
  end if;
  perform suco_control.require_private_write(v_uid);
  if p_object_id is null or p_expected_revision is null or
     p_expected_revision < 0 or p_expected_revision = 9223372036854775807 or
     p_key_epoch is null or p_key_epoch not between 1 and 1000000000 or
     p_nonce_hex is null or p_nonce_hex !~ '^[0-9a-f]{24}$' or
     p_ciphertext_hex is null or p_ciphertext_hex !~ '^[0-9a-f]+$' or
     length(p_ciphertext_hex) not between 64 and 8388608 or
     length(p_ciphertext_hex) % 2 <> 0 then
    raise exception 'INVALID_METADATA_OBJECT' using errcode = '22023';
  end if;
  if p_expected_revision = 0 then
    insert into public.suco_private_metadata
      (owner_id, object_id, key_epoch, nonce, ciphertext)
    values (v_uid, p_object_id, p_key_epoch,
            pg_catalog.decode(p_nonce_hex, 'hex'),
            pg_catalog.decode(p_ciphertext_hex, 'hex'))
    on conflict (owner_id, object_id) do nothing
    returning revision into v_next;
  else
    update public.suco_private_metadata
       set key_epoch = p_key_epoch,
           nonce = pg_catalog.decode(p_nonce_hex, 'hex'),
           ciphertext = pg_catalog.decode(p_ciphertext_hex, 'hex'),
           revision = revision + 1,
           updated_at = now()
     where owner_id = v_uid and object_id = p_object_id
       and revision = p_expected_revision
     returning revision into v_next;
  end if;
  if v_next is null then
    raise exception 'REVISION_CONFLICT' using errcode = '40001';
  end if;
  return v_next::text;
end;
$$;

create or replace function public.suco_meta_list(p_after uuid default null, p_limit integer default 100)
returns table (object_id uuid, key_epoch integer, nonce_hex text, ciphertext_hex text, revision text)
language plpgsql security definer set search_path = '' as $$
declare v_uid uuid;
begin
  v_uid := public.suco_verified_uid();
  if v_uid is null then
    raise exception 'VERIFIED_EMAIL_REQUIRED' using errcode = '28000';
  end if;
  if p_limit is null or p_limit not between 1 and 100 then
    raise exception 'INVALID_LIMIT' using errcode = '22023';
  end if;
  return query select m.object_id, m.key_epoch,
      pg_catalog.encode(m.nonce, 'hex'), pg_catalog.encode(m.ciphertext, 'hex'),
      m.revision::text
    from public.suco_private_metadata as m
     where m.owner_id = v_uid and (p_after is null or m.object_id > p_after)
     order by m.object_id limit p_limit;
end;
$$;

-- Consent is commercial/account metadata only. Active accounts only.
create or replace function public.suco_consent_status()
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid;
  v_row suco_control.accounts%rowtype;
begin
  v_uid := public.suco_verified_uid();
  if v_uid is null then
    raise exception 'VERIFIED_EMAIL_REQUIRED' using errcode = '28000';
  end if;
  select * into v_row from suco_control.accounts
    where user_id = v_uid and private_state = 'active';
  if not found then
    raise exception 'PRIVATE_ACCOUNT_NOT_ACTIVE' using errcode = '42501';
  end if;
  if v_row.consent_version is null or v_row.consented_at is null then
    return pg_catalog.jsonb_build_object('consent', null);
  end if;
  return pg_catalog.jsonb_build_object('consent',
    pg_catalog.jsonb_build_object('version', v_row.consent_version,
      'acceptedAt', v_row.consented_at));
end;
$$;

create or replace function public.suco_consent_accept(p_version text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid;
  v_row suco_control.accounts%rowtype;
begin
  v_uid := public.suco_verified_uid();
  if v_uid is null then
    raise exception 'VERIFIED_EMAIL_REQUIRED' using errcode = '28000';
  end if;
  if p_version is distinct from 'readonly-2026-10-15' then
    raise exception 'CONSENT_VERSION_INVALID' using errcode = '22023';
  end if;
  update suco_control.accounts set
    consent_version = p_version,
    consented_at = case when consent_version = p_version and consented_at is not null
      then consented_at else now() end
  where user_id = v_uid and private_state = 'active'
  returning * into v_row;
  if not found then
    raise exception 'PRIVATE_ACCOUNT_NOT_ACTIVE' using errcode = '42501';
  end if;
  return pg_catalog.jsonb_build_object('consent',
    pg_catalog.jsonb_build_object('version', v_row.consent_version,
      'acceptedAt', v_row.consented_at));
end;
$$;

-- Function surface: authenticated only; nothing callable by anon or the
-- service role from the API layer.
revoke all on function public.suco_auth_read() from public, anon, service_role;
revoke all on function public.suco_auth_cas(bigint, text) from public, anon, service_role;
revoke all on function public.suco_auth_archive(bigint, text) from public, anon, service_role;
revoke all on function public.suco_cipher_put(uuid, bigint, integer, bytea, bytea) from public, anon, service_role;
revoke all on function public.suco_cipher_delete(uuid, bigint) from public, anon, service_role;
revoke all on function public.suco_ingestion_stage(uuid, integer, text, text) from public, anon, service_role;
revoke all on function public.suco_ingestion_list(uuid, integer) from public, anon, service_role;
revoke all on function public.suco_ingestion_ack(uuid, bigint) from public, anon, service_role;
revoke all on function public.suco_message_commit(uuid, integer, text, text) from public, anon, service_role;
revoke all on function public.suco_message_list(uuid, integer) from public, anon, service_role;
revoke all on function public.suco_message_read(uuid) from public, anon, service_role;
revoke all on function public.suco_meta_put(uuid, bigint, integer, text, text) from public, anon, service_role;
revoke all on function public.suco_meta_list(uuid, integer) from public, anon, service_role;
revoke all on function public.suco_consent_status() from public, anon, service_role;
revoke all on function public.suco_consent_accept(text) from public, anon, service_role;
grant execute on function public.suco_auth_read() to authenticated;
grant execute on function public.suco_auth_cas(bigint, text) to authenticated;
grant execute on function public.suco_auth_archive(bigint, text) to authenticated;
grant execute on function public.suco_cipher_put(uuid, bigint, integer, bytea, bytea) to authenticated;
grant execute on function public.suco_cipher_delete(uuid, bigint) to authenticated;
grant execute on function public.suco_ingestion_stage(uuid, integer, text, text) to authenticated;
grant execute on function public.suco_ingestion_list(uuid, integer) to authenticated;
grant execute on function public.suco_ingestion_ack(uuid, bigint) to authenticated;
grant execute on function public.suco_message_commit(uuid, integer, text, text) to authenticated;
grant execute on function public.suco_message_list(uuid, integer) to authenticated;
grant execute on function public.suco_message_read(uuid) to authenticated;
grant execute on function public.suco_meta_put(uuid, bigint, integer, text, text) to authenticated;
grant execute on function public.suco_meta_list(uuid, integer) to authenticated;
grant execute on function public.suco_consent_status() to authenticated;
grant execute on function public.suco_consent_accept(text) to authenticated;
