-- One-time handoff of the existing owner's WhatsApp identity lock. It contains
-- no messages or Signal credentials. Only the verified owner can fetch it;
-- the measured worker separately pins the exact verifier fingerprint.
create table if not exists suco_control.owner_identity_handoff (
  user_id uuid primary key references auth.users(id) on delete cascade,
  bundle jsonb not null,
  fingerprint text not null check (fingerprint ~ '^[a-f0-9]{64}$'),
  created_at timestamptz not null default now()
);
alter table suco_control.owner_identity_handoff enable row level security;
alter table suco_control.owner_identity_handoff force row level security;
revoke all on suco_control.owner_identity_handoff from public, anon, authenticated, service_role;

create or replace function public.suco_owner_identity_handoff()
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid;
  v_status jsonb;
  v_bundle jsonb;
begin
  v_uid := public.suco_verified_uid();
  if v_uid is null then
    raise exception 'VERIFIED_EMAIL_REQUIRED' using errcode = '28000';
  end if;
  v_status := public.suco_account_status();
  if v_status->>'accountId' is distinct from v_uid::text or
     v_status->>'entitlement' is distinct from 'owner' or
     v_status->>'legacyLinked' is distinct from 'true' then
    raise exception 'OWNER_IDENTITY_DENIED' using errcode = '42501';
  end if;
  select h.bundle into v_bundle from suco_control.owner_identity_handoff as h
   where h.user_id = v_uid;
  if v_bundle is null then
    raise exception 'OWNER_IDENTITY_PENDING' using errcode = '55000';
  end if;
  return v_bundle;
end;
$$;
revoke all on function public.suco_owner_identity_handoff() from public, anon, service_role;
grant execute on function public.suco_owner_identity_handoff() to authenticated;
