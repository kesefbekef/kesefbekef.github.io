-- משובים מהמשתמשים (גיבוי לכל מה שנשלח במייל). אפשר רק להוסיף, אף אחד לא יכול לקרוא מהאפליקציה
create table if not exists feedback (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  user_id uuid references auth.users(id) on delete set null default auth.uid(),
  household_id uuid references households(id) on delete set null,
  app text not null default 'kesef-bekef',
  kind text,
  message text not null check (length(message) between 1 and 5000),
  contact text,
  device text
);
alter table feedback enable row level security;
drop policy if exists "users send feedback" on feedback;
create policy "users send feedback" on feedback for insert to authenticated with check (user_id = auth.uid());
