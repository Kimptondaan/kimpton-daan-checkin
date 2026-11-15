-- 005_staff_announcement.sql
-- Apply after 001-004. Adds only a shared internal announcement.
-- Does not change employees, passwords, departments, attendance or IP settings.
begin;

create or replace function public.valid_staff_announcement(p_format text, p_items jsonb)
returns boolean
language plpgsql immutable
set search_path = public, pg_temp
as $$
declare
  item jsonb;
  content text;
  character_count integer := 0;
begin
  if p_format is null or p_format not in ('text', 'bullets')
    or p_items is null or jsonb_typeof(p_items) <> 'array' then
    return false;
  end if;
  if (p_format = 'text' and jsonb_array_length(p_items) > 1)
    or (p_format = 'bullets' and jsonb_array_length(p_items) > 5) then
    return false;
  end if;
  for item in select value from jsonb_array_elements(p_items) loop
    if jsonb_typeof(item) <> 'string' then return false; end if;
    content := item #>> '{}';
    if nullif(btrim(content), '') is null or octet_length(content) > 4000
      or position(E'\r' in content) > 0 then return false; end if;
    if p_format = 'bullets' and position(E'\n' in content) > 0 then
      return false;
    end if;
    character_count := character_count + char_length(replace(content, E'\n', ''));
    if character_count > 200 then return false; end if;
  end loop;
  return true;
end;
$$;

create table if not exists public.staff_announcement (
  id integer primary key check (id = 1),
  format text not null default 'text',
  items jsonb not null default '[]'::jsonb,
  version integer not null default 0 check (version >= 0),
  updated_at timestamptz,
  updated_by uuid references public.profiles(id) on delete set null,
  constraint staff_announcement_content_valid
    check (public.valid_staff_announcement(format, items))
);

insert into public.staff_announcement (id) values (1)
on conflict (id) do nothing;

alter table public.staff_announcement enable row level security;
revoke all on public.staff_announcement from public, anon, authenticated;
grant select on public.staff_announcement to authenticated;
grant all on public.staff_announcement to service_role;

drop policy if exists "Active staff can read announcement" on public.staff_announcement;
create policy "Active staff can read announcement" on public.staff_announcement
for select to authenticated using (public.current_user_role() is not null);

create or replace function public.management_save_announcement(
  p_actor_uuid uuid,
  p_format text,
  p_items jsonb,
  p_expected_version integer
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  actor public.profiles;
  previous public.staff_announcement;
  saved public.staff_announcement;
begin
  -- Check the fresh DB role, not a role supplied by the browser or JWT metadata.
  actor := public.management_actor(
    p_actor_uuid, array['admin', 'hr', 'it']::public.user_role[]
  );
  if not public.valid_staff_announcement(p_format, p_items)
    or p_expected_version is null or p_expected_version < 0 then
    raise exception using errcode = '22023',
      message = '公告最多200字；文字模式1段、條列模式最多5條且不得空白。';
  end if;
  select * into previous from public.staff_announcement
    where id = 1 for update;
  if not found then
    raise exception using errcode = '55000', message = '公告資料尚未初始化。';
  end if;
  if previous.version <> p_expected_version then
    raise exception using errcode = '40001',
      message = '公告已被其他管理者更新；草稿仍保留，請先取消並重新開啟最新公告後再修改。';
  end if;
  update public.staff_announcement
    set format = p_format, items = p_items, version = previous.version + 1,
        updated_at = now(), updated_by = actor.id
    where id = 1 returning * into saved;
  insert into public.audit_log (actor_id, action, before_data, after_data)
    values (actor.id, 'announcement.save',
      jsonb_build_object('format', previous.format, 'items', previous.items, 'version', previous.version),
      jsonb_build_object('format', saved.format, 'items', saved.items, 'version', saved.version));
  return jsonb_build_object('ok', true, 'announcement', jsonb_build_object(
    'format', saved.format, 'items', saved.items, 'version', saved.version,
    'updatedAt', saved.updated_at, 'available', true
  ));
end;
$$;

revoke all on function public.management_save_announcement(uuid, text, jsonb, integer)
  from public, anon, authenticated;
grant execute on function public.management_save_announcement(uuid, text, jsonb, integer)
  to service_role;
revoke all on function public.valid_staff_announcement(text, jsonb)
  from public, anon, authenticated;
grant execute on function public.valid_staff_announcement(text, jsonb) to service_role;

commit;
