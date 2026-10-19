-- קטגוריות אישיות (kv key 'cats'): כל בני המשפחה רואים אותן (גם ילדים), רק הורים משנים
drop policy if exists "kv select" on kv;
create policy "kv select" on kv for select
  using (is_parent(household_id) or (is_member(household_id) and key in ('people', 'learned', 'cats')));
