-- הגבלת קצב להערות מדוח שנכנסות בלי התחברות: עד 10 בדקה בכל השרת.
-- לא נוגע במשתמשים מחוברים ולא בסוגי הערות אחרים. המדיניות "report notes anon" נשארת כמו שהיא.
-- אישר מוישי 5.11.2026.
create or replace function feedback_report_notes_rate()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.kind = 'הערה מדוח' and new.user_id is null then
    if (select count(*) from feedback
        where kind = 'הערה מדוח' and user_id is null and created_at > now() - interval '1 minute') >= 10 then
      raise exception 'יותר מדי הערות בדקה, לנסות שוב בעוד רגע' using errcode = 'P0001';
    end if;
  end if;
  return new;
end $$;
revoke all on function feedback_report_notes_rate() from public;
drop trigger if exists feedback_report_notes_rate on feedback;
create trigger feedback_report_notes_rate before insert on feedback
  for each row execute function feedback_report_notes_rate();
