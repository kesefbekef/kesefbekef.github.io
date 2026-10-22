-- 📱 עמדת בדיקה: מה מוישי כבר בדק. נשמר בשרת כדי שיעבוד מכל מחשב ומהטלפון.
-- מפתח פריט: app|v|t (אפליקציה · תאריך העדכון · כותרת השינוי)
create table if not exists bdika_reviews (
  item_key text primary key,
  app text not null,
  status text not null check (status in ('ok', 'bad')),
  note text,
  updated_at timestamptz not null default now(),
  user_id uuid default auth.uid()
);
alter table bdika_reviews enable row level security;
drop policy if exists "admin reads reviews" on bdika_reviews;
drop policy if exists "admin writes reviews" on bdika_reviews;
drop policy if exists "admin updates reviews" on bdika_reviews;
create policy "admin reads reviews" on bdika_reviews for select to authenticated using (is_app_admin());
create policy "admin writes reviews" on bdika_reviews for insert to authenticated with check (is_app_admin());
create policy "admin updates reviews" on bdika_reviews for update to authenticated using (is_app_admin()) with check (is_app_admin());

-- לאפליקציות עצמן: אילו פריטים המנהל כבר אישר (כדי לא להציג לו אותם שוב ב"מה חדש" / בסיור)
create or replace function bdika_approved(p_app text) returns setof text
language sql security definer stable set search_path = public as $$
  select item_key from bdika_reviews where app = p_app and status = 'ok' and is_app_admin();
$$;
grant execute on function bdika_approved(text) to authenticated;
