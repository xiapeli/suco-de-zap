-- Delete only an authenticated owner's opaque object at the revision the
-- confidential worker authenticated. The worker checks its encrypted kind.
create or replace function public.suco_cipher_delete(
  p_object_id uuid,
  p_expected_revision bigint
) returns boolean
language plpgsql security definer
set search_path = ''
as $$
declare
  v_uid uuid;
  v_enabled boolean;
  v_deleted uuid;
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
revoke all on function public.suco_cipher_delete(uuid,bigint)
  from public, anon, service_role;
grant execute on function public.suco_cipher_delete(uuid,bigint)
  to authenticated;
