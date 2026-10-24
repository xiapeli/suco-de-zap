-- Contact names, group subjects and LID mappings are encrypted in the
-- attested worker. Supabase sees opaque object IDs and ciphertext only.
create table if not exists public.suco_private_metadata (
  owner_id uuid not null references auth.users(id) on delete cascade,
  object_id uuid not null,
  key_epoch integer not null check (key_epoch between 1 and 1000000000),
  nonce bytea not null check (octet_length(nonce) = 12),
  ciphertext bytea not null check (octet_length(ciphertext) between 32 and 4194304),
  revision bigint not null default 1 check (revision > 0),
  updated_at timestamptz not null default now(),
  primary key (owner_id, object_id),
  unique (owner_id, key_epoch, nonce)
);
alter table public.suco_private_metadata enable row level security;
alter table public.suco_private_metadata force row level security;
revoke all on public.suco_private_metadata from public, anon, authenticated, service_role;
drop policy if exists suco_private_metadata_own on public.suco_private_metadata;
create policy suco_private_metadata_own on public.suco_private_metadata
  for all to authenticated
  using (owner_id = (select public.suco_verified_uid()))
  with check (owner_id = (select public.suco_verified_uid()));

create or replace function public.suco_meta_list(
  p_after uuid default null,
  p_limit integer default 100
) returns table (
  object_id uuid,
  key_epoch integer,
  nonce_hex text,
  ciphertext_hex text,
  revision text
)
language plpgsql security definer
set search_path = ''
as $$
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
revoke all on function public.suco_meta_list(uuid,integer)
  from public, anon, service_role;
grant execute on function public.suco_meta_list(uuid,integer)
  to authenticated;

create or replace function public.suco_meta_put(
  p_object_id uuid,
  p_expected_revision bigint,
  p_key_epoch integer,
  p_nonce_hex text,
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
revoke all on function public.suco_meta_put(uuid,bigint,integer,text,text)
  from public, anon, service_role;
grant execute on function public.suco_meta_put(uuid,bigint,integer,text,text)
  to authenticated;
