-- Immutable committed messages. All identifiers are keyed opaque UUIDs and
-- payloads are encrypted inside the attested worker before this RPC.
-- No JID, message ID, body, sender, search index or user key is stored here.
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
alter table public.suco_private_messages enable row level security;
alter table public.suco_private_messages force row level security;
revoke all on public.suco_private_messages from public, anon, authenticated, service_role;

-- Create-only. If the reply is lost, replay returns revision 1 and preserves
-- the first committed ciphertext. The caller authenticates it on read.
create or replace function public.suco_message_commit(
  p_object_id uuid,
  p_key_epoch integer,
  p_nonce_hex text,
  p_ciphertext_hex text
) returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  v_uid uuid;
  v_enabled boolean;
  v_revision bigint;
  v_created boolean := false;
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
revoke all on function public.suco_message_commit(uuid,integer,text,text)
  from public, anon, service_role;
grant execute on function public.suco_message_commit(uuid,integer,text,text)
  to authenticated;

-- Only opaque rows cross this boundary. The worker must decrypt, authenticate,
-- then filter by chat, period, sender or text in protected memory.
create or replace function public.suco_message_list(
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
revoke all on function public.suco_message_list(uuid,integer)
  from public, anon, service_role;
grant execute on function public.suco_message_list(uuid,integer)
  to authenticated;
