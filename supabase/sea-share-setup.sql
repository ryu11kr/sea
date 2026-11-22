-- 물때첩 포인트 공유 — sea-cloud-setup.sql 실행 후 SQL Editor에서 Run

create table if not exists public.sea_share_requests (
  id uuid primary key default gen_random_uuid(),
  from_user_id uuid not null references auth.users (id) on delete cascade,
  from_email text not null,
  to_email text not null,
  status text not null default 'pending'
    check (status in ('pending', 'accepted', 'rejected', 'cancelled')),
  created_at timestamptz not null default now(),
  responded_at timestamptz
);

create index if not exists sea_share_requests_to_email_pending_idx
  on public.sea_share_requests (lower(to_email))
  where status = 'pending';

alter table public.sea_share_requests enable row level security;

drop policy if exists "sea_share_select_involved" on public.sea_share_requests;
create policy "sea_share_select_involved"
  on public.sea_share_requests for select
  to authenticated
  using (
    from_user_id = auth.uid()
    or lower(to_email) = lower(coalesce(auth.jwt() ->> 'email', ''))
  );

drop policy if exists "sea_share_insert_sender" on public.sea_share_requests;
create policy "sea_share_insert_sender"
  on public.sea_share_requests for insert
  to authenticated
  with check (
    from_user_id = auth.uid()
    and lower(to_email) <> lower(coalesce(auth.jwt() ->> 'email', ''))
  );

drop policy if exists "sea_share_update_recipient_reject" on public.sea_share_requests;
create policy "sea_share_update_recipient_reject"
  on public.sea_share_requests for update
  to authenticated
  using (
    lower(to_email) = lower(coalesce(auth.jwt() ->> 'email', ''))
    and status = 'pending'
  )
  with check (status = 'rejected');

drop policy if exists "sea_share_update_sender_cancel" on public.sea_share_requests;
create policy "sea_share_update_sender_cancel"
  on public.sea_share_requests for update
  to authenticated
  using (from_user_id = auth.uid() and status = 'pending')
  with check (status = 'cancelled');