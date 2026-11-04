create extension if not exists pgcrypto;

create type public.user_role as enum ('employee', 'admin');
create type public.attendance_type as enum ('check_in', 'check_out');

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  employee_no text unique not null,
  full_name text not null,
  department text not null default '',
  job_title text not null default '',
  role public.user_role not null default 'employee',
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.allowed_networks (
  id bigint generated always as identity primary key,
  name text not null,
  network cidr not null,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.attendance_records (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null references public.profiles(id),
  attendance_type public.attendance_type not null,
  punched_at timestamptz not null default now(),
  client_ip inet not null,
  matched_network_id bigint references public.allowed_networks(id),
  user_agent text,
  status text not null default 'accepted' check (status in ('accepted', 'rejected', 'manual')),
  note text,
  created_at timestamptz not null default now()
);

create unique index one_accepted_punch_per_type_per_day
on public.attendance_records (
  employee_id,
  ((punched_at at time zone 'Asia/Taipei')::date),
  attendance_type
)
where status = 'accepted';

create index attendance_records_punched_at_idx on public.attendance_records (punched_at desc);
create index attendance_records_employee_id_idx on public.attendance_records (employee_id, punched_at desc);

alter table public.profiles enable row level security;
alter table public.allowed_networks enable row level security;
alter table public.attendance_records enable row level security;

revoke all on public.profiles from anon, authenticated;
revoke all on public.allowed_networks from anon, authenticated;
revoke all on public.attendance_records from anon, authenticated;
grant select on public.profiles to authenticated;
grant select on public.attendance_records to authenticated;

create policy "Employees can view their own profile"
on public.profiles for select to authenticated
using ((select auth.uid()) = id);

create policy "Employees can view their own attendance"
on public.attendance_records for select to authenticated
using ((select auth.uid()) = employee_id);

create or replace function public.find_network_for_ip(input_ip inet)
returns public.allowed_networks
language sql
security definer
set search_path = public
as $$
  select *
  from public.allowed_networks
  where is_active = true
    and input_ip <<= network
  order by masklen(network) desc
  limit 1;
$$;

revoke all on function public.find_network_for_ip(inet) from public, anon, authenticated;
