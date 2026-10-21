-- 📆 מנוי ליומן של זמן בכיף: מפתח סודי אישי לכל משתמש (היומן נקרא בלי התחברות, רק עם המפתח)
-- נפרד מ-kesef_cal_tokens, כך שכל אפליקציה מחליפה מפתח בלי לגעת בשנייה
create table if not exists zman_cal_tokens (
  user_id uuid primary key references auth.users(id) on delete cascade,
  token text not null unique check (length(token) >= 32),
  created_at timestamptz not null default now()
);
alter table zman_cal_tokens enable row level security;
drop policy if exists "zman cal own" on zman_cal_tokens;
create policy "zman cal own" on zman_cal_tokens for all
  using (user_id = auth.uid()) with check (user_id = auth.uid());
