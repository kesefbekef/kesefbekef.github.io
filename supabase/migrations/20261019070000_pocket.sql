-- 🧒 קופת דמי כיס (kv 'pocket'): גם ילדים רואים (את הקופה שלהם), רק הורים משנים
drop policy if exists "kv select" on kv;
create policy "kv select" on kv for select
  using (is_parent(household_id) or (is_member(household_id) and key in ('people', 'learned', 'cats', 'pocket')));
