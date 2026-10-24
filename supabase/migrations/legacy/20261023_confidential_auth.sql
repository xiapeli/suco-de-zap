-- Baileys auth is sealed inside the attested worker. Supabase holds only the
-- encrypted envelope, an optimistic revision and opaque backup metadata.
-- The existing private_storage_gate remains OFF until confidential cutover.
create table if not exists public.suco_auth_state (
  owner_id uuid primary key references auth.users(id) on delete cascade,
  revision bigint not null default 1 check (revision > 0),
  ciphertext bytea not null check (
    octet_length(ciphertext) between 38 and 4194304 and
    substring(ciphertext from 1 for 9) = pg_catalog.decode('5355434f4155544831', 'hex')
  ),
  updated_at timestamptz not null default now()
);
create table if not exists public.suco_auth_archive (
  owner_id uuid not null references auth.users(id) on delete cascade,
  archive_id uuid not null default pg_catalog.gen_random_uuid(),
  source_revision bigint not null check (source_revision > 0),
  ciphertext bytea not null check (
    octet_length(ciphertext) between 38 and 4194304 and
    substring(ciphertext from 1 for 9) = pg_catalog.decode('5355434f4155544831', 'hex')
  ),
  archived_at timestamptz not null default now(),
  primary key (owner_id, archive_id),
  unique (owner_id, source_revision)
);
alter table public.suco_auth_state enable row level security;
alter table public.suco_auth_state force row level security;
alter table public.suco_auth_archive enable row level security;
alter table public.suco_auth_archive force row level security;
revoke all on public.suco_auth_state from public, anon, authenticated, service_role;
revoke all on public.suco_auth_archive from public, anon, authenticated, service_role;

-- Defense in depth if direct table grants are ever changed; current access is
-- only through the checked RPCs below.
drop policy if exists suco_auth_state_own on public.suco_auth_state;
create policy suco_auth_state_own on public.suco_auth_state
  for all to authenticated
  using (owner_id = (select public.suco_verified_uid()))
  with check (owner_id = (select public.suco_verified_uid()));
drop policy if exists suco_auth_archive_own on public.suco_auth_archive;
create policy suco_auth_archive_own on public.suco_auth_archive
  for all to authenticated
  using (owner_id = (select public.suco_verified_uid()))
  with check (owner_id = (select public.suco_verified_uid()));

create or replace function public.suco_auth_read()
returns table (revision text, ciphertext_hex text)
language plpgsql security definer
set search_path = ''
as $$
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
revoke all on function public.suco_auth_read() from public, anon, service_role;
grant execute on function public.suco_auth_read() to authenticated;

create or replace function public.suco_auth_cas(
  p_expected_revision bigint,
  p_ciphertext_hex text
) returns text
language plpgsql security definer
set search_path = ''
as $$
declare
  v_uid uuid;
  v_enabled boolean;
  v_next bigint;
begin
  v_uid := public.suco_verified_uid();
  if v_uid is null then
    raise exception 'VERIFIED_EMAIL_REQUIRED' using errcode = '28000';
  end if;
  select writes_enabled into strict v_enabled
    from suco_control.private_storage_gate where singleton = true;
  if not v_enabled then
    raise exception 'PRIVATE_STORAGE_DISABLED' using errcode = '55000';
  end if;
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
revoke all on function public.suco_auth_cas(bigint,text)
  from public, anon, service_role;
grant execute on function public.suco_auth_cas(bigint,text)
  to authenticated;

-- The backup copies the exact current sealed bytes. A lost HTTP response can
-- be retried safely; it never overwrites a prior archive for that revision.
create or replace function public.suco_auth_archive(
  p_expected_revision bigint,
  p_ciphertext_hex text
) returns boolean
language plpgsql security definer
set search_path = ''
as $$
declare
  v_uid uuid;
  v_enabled boolean;
  v_sealed bytea;
  v_archived bytea;
begin
  v_uid := public.suco_verified_uid();
  if v_uid is null then
    raise exception 'VERIFIED_EMAIL_REQUIRED' using errcode = '28000';
  end if;
  select writes_enabled into strict v_enabled
    from suco_control.private_storage_gate where singleton = true;
  if not v_enabled then
    raise exception 'PRIVATE_STORAGE_DISABLED' using errcode = '55000';
  end if;
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
revoke all on function public.suco_auth_archive(bigint,text)
  from public, anon, service_role;
grant execute on function public.suco_auth_archive(bigint,text)
  to authenticated;
