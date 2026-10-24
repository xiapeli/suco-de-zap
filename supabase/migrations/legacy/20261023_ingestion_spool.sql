-- Encrypted, per-user WhatsApp ingestion outbox. Object IDs are keyed opaque
-- UUIDs, never JIDs or message IDs. The worker encrypts before every RPC.
-- Existing private_storage_gate remains OFF until attested runtime release.
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
alter table public.suco_ingestion_spool enable row level security;
alter table public.suco_ingestion_spool force row level security;
revoke all on public.suco_ingestion_spool from public, anon, authenticated, service_role;

-- INSERT is create-only: a retransmission cannot replace an unacknowledged
-- message. A lost HTTP response returns the same revision on retry.
create or replace function public.suco_ingestion_stage(
  p_object_id uuid,
  p_key_epoch integer,
  p_nonce_hex text,
  p_ciphertext_hex text
) returns bigint
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
revoke all on function public.suco_ingestion_stage(uuid,integer,text,text)
  from public, anon, service_role;
grant execute on function public.suco_ingestion_stage(uuid,integer,text,text)
  to authenticated;

create or replace function public.suco_ingestion_list(
  p_after uuid default null,
  p_limit integer default 100
) returns table (
  object_id uuid,
  key_epoch integer,
  nonce_hex text,
  ciphertext_hex text,
  revision bigint
)
language plpgsql security definer
set search_path = ''
as $$
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
revoke all on function public.suco_ingestion_list(uuid,integer)
  from public, anon, service_role;
grant execute on function public.suco_ingestion_list(uuid,integer)
  to authenticated;

-- Revision guard stops a stale worker from deleting a future record with the
-- same opaque ID. A second ack after a successful deletion is harmless.
create or replace function public.suco_ingestion_ack(
  p_object_id uuid,
  p_expected_revision bigint
) returns boolean
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
revoke all on function public.suco_ingestion_ack(uuid,bigint)
  from public, anon, service_role;
grant execute on function public.suco_ingestion_ack(uuid,bigint)
  to authenticated;
