-- סיכום חודשי למייל: כל הורה יכול לכבות/להדליק לעצמו
alter table members add column if not exists monthly_email boolean not null default true;

create or replace function set_monthly_email(on_ boolean)
returns void
language sql security definer set search_path = public as $$
  update members set monthly_email = on_ where user_id = auth.uid();
$$;

create or replace function my_monthly_email()
returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(bool_and(monthly_email), true) from members where user_id = auth.uid();
$$;

-- התזמון עצמו (pg_cron → פונקציית השרת) נוצר ישירות במסד, כי יש בו סוד שלא שומרים בקוד הציבורי
create extension if not exists pg_cron;
create extension if not exists pg_net;
