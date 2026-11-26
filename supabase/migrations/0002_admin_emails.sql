-- Admin by email: anyone whose email is listed in admin_emails becomes an admin when their account is
-- created (or when they confirm that email). Add yourself once in SQL Editor:
--   insert into public.admin_emails (email) values ('you@example.com');
create table if not exists public.admin_emails (email text primary key);
alter table public.admin_emails enable row level security;
revoke all on public.admin_emails from anon, authenticated;

create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, is_admin)
    values (new.id, exists (select 1 from public.admin_emails a where lower(a.email) = lower(new.email)))
    on conflict (id) do update set is_admin = public.profiles.is_admin or excluded.is_admin;
  return new;
end $$;

drop trigger if exists on_auth_user_email on auth.users;
create trigger on_auth_user_email after update of email on auth.users
  for each row when (new.email is distinct from old.email)
  execute function public.handle_new_user();
revoke all on function public.handle_new_user() from public, anon, authenticated;
