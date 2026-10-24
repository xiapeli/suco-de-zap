-- Read one opaque committed object so ambiguous commits can authenticate the
-- existing ciphertext before the durable outbox item is acknowledged.
create or replace function public.suco_message_read(p_object_id uuid)
returns table (
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
revoke all on function public.suco_message_read(uuid) from public, anon, service_role;
grant execute on function public.suco_message_read(uuid) to authenticated;
