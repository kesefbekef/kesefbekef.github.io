-- 📆 מנוי ליומן: מפתח סודי אישי לכל משתמש (היומן נקרא בלי התחברות, רק עם המפתח)
create table if not exists kesef_cal_tokens (
  user_id uuid primary key references auth.users(id) on delete cascade,
  household_id uuid not null references households(id) on delete cascade,
  token text not null unique check (length(token) >= 32),
  created_at timestamptz not null default now()
);
alter table kesef_cal_tokens enable row level security;
drop policy if exists "kesef cal own" on kesef_cal_tokens;
create policy "kesef cal own" on kesef_cal_tokens for all
  using (user_id = auth.uid()) with check (user_id = auth.uid() and is_parent(household_id));
