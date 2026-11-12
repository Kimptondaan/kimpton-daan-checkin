-- Apply after 001_initial_schema.sql. No employee, department or attendance data is deleted.
-- Netlify server functions authenticate the Supabase user and enforce actor/scoping rules.
-- The browser may read permitted rows but may not forge a timestamp, role or activation state.
begin;

revoke insert, update, delete, truncate, references, trigger
  on public.departments, public.profiles, public.allowed_networks, public.attendance_records
  from public, anon, authenticated;
grant select on public.departments, public.profiles, public.attendance_records to authenticated;
revoke select on public.allowed_networks from public, anon, authenticated;

create or replace function public.current_user_role()
returns public.user_role
language sql stable security definer set search_path = public
as $$ select role from public.profiles where id = auth.uid() and is_active = true $$;

create or replace function public.current_department_id()
returns uuid
language sql stable security definer set search_path = public
as $$ select department_id from public.profiles where id = auth.uid() and is_active = true $$;

drop policy if exists "Users can create their own attendance" on public.attendance_records;

commit;
