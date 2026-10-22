-- 🔔 התראה למנהל (טלפון + מייל) על כל תקלה חדשה בשלוש האפליקציות, ועוד אחת כשהיא מסומנת "✅ תוקן".
-- הטריגר רק "מצלצל" לפונקציה error-alert עם מספר התקלה; הפונקציה קוראת את השורה בעצמה (עם הרשאת השרת),
-- ושולחת פעם אחת בלבד (alerted_at / fix_alerted_at). אותה תקלה שחוזרת — התראה אחת בשעה, עם ×N.

alter table app_errors add column if not exists alerted_at timestamptz;
alter table app_errors add column if not exists fix_alerted_at timestamptz;
alter table app_errors add column if not exists alert_sent boolean not null default false; -- נשלחה בפועל (לא נחסמה בגלל "פעם בשעה")
-- תקלות ישנות — לא שולחים עליהן עכשיו
update app_errors set alerted_at = coalesce(alerted_at, now()), fix_alerted_at = case when fixed_at is not null then coalesce(fix_alerted_at, now()) end where alerted_at is null;

-- מכשירים של המנהל שביקשו התראות על תקלות (כפתור בלוח הבקרה)
create table if not exists admin_push_subs (
  endpoint text primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  sub jsonb not null,
  updated_at timestamptz not null default now()
);
alter table admin_push_subs enable row level security;
drop policy if exists "admin subs own" on admin_push_subs;
create policy "admin subs own" on admin_push_subs for all
  using (user_id = auth.uid() and is_app_admin()) with check (user_id = auth.uid() and is_app_admin());

create or replace function app_errors_alert() returns trigger
language plpgsql security definer set search_path = public, net as $$
declare kind text;
begin
  if tg_op = 'INSERT' then kind := 'new';
  elsif new.fixed_at is not null and old.fixed_at is null then kind := 'fixed';
  else return new; end if;
  perform net.http_post(
    url := 'https://dmhxovlepdoobkoiyjhj.supabase.co/functions/v1/error-alert',
    body := jsonb_build_object('id', new.id, 'kind', kind),
    headers := '{"Content-Type": "application/json"}'::jsonb);
  return new;
exception when others then return new; -- התראה שנכשלה לא מפילה את רישום התקלה
end $$;

drop trigger if exists app_errors_alert_ins on app_errors;
create trigger app_errors_alert_ins after insert on app_errors for each row execute function app_errors_alert();
drop trigger if exists app_errors_alert_fix on app_errors;
create trigger app_errors_alert_fix after update of fixed_at on app_errors for each row execute function app_errors_alert();
