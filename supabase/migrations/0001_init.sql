-- RentalSpy database. Paste this whole file into Supabase: SQL Editor > New query > Run.
-- Safety rules built in:
--   * You must confirm you're 18+ before posting.
--   * Rent and details are only visible to people who have shared their own (give-to-get).
--   * Anyone can see how many renters reported on a place and its average ratings.
--   * Written comments are max 200 characters, block emails/phones/links, and stay hidden until an admin approves them.
--   * Any entry reported by 3 different people is hidden automatically until an admin looks at it.
--   * Max 5 new entries per person per day (anti-spam).
--   * People can delete their own entries and their whole account.

create extension if not exists pgcrypto;

-- ------------------------------------------------------------------ tables
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  is_admin boolean not null default false,
  confirmed_18 boolean not null default false,
  created_at timestamptz not null default now()
);

create table if not exists public.entries (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  address_id text not null check (address_id ~ '^GA[A-Z]{2}_[0-9]{3,12}$'),
  address_label text not null check (char_length(address_label) between 3 and 120),
  street_slug text not null check (street_slug ~ '^[a-z0-9-]{1,80}$'),
  suburb_slug text not null check (suburb_slug ~ '^[a-z0-9-]{1,60}$'),
  dwelling text not null check (dwelling in ('house', 'unit', 'room')),
  bedrooms smallint check (bedrooms between 1 and 8),
  share_house boolean not null default false,
  rent_week integer not null check (rent_week between 50 and 3000),
  lease_year smallint not null check (lease_year between 2000 and 2100),
  still_living boolean not null default true,
  rating_condition smallint not null check (rating_condition between 1 and 5),
  rating_landlord smallint not null check (rating_landlord between 1 and 5),
  rating_noise smallint not null check (rating_noise between 1 and 5),       -- 5 = quiet
  rating_clean smallint check (rating_clean between 1 and 5),                -- share houses only
  mould boolean not null default false,
  heating_cooling_ok boolean not null default true,
  repairs_quick boolean,
  bond_returned boolean,                                                     -- null = still living there / not sure
  pets_allowed boolean,
  hidden boolean not null default false,
  report_count integer not null default 0,
  created_at timestamptz not null default now(),
  unique (user_id, address_id)
);
create index if not exists entries_street on public.entries (suburb_slug, street_slug) where not hidden;
create index if not exists entries_address on public.entries (address_id) where not hidden;

create table if not exists public.comments (
  entry_id uuid primary key references public.entries(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  body text not null check (char_length(body) between 3 and 200),
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  created_at timestamptz not null default now(),
  reviewed_at timestamptz
);

create table if not exists public.reports (
  id uuid primary key default gen_random_uuid(),
  entry_id uuid not null references public.entries(id) on delete cascade,
  reporter_id uuid not null references auth.users(id) on delete cascade,
  reason text not null check (char_length(reason) between 2 and 300),
  resolved boolean not null default false,
  created_at timestamptz not null default now(),
  unique (entry_id, reporter_id)
);

-- ------------------------------------------------------------------ helpers
create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select is_admin from public.profiles where id = auth.uid()), false);
$$;

create or replace function public.has_contributed() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.entries where user_id = auth.uid() and not hidden);
$$;

-- new user (email or anonymous) gets a profile row
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id) values (new.id) on conflict do nothing;
  return new;
end $$;
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- entries: owner and safety fields are set by the server, never trusted from the browser
create or replace function public.entries_before_insert() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'Please sign in first.'; end if;
  if not coalesce((select confirmed_18 from public.profiles where id = auth.uid()), false) then
    raise exception 'You need to confirm you are 18 or older.';
  end if;
  if (select count(*) from public.entries where user_id = auth.uid() and created_at > now() - interval '1 day') >= 5 then
    raise exception 'You can add up to 5 places a day. Please try again tomorrow.';
  end if;
  new.user_id := auth.uid();
  new.hidden := false;
  new.report_count := 0;
  new.created_at := now();
  if new.dwelling = 'room' then new.share_house := true; end if;
  if not new.share_house then new.rating_clean := null; end if;
  if new.lease_year > extract(year from now())::int + 1 then
    raise exception 'Lease year looks wrong.';
  end if;
  return new;
end $$;
drop trigger if exists entries_bi on public.entries;
create trigger entries_bi before insert on public.entries
  for each row execute function public.entries_before_insert();

-- comments: always start pending; no emails, phone numbers or links
create or replace function public.comments_before_insert() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from public.entries where id = new.entry_id and user_id = auth.uid()) then
    raise exception 'You can only comment on your own entry.';
  end if;
  new.body := btrim(regexp_replace(new.body, '\s+', ' ', 'g'));
  if new.body ~* '[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}' then
    raise exception 'Please remove email addresses from your comment.';
  end if;
  if new.body ~ '(\d[\s().-]*){8,}' then
    raise exception 'Please remove phone numbers from your comment.';
  end if;
  if new.body ~* '(https?://|www\.|\.com|\.au\b)' then
    raise exception 'Please remove links from your comment.';
  end if;
  new.user_id := auth.uid();
  new.status := 'pending';
  new.created_at := now();
  new.reviewed_at := null;
  return new;
end $$;
drop trigger if exists comments_bi on public.comments;
create trigger comments_bi before insert on public.comments
  for each row execute function public.comments_before_insert();

-- ------------------------------------------------------------------ row level security
alter table public.profiles enable row level security;
alter table public.entries enable row level security;
alter table public.comments enable row level security;
alter table public.reports enable row level security;

drop policy if exists profiles_own on public.profiles;
create policy profiles_own on public.profiles for select to authenticated using (id = auth.uid());

drop policy if exists entries_read on public.entries;
create policy entries_read on public.entries for select to authenticated
  using (user_id = auth.uid() or (not hidden and public.has_contributed()));
drop policy if exists entries_insert on public.entries;
create policy entries_insert on public.entries for insert to authenticated with check (user_id = auth.uid());
drop policy if exists entries_delete on public.entries;
create policy entries_delete on public.entries for delete to authenticated using (user_id = auth.uid());

drop policy if exists comments_read on public.comments;
create policy comments_read on public.comments for select to authenticated
  using (user_id = auth.uid() or (status = 'approved' and public.has_contributed()
         and exists (select 1 from public.entries e where e.id = entry_id and not e.hidden)));
drop policy if exists comments_insert on public.comments;
create policy comments_insert on public.comments for insert to authenticated with check (user_id = auth.uid());
drop policy if exists comments_delete on public.comments;
create policy comments_delete on public.comments for delete to authenticated using (user_id = auth.uid());

-- no direct access to reports; use report_entry()

-- Supabase grants everything to anon/authenticated by default; take it back and grant only what's needed.
revoke all on public.profiles, public.entries, public.comments, public.reports from anon, authenticated;
grant select on public.profiles to authenticated;
grant select, insert, delete on public.entries to authenticated;
grant select, insert, delete on public.comments to authenticated;

-- ------------------------------------------------------------------ functions the website calls
create or replace function public.confirm_adult() returns void
language sql security definer set search_path = public as $$
  update public.profiles set confirmed_18 = true where id = auth.uid();
$$;

create or replace function public.my_status() returns json
language sql stable security definer set search_path = public as $$
  select json_build_object(
    'signed_in', auth.uid() is not null,
    'confirmed_18', coalesce((select confirmed_18 from public.profiles where id = auth.uid()), false),
    'is_admin', public.is_admin(),
    'unlocked', public.has_contributed(),
    'entries', (select count(*) from public.entries where user_id = auth.uid()));
$$;

-- teaser numbers anyone can see (no rent amounts)
create or replace function public.place_stats(p_suburb text, p_street text default null)
returns table (address_id text, address_label text, street_slug text, reports bigint,
               avg_condition numeric, avg_landlord numeric, avg_noise numeric, mould_pct integer)
language sql stable security definer set search_path = public as $$
  select e.address_id, min(e.address_label), min(e.street_slug), count(*),
         round(avg(e.rating_condition), 1), round(avg(e.rating_landlord), 1), round(avg(e.rating_noise), 1),
         round(100.0 * avg(case when e.mould then 1 else 0 end))::int
  from public.entries e
  where not e.hidden and e.suburb_slug = p_suburb and (p_street is null or e.street_slug = p_street)
  group by e.address_id
  order by count(*) desc
  limit 500;
$$;

create or replace function public.site_stats() returns json
language sql stable security definer set search_path = public as $$
  select json_build_object(
    'entries', (select count(*) from public.entries where not hidden),
    'places', (select count(distinct address_id) from public.entries where not hidden),
    'streets', (select count(distinct (suburb_slug, street_slug)) from public.entries where not hidden));
$$;

create or replace function public.report_entry(p_entry uuid, p_reason text) returns void
language plpgsql security definer set search_path = public as $$
declare n int;
begin
  if auth.uid() is null then raise exception 'Please sign in to report.'; end if;
  if exists (select 1 from public.entries where id = p_entry and user_id = auth.uid()) then
    raise exception 'You can delete your own entry instead of reporting it.';
  end if;
  if not exists (select 1 from public.entries where id = p_entry) then raise exception 'Entry not found.'; end if;
  insert into public.reports (entry_id, reporter_id, reason)
    values (p_entry, auth.uid(), left(coalesce(nullif(btrim(p_reason), ''), 'No reason given'), 300))
    on conflict (entry_id, reporter_id) do nothing;
  if found then
    update public.entries set report_count = report_count + 1,
      hidden = hidden or report_count + 1 >= 3
      where id = p_entry;
  end if;
end $$;

create or replace function public.delete_my_account() returns void
language plpgsql security definer set search_path = public, auth as $$
begin
  if auth.uid() is null then raise exception 'Not signed in.'; end if;
  delete from auth.users where id = auth.uid();  -- cascades to profiles, entries, comments, reports
end $$;

-- ------------------------------------------------------------------ admin functions
create or replace function public.admin_queue() returns json
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'Admins only.'; end if;
  return json_build_object(
    'comments', coalesce((select json_agg(x order by x.created_at) from (
        select c.entry_id, c.body, c.created_at, e.address_label, e.hidden
        from public.comments c join public.entries e on e.id = c.entry_id
        where c.status = 'pending') x), '[]'::json),
    'reported', coalesce((select json_agg(x order by x.report_count desc) from (
        select e.id, e.address_label, e.hidden, e.report_count, e.rent_week, e.dwelling,
               (select body from public.comments where entry_id = e.id) as comment,
               (select json_agg(r.reason) from public.reports r where r.entry_id = e.id and not r.resolved) as reasons
        from public.entries e
        where exists (select 1 from public.reports r where r.entry_id = e.id and not r.resolved)) x), '[]'::json),
    'totals', json_build_object(
        'entries', (select count(*) from public.entries),
        'hidden', (select count(*) from public.entries where hidden),
        'people', (select count(distinct user_id) from public.entries)));
end $$;

create or replace function public.admin_review_comment(p_entry uuid, p_status text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'Admins only.'; end if;
  if p_status not in ('approved', 'rejected') then raise exception 'Bad status.'; end if;
  update public.comments set status = p_status, reviewed_at = now() where entry_id = p_entry;
end $$;

-- keep = show the entry again and close its reports; remove = delete it for good
create or replace function public.admin_resolve(p_entry uuid, p_action text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'Admins only.'; end if;
  if p_action = 'keep' then
    update public.entries set hidden = false, report_count = 0 where id = p_entry;
    update public.reports set resolved = true where entry_id = p_entry;
  elsif p_action = 'remove' then
    delete from public.entries where id = p_entry;
  else
    raise exception 'Bad action.';
  end if;
end $$;

-- who may call what
revoke all on function public.is_admin(), public.has_contributed(), public.handle_new_user(),
  public.entries_before_insert(), public.comments_before_insert() from public, anon, authenticated;
revoke all on function public.confirm_adult(), public.my_status(), public.report_entry(uuid, text),
  public.delete_my_account(), public.admin_queue(), public.admin_review_comment(uuid, text),
  public.admin_resolve(uuid, text), public.place_stats(text, text), public.site_stats() from public;
grant execute on function public.place_stats(text, text), public.site_stats() to anon, authenticated;
grant execute on function public.confirm_adult(), public.my_status(), public.report_entry(uuid, text),
  public.delete_my_account(), public.admin_queue(), public.admin_review_comment(uuid, text),
  public.admin_resolve(uuid, text) to authenticated;
-- has_contributed() and is_admin() are used inside policies, which run as the calling role
grant execute on function public.has_contributed(), public.is_admin() to authenticated;

-- numbers only (no content), so a daily GitHub check can tell you when something needs moderating
create or replace function public.moderation_pending() returns json
language sql stable security definer set search_path = public as $$
  select json_build_object(
    'tips', (select count(*) from public.comments where status = 'pending'),
    'reported', (select count(distinct entry_id) from public.reports where not resolved));
$$;
revoke all on function public.moderation_pending() from public;
grant execute on function public.moderation_pending() to anon, authenticated;
