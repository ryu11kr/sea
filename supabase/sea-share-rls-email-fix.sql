-- 물때첩: JWT에 email이 비는 기기(삼성 브라우저 등) — auth.email() 보강
-- sea-share-setup.sql 실행 뒤에도 수신이 안 되면 이 파일만 SQL Editor에서 Run

drop policy if exists "sea_share_select_involved" on public.sea_share_requests;
create policy "sea_share_select_involved"
  on public.sea_share_requests for select
  to authenticated
  using (
    from_user_id = auth.uid()
    or lower(to_email) = lower(coalesce(auth.jwt() ->> 'email', ''))
    or lower(to_email) = lower(coalesce(auth.email(), ''))
  );

drop policy if exists "sea_share_insert_sender" on public.sea_share_requests;
create policy "sea_share_insert_sender"
  on public.sea_share_requests for insert
  to authenticated
  with check (
    from_user_id = auth.uid()
    and lower(to_email) <> lower(coalesce(auth.jwt() ->> 'email', ''))
    and lower(to_email) <> lower(coalesce(auth.email(), ''))
  );

drop policy if exists "sea_share_update_recipient_reject" on public.sea_share_requests;
create policy "sea_share_update_recipient_reject"
  on public.sea_share_requests for update
  to authenticated
  using (
    (
      lower(to_email) = lower(coalesce(auth.jwt() ->> 'email', ''))
      or lower(to_email) = lower(coalesce(auth.email(), ''))
    )
    and status = 'pending'
  )
  with check (status = 'rejected');

drop policy if exists "sea_share_update_recipient_accept" on public.sea_share_requests;
create policy "sea_share_update_recipient_accept"
  on public.sea_share_requests for update
  to authenticated
  using (
    (
      lower(to_email) = lower(coalesce(auth.jwt() ->> 'email', ''))
      or lower(to_email) = lower(coalesce(auth.email(), ''))
    )
    and status = 'pending'
  )
  with check (status = 'accepted');