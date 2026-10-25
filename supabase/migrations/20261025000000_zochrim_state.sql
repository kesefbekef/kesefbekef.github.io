-- זוכרים בכיף (memory-app): המצב של כל משתמש בשורה אחת — הגן, הרצף, הזרעים והכרטיסים.
-- כל משתמש רואה וכותב רק את השורה שלו.
create table if not exists zochrim_state (
  user_id uuid primary key references auth.users(id) on delete cascade default auth.uid(),
  data jsonb not null default '{}'::jsonb check (pg_column_size(data) < 2000000),
  updated_at timestamptz not null default now()
);
alter table zochrim_state enable row level security;
drop policy if exists "own zochrim row" on zochrim_state;
create policy "own zochrim row" on zochrim_state
  for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
