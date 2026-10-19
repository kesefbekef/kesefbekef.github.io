-- 🔔 התראה לטלפון כשקטגוריה מגיעה ל-90% / 100% מהתקציב
create table if not exists kesef_push_subs (
  endpoint text primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  household_id uuid references households(id) on delete cascade,
  sub jsonb not null,
  updated_at timestamptz not null default now()
);
alter table kesef_push_subs enable row level security;
drop policy if exists "kesef subs own" on kesef_push_subs;
create policy "kesef subs own" on kesef_push_subs for all using (user_id = auth.uid()) with check (user_id = auth.uid());

-- כל התראה נשלחת פעם אחת בחודש לכל קטגוריה ורמה (גם אם כמה טלפונים מדווחים ביחד). נכתב רק מהשרת.
create table if not exists kesef_alerts (
  household_id uuid not null references households(id) on delete cascade,
  cat text not null,
  month text not null,
  level int not null,
  title text, body text,
  created_at timestamptz not null default now(),
  sent_at timestamptz,
  primary key (household_id, cat, month, level)
);
alter table kesef_alerts enable row level security; -- בלי מדיניות: רק השרת (service role)
