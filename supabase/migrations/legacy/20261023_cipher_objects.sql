-- Opaque private objects only. No plaintext, group IDs, WhatsApp credentials,
-- user keys or calendar tokens may be stored here. Writes stay disabled until
-- a separately verified client and confidential runtime are released.
create table if not exists suco_control.private_storage_gate (
  singleton boolean primary key default true check (singleton),
  writes_enabled boolean not null default false,
  updated_at timestamptz not null default now()
);
insert into suco_control.private_storage_gate(singleton, writes_enabled)
values (true, false) on conflict (singleton) do nothing;
alter table suco_control.private_storage_gate enable row level security;
alter table suco_control.private_storage_gate force row level security;
revoke all on suco_control.private_storage_gate from public, anon, authenticated, service_role;

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
alter table public.suco_cipher_objects enable row level security;
alter table public.suco_cipher_objects force row level security;
revoke all on public.suco_cipher_objects from public, anon, authenticated, service_role;
grant select on public.suco_cipher_objects to authenticated;

create or replace function public.suco_verified_uid()
returns uuid
language sql stable security definer
set search_path = ''
as $$
  select u.id from auth.users as u
  where u.id = auth.uid()
    and u.email is not null
    and u.email_confirmed_at is not null
    and u.is_anonymous = false
$$;
revoke all on function public.suco_verified_uid() from public, anon, service_role;
grant execute on function public.suco_verified_uid() to authenticated;

drop policy if exists suco_cipher_select_own on public.suco_cipher_objects;
create policy suco_cipher_select_own on public.suco_cipher_objects
  for select to authenticated
  using (owner_id = (select public.suco_verified_uid()));

-- All writes pass a gate, verified identity and optimistic revision check.
-- The payload is already encrypted by the verified client before this RPC.
create or replace function public.suco_cipher_put(
  p_object_id uuid,
  p_expected_revision bigint,
  p_key_epoch integer,
  p_nonce bytea,
  p_ciphertext bytea
)
returns bigint
language plpgsql security definer
set search_path = ''
as $$
declare
  v_uid uuid;
  v_enabled boolean;
  v_revision bigint;
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
revoke all on function public.suco_cipher_put(uuid,bigint,integer,bytea,bytea)
  from public, anon, service_role;
grant execute on function public.suco_cipher_put(uuid,bigint,integer,bytea,bytea)
  to authenticated;
