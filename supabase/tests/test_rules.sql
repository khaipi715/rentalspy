-- Tests for the safety rules. Run with supabase/tests/run.sh (needs a local Postgres).
\set ON_ERROR_STOP on
create or replace function pg_temp.as_user(u text) returns void language plpgsql as $$
begin
  if u is null then
    perform set_config('request.jwt.claims', '', false);
    execute 'set role anon';
  else
    perform set_config('request.jwt.claims', json_build_object('sub', u)::text, false);
    execute 'set role authenticated';
  end if;
end $$;
create or replace function pg_temp.expect_error(sql text, needle text) returns void language plpgsql as $$
begin
  begin
    execute sql;
  exception when others then
    if position(needle in sqlerrm) = 0 then raise exception 'Wrong error. Wanted "%" got "%"', needle, sqlerrm; end if;
    return;
  end;
  raise exception 'Expected an error containing "%" but the statement worked: %', needle, sql;
end $$;
create or replace function pg_temp.ok(cond boolean, msg text) returns void language plpgsql as $$
begin
  if not cond then raise exception 'FAILED: %', msg; end if;
  raise notice 'ok - %', msg;
end $$;

-- users: alice, bob, carol, dave, admin
insert into auth.users (id, email) values
 ('00000000-0000-0000-0000-0000000000a1', 'alice@test'),
 ('00000000-0000-0000-0000-0000000000b0', 'bob@test'),
 ('00000000-0000-0000-0000-0000000000c0', 'carol@test'),
 ('00000000-0000-0000-0000-0000000000d0', 'dave@test'),
 ('00000000-0000-0000-0000-0000000000ad', 'admin@test');
select pg_temp.ok((select count(*) from public.profiles) = 5, 'profiles created for new users');
update public.profiles set is_admin = true where id = '00000000-0000-0000-0000-0000000000ad';

create temp table e (n text, id uuid);
grant all on e to anon, authenticated;

-- 1. must confirm 18+
select pg_temp.as_user('00000000-0000-0000-0000-0000000000a1');
select pg_temp.expect_error($q$insert into public.entries (address_id,address_label,street_slug,suburb_slug,dwelling,bedrooms,rent_week,lease_year,rating_condition,rating_landlord,rating_noise)
  values ('GASA_100','1 Test Street','test-street','mawson-lakes','house',3,600,2025,4,4,4)$q$, '18 or older');
select public.confirm_adult();

-- 2. browser cannot fake owner or hidden flag
insert into public.entries (user_id,address_id,address_label,street_slug,suburb_slug,dwelling,bedrooms,rent_week,lease_year,rating_condition,rating_landlord,rating_noise,hidden,report_count,share_house,rating_clean)
  values ('00000000-0000-0000-0000-0000000000b0','GASA_100','1 Test Street','test-street','mawson-lakes','house',3,600,2025,4,3,5,true,99,false,5);
insert into e select 'alice', id from public.entries where address_id = 'GASA_100';
reset role;
select pg_temp.ok((select user_id from public.entries where address_id='GASA_100') = '00000000-0000-0000-0000-0000000000a1', 'owner forced to signed-in user');
select pg_temp.ok((select not hidden and report_count = 0 and rating_clean is null from public.entries where address_id='GASA_100'), 'hidden/report_count/clean rating cannot be faked');

-- 3. anon sees no tables, but sees teaser stats
select pg_temp.as_user(null);
select pg_temp.expect_error('select * from public.entries', 'permission denied');
select pg_temp.ok((select reports from public.place_stats('mawson-lakes') where address_id='GASA_100') = 1, 'anon sees teaser count');
select pg_temp.ok((select (public.site_stats()->>'entries')::int) = 1, 'site stats work for anon');
select pg_temp.expect_error('select public.admin_queue()', 'permission denied');
reset role;

-- 4. give-to-get: bob sees nothing until he contributes
select pg_temp.as_user('00000000-0000-0000-0000-0000000000b0');
select pg_temp.ok((select count(*) from public.entries) = 0, 'non-contributor sees no rent data');
select pg_temp.ok((select (public.my_status()->>'unlocked')::boolean) = false, 'my_status says locked');
select public.confirm_adult();
insert into public.entries (address_id,address_label,street_slug,suburb_slug,dwelling,bedrooms,rent_week,lease_year,rating_condition,rating_landlord,rating_noise,share_house,rating_clean)
  values ('GASA_200','2 Test Street','test-street','mawson-lakes','room',4,220,2026,3,2,3,false,2);
select pg_temp.ok((select count(*) from public.entries) = 2, 'contributor sees everyone''s entries');
select pg_temp.ok((select share_house and rating_clean = 2 from public.entries where address_id='GASA_200'), 'room forces share house');
insert into e select 'bob', id from public.entries where address_id = 'GASA_200';

-- 5. comments: filtered and pending
select pg_temp.expect_error($q$insert into public.comments (entry_id, body) select id, 'call me on 0412 345 678' from e where n='bob'$q$, 'phone');
select pg_temp.expect_error($q$insert into public.comments (entry_id, body) select id, 'email bob@example.com' from e where n='bob'$q$, 'email');
select pg_temp.expect_error($q$insert into public.comments (entry_id, body) select id, 'see www.badsite.com' from e where n='bob'$q$, 'links');
select pg_temp.expect_error($q$insert into public.comments (entry_id, body) select id, 'not mine' from e where n='alice'$q$, 'own entry');
insert into public.comments (entry_id, body, status) select id, 'Heater broke in winter, took 3 weeks to fix.', 'approved' from e where n='bob';
select pg_temp.ok((select status from public.comments limit 1) = 'pending', 'comment forced to pending');
reset role;

-- alice cannot see bob's pending comment
select pg_temp.as_user('00000000-0000-0000-0000-0000000000a1');
select pg_temp.ok((select count(*) from public.comments) = 0, 'pending comments invisible to others');
select pg_temp.expect_error('update public.entries set hidden = true', 'permission denied');
select pg_temp.expect_error('select public.admin_queue()', 'Admins only');
reset role;

-- 6. admin approves; alice now sees it
select pg_temp.as_user('00000000-0000-0000-0000-0000000000ad');
reset role;
select pg_temp.as_user(null);
select pg_temp.ok((public.moderation_pending()->>'tips')::int = 1, 'anon can see the count of pending tips (no content)');
reset role;
select pg_temp.as_user('00000000-0000-0000-0000-0000000000ad');
select pg_temp.ok(json_array_length(public.admin_queue()->'comments') = 1, 'admin sees pending comment');
select public.admin_review_comment((select id from e where n='bob'), 'approved');
reset role;
select pg_temp.as_user('00000000-0000-0000-0000-0000000000a1');
select pg_temp.ok((select count(*) from public.comments) = 1, 'approved comment visible to contributors');
reset role;

-- 7. three reports hide an entry
select pg_temp.as_user('00000000-0000-0000-0000-0000000000b0');
select pg_temp.expect_error($q$select public.report_entry((select id from e where n='bob'), 'x')$q$, 'delete your own');
select public.report_entry((select id from e where n='alice'), 'fake');
select public.report_entry((select id from e where n='alice'), 'fake again');  -- duplicate does not count
reset role;
select pg_temp.ok((select report_count from public.entries where address_id='GASA_100') = 1, 'duplicate report ignored');
select pg_temp.as_user('00000000-0000-0000-0000-0000000000c0'); select public.report_entry((select id from e where n='alice'), 'wrong'); reset role;
select pg_temp.ok((select not hidden from public.entries where address_id='GASA_100'), 'still visible after 2 reports');
select pg_temp.as_user('00000000-0000-0000-0000-0000000000d0'); select public.report_entry((select id from e where n='alice'), 'abusive'); reset role;
select pg_temp.ok((select hidden from public.entries where address_id='GASA_100'), 'hidden after 3 reports');
select pg_temp.as_user(null);
select pg_temp.ok(not exists (select 1 from public.place_stats('mawson-lakes') where address_id='GASA_100'), 'hidden entry gone from public stats');
reset role;
select pg_temp.as_user('00000000-0000-0000-0000-0000000000b0');
select pg_temp.ok(not exists (select 1 from public.entries where address_id='GASA_100'), 'hidden entry gone for other users');
reset role;
select pg_temp.as_user('00000000-0000-0000-0000-0000000000a1');
select pg_temp.ok(exists (select 1 from public.entries where address_id='GASA_100'), 'owner still sees own hidden entry');
reset role;

-- 8. admin keeps it
select pg_temp.as_user('00000000-0000-0000-0000-0000000000ad');
select pg_temp.ok(json_array_length(public.admin_queue()->'reported') = 1, 'admin sees reported entry');
select public.admin_resolve((select id from e where n='alice'), 'keep');
reset role;
select pg_temp.ok((select not hidden and report_count = 0 from public.entries where address_id='GASA_100'), 'admin keep restores entry');

-- 9. rate limit 5 a day
select pg_temp.as_user('00000000-0000-0000-0000-0000000000b0');
-- bad values rejected
select pg_temp.expect_error($q$insert into public.entries (address_id,address_label,street_slug,suburb_slug,dwelling,bedrooms,rent_week,lease_year,rating_condition,rating_landlord,rating_noise)
  values ('not-an-id','x x x','test-street','mawson-lakes','unit',2,500,2024,3,3,3)$q$, 'check constraint');
insert into public.entries (address_id,address_label,street_slug,suburb_slug,dwelling,bedrooms,rent_week,lease_year,rating_condition,rating_landlord,rating_noise)
  select 'GASA_30'||g,'3 Test Street','test-street','mawson-lakes','unit',2,500,2024,3,3,3 from generate_series(1,4) g;
select pg_temp.expect_error($q$insert into public.entries (address_id,address_label,street_slug,suburb_slug,dwelling,bedrooms,rent_week,lease_year,rating_condition,rating_landlord,rating_noise)
  values ('GASA_399','3 Test Street','test-street','mawson-lakes','unit',2,500,2024,3,3,3)$q$, 'up to 5');
reset role;

-- 10. delete account removes everything
select pg_temp.as_user('00000000-0000-0000-0000-0000000000b0');
select public.delete_my_account();
reset role;
select pg_temp.ok(not exists (select 1 from auth.users where email='bob@test'), 'account deleted');
select pg_temp.ok(not exists (select 1 from public.entries where address_label like '2 Test%'), 'entries deleted with account');
select pg_temp.ok(not exists (select 1 from public.comments), 'comments deleted with account');

\echo ALL TESTS PASSED

-- 11. admin by email
insert into public.admin_emails (email) values ('Boss@Test');
insert into auth.users (id, email) values ('00000000-0000-0000-0000-0000000000e0', 'boss@test');
select pg_temp.ok((select is_admin from public.profiles where id = '00000000-0000-0000-0000-0000000000e0'), 'listed email becomes admin on sign-up');
insert into auth.users (id, email) values ('00000000-0000-0000-0000-0000000000f0', null);
update auth.users set email = 'boss@test2' where id = '00000000-0000-0000-0000-0000000000f0';
select pg_temp.ok(not (select is_admin from public.profiles where id = '00000000-0000-0000-0000-0000000000f0'), 'unlisted email is not admin');
select pg_temp.as_user(null);
select pg_temp.expect_error('select * from public.admin_emails', 'permission denied');
reset role;
\echo ADMIN EMAIL TESTS PASSED
