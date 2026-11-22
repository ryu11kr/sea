-- 물때첩 — Supabase SQL Editor 에서 한 번 실행
-- 포인트 목록 JSON + 로그인한 본인만 접근

create table if not exists public.sea_user_data (
  user_id uuid primary key references auth.users (id) on delete cascade,
  points jsonb not null default '[]'::jsonb,
  schema_version smallint not null default 1,
  updated_at timestamptz not null default now()
);

alter table public.sea_user_data enable row level security;

drop policy if exists "sea_user_data_select_own" on public.sea_user_data;
create policy "sea_user_data_select_own"
  on public.sea_user_data for select
  to authenticated
  using (auth.uid() = user_id);

drop policy if exists "sea_user_data_insert_own" on public.sea_user_data;
create policy "sea_user_data_insert_own"
  on public.sea_user_data for insert
  to authenticated
  with check (auth.uid() = user_id);

drop policy if exists "sea_user_data_update_own" on public.sea_user_data;
create policy "sea_user_data_update_own"
  on public.sea_user_data for update
  to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);