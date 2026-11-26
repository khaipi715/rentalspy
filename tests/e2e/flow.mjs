// End-to-end test: drives the built site in Chromium against tests/e2e/fake-supabase.mjs.
// Usage: BASE=http://127.0.0.1:4321 DATABASE_URL=... SHOTS=/some/dir node tests/e2e/flow.mjs
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)('playwright'); // uses the pre-installed Playwright
import pg from 'pg';
import assert from 'node:assert/strict';

const BASE = process.env.BASE || 'http://127.0.0.1:4321';
const SHOTS = process.env.SHOTS || '';
const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
await db.connect();
const browser = await chromium.launch();
const errors = [];
const step = (m) => console.log('ok -', m);
const shot = async (page, name) => { if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: false }); };
async function newUser() {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('dialog', (d) => d.accept(d.type() === 'prompt' ? 'fake entry' : undefined));
  return { ctx, page };
}

// 1. home + search
const a = await newUser();
await a.page.goto(BASE + '/');
await a.page.getByRole('heading', { name: /really pay before you sign/ }).waitFor();
await a.page.locator('#proof').filter({ hasText: /first renters/ }).waitFor();
step('home page loads with live stats');
await a.page.locator('input[type=search]').first().fill('12 adeline');
await a.page.locator('.results a').first().waitFor();
const firstHit = await a.page.locator('.results a').first().textContent();
assert.match(firstHit, /12 Adeline Street/);
await shot(a.page, '01-search');
await a.page.locator('.results a').first().click();
await a.page.waitForURL(/street\/mawson-lakes\/adeline-street/);
await a.page.locator('#addr a.hl').waitFor();
assert.equal((await a.page.locator('#addr a.hl').textContent()).trim(), '12');
step('search "12 adeline" goes to the street and highlights number 12');
await a.page.locator('#reports .lock').waitFor();
await shot(a.page, '02-street');

// 2. address page shows lock
await a.page.locator('#addr a.hl').click();
await a.page.waitForURL(/\/place\/\?id=/);
await a.page.getByRole('heading', { name: '12 Adeline Street' }).waitFor();
await a.page.locator('#reports .lock').waitFor();
await a.page.locator('#expect div').first().waitFor();
step('address page shows expected rent and the unlock box');

// 3. add rent
await a.page.locator('#addBtn').click();
await a.page.waitForURL(/\/add\/\?id=/);
await a.page.locator('#chosen-label').filter({ hasText: '12 Adeline Street, Mawson Lakes' }).waitFor();
await a.page.getByRole('button', { name: 'House or townhouse' }).click();
await a.page.locator('#bedrooms').selectOption('3');
await a.page.locator('#share').check();
await a.page.locator('#rent').fill('660');
for (const k of ['rating_condition', 'rating_landlord', 'rating_noise', 'rating_clean']) await a.page.locator(`.rating[data-k=${k}] button[data-n="4"]`).click();
await a.page.locator('#comment').fill('Heater is old so winter bills are high. Bus stop right outside.');
// submit without 18+ box: must be refused
await a.page.locator('#submit').click();
await a.page.locator('#err').filter({ hasText: /18 or older/ }).waitFor();
step('form refuses to submit without the 18+ confirmation');
await a.page.locator('#adult').check();
await shot(a.page, '03-add-form');
await a.page.locator('#submit').click();
await a.page.locator('#done').waitFor({ state: 'visible' });
await shot(a.page, '04-unlocked');
let r = await db.query("select e.*, c.status from entries e left join comments c on c.entry_id = e.id");
assert.equal(r.rows.length, 1);
assert.equal(r.rows[0].rent_week, 660);
assert.equal(r.rows[0].status, 'pending');
step('entry saved (rent $660) and its tip is waiting for approval');

// 4. place page now unlocked for alice, her pending tip visible to her
await a.page.locator('#seePlace').click();
await a.page.locator('#reports .entry').first().waitFor();
assert.match(await a.page.locator('#reports').textContent(), /\$660/);
assert.match(await a.page.locator('#reports').textContent(), /waiting for approval/);
await shot(a.page, '05-place-unlocked');
step('after sharing, the address shows the full entry (and the owner sees their pending tip)');

// 5. second person: sees teaser, not the rent
const b = await newUser();
await b.page.goto(BASE + '/street/mawson-lakes/adeline-street/');
await b.page.locator('#reports .lock').waitFor();
const txt = await b.page.locator('#reports').textContent();
assert.match(txt, /1 renter has shared/);
assert.doesNotMatch(txt, /\$660/);
assert.equal(await b.page.locator('#addr a.has').count(), 1);
await shot(b.page, '06-locked-for-others');
step('someone who has not shared sees the count and averages but not the rent');

// 6. bob adds a room elsewhere, then can see alice's entry and report it
await b.page.goto(BASE + '/add/');
await b.page.locator('input[type=search]').fill('3 mawson lakes boulevard');
await b.page.locator('.results a').first().waitFor();
await b.page.locator('.results a').first().click();
await b.page.waitForURL(/\/add\/\?st=/);
await b.page.locator('#form').waitFor({ state: 'visible' }).catch(async () => {
  await b.page.locator('#pick-num').selectOption({ index: 1 });
});
await b.page.locator('#form').waitFor({ state: 'visible' });
await b.page.getByRole('button', { name: 'A room in a share house' }).click();
await b.page.locator('#rent').fill('230');
for (const k of ['rating_condition', 'rating_landlord', 'rating_noise', 'rating_clean']) await b.page.locator(`.rating[data-k=${k}] button[data-n="2"]`).click();
await b.page.locator('#adult').check();
await b.page.locator('#submit').click();
await b.page.locator('#done').waitFor({ state: 'visible' });
step('second person adds a share-house room');
await b.page.goto(BASE + '/street/mawson-lakes/adeline-street/');
await b.page.locator('#reports .entry').first().waitFor();
assert.match(await b.page.locator('#reports').textContent(), /\$660/);
assert.doesNotMatch(await b.page.locator('#reports').textContent(), /Heater is old/);
step('once they share, they can see the first person\'s rent, but not the unapproved tip');
await b.page.locator('[data-report]').first().click();
await b.page.locator('[data-report]').filter({ hasText: 'Reported' }).waitFor();

// 7. two more people report it -> hidden
for (let i = 0; i < 2; i++) {
  const c = await newUser();
  await c.page.goto(BASE + '/add/?st=mawson-lakes/adeline-street&n=14');
  await c.page.locator('#form').waitFor({ state: 'visible' }).catch(() => c.page.locator('#pick-num').selectOption({ index: 1 }));
  await c.page.locator('#form').waitFor({ state: 'visible' });
  await c.page.getByRole('button', { name: 'Unit or apartment' }).click();
  await c.page.locator('#rent').fill(String(500 + i));
  for (const k of ['rating_condition', 'rating_landlord', 'rating_noise']) await c.page.locator(`.rating[data-k=${k}] button[data-n="3"]`).click();
  await c.page.locator('#adult').check();
  await c.page.locator('#submit').click();
  await c.page.locator('#done').waitFor({ state: 'visible' });
  await c.page.goto(BASE + '/street/mawson-lakes/adeline-street/');
  await c.page.locator('#reports .entry').first().waitFor();
  const target = c.page.locator('.entry', { hasText: '$660' }).locator('[data-report]');
  await target.click();
  await c.page.locator('[data-report]').filter({ hasText: 'Reported' }).waitFor();
  await c.ctx.close();
}
r = await db.query('select hidden, report_count from entries where rent_week = 660');
assert.equal(r.rows[0].hidden, true);
assert.equal(r.rows[0].report_count, 3);
step('three reports from different people hide the entry automatically');

// 8. admin approves tip and keeps the entry
// promote the first person (alice) to admin and use her browser
const aliceId = (await db.query('select user_id from entries where rent_week = 660')).rows[0].user_id;
await db.query('update profiles set is_admin = true where id = $1', [aliceId]);
await a.page.goto(BASE + '/admin/');
await a.page.locator('#q').waitFor({ state: 'visible' });
await shot(a.page, '07-admin');
assert.match(await a.page.locator('#comments').textContent(), /Heater is old/);
assert.match(await a.page.locator('#reported').textContent(), /3 report/);
await a.page.locator('#comments button', { hasText: 'Approve' }).click();
await a.page.locator('#reported button', { hasText: 'Keep' }).click();
await a.page.waitForTimeout(400);
r = await db.query("select e.hidden, c.status from entries e join comments c on c.entry_id = e.id where e.rent_week = 660");
assert.deepEqual(r.rows[0], { hidden: false, status: 'approved' });
step('admin page approves the tip and restores the reported entry');

// 9. bob now sees the approved tip
await b.page.goto(BASE + '/street/mawson-lakes/adeline-street/');
await b.page.locator('#reports .entry').first().waitFor();
assert.match(await b.page.locator('#reports').textContent(), /Heater is old/);
step('approved tip is visible to other contributors');

// 10. my places: delete entry, delete account
await b.page.goto(BASE + '/me/');
await b.page.locator('[data-del]').first().waitFor();
await shot(b.page, '08-me');
await b.page.locator('[data-del]').first().click();
await b.page.locator('#list .entry').waitFor({ state: 'detached' });
assert.equal((await db.query('select count(*)::int n from entries where rent_week = 230')).rows[0].n, 0);
step('a person can delete their own entry');
await b.page.locator('#del').click();
await b.page.waitForURL(BASE + '/');
step('a person can delete their whole account');

// 11. suburb page + map
await a.page.goto(BASE + '/suburb/mawson-lakes/');
await a.page.locator('.rent-tool .big').filter({ hasText: '$' }).waitFor();
await a.page.getByRole('button', { name: 'House or townhouse' }).click();
await a.page.getByRole('button', { name: '3', exact: true }).click();
const big = await a.page.locator('.rent-tool .big').textContent();
assert.match(big, /\$650/);
await shot(a.page, '09-suburb');
step('suburb rent tool shows $650 for a 3-bed house (matches government data)');
await a.page.goto(BASE + '/');
await a.page.locator('.maplibregl-canvas').waitFor();
await a.page.waitForTimeout(2500);
await shot(a.page, '10-home');
step('home map renders');

await browser.close();
await db.end();
const real = errors.filter((e) => !/WebGL|webgl|Failed to fetch|tiles\.openfreemap/.test(e));
if (real.length) { console.log('PAGE ERRORS:\n' + real.join('\n')); process.exit(1); }
console.log('ALL E2E CHECKS PASSED' + (errors.length ? ` (ignored ${errors.length} map/network warnings)` : ''));
