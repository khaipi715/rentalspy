import { sb, getStatus, ensureSession, niceError } from './supabase';
import { esc, money } from './format';

export type Stat = { address_id: string; address_label: string; street_slug: string; reports: number; avg_condition: number; avg_landlord: number; avg_noise: number; mould_pct: number };
export type Entry = {
  id: string; user_id: string; address_id: string; address_label: string; suburb_slug: string; street_slug: string; dwelling: string; bedrooms: number | null; share_house: boolean;
  rent_week: number; lease_year: number; still_living: boolean; rating_condition: number; rating_landlord: number; rating_noise: number;
  rating_clean: number | null; mould: boolean; heating_cooling_ok: boolean; repairs_quick: boolean | null; bond_returned: boolean | null;
  pets_allowed: boolean | null; hidden: boolean; created_at: string; comments?: { body: string; status: string } | { body: string; status: string }[] | null;
};

export async function placeStats(suburb: string, street?: string): Promise<Stat[]> {
  if (!sb) return [];
  const { data, error } = await sb.rpc('place_stats', { p_suburb: suburb, p_street: street ?? null });
  return error ? [] : (data as Stat[]);
}

export async function entriesFor(filter: { address?: string; suburb?: string; street?: string }): Promise<Entry[]> {
  if (!sb) return [];
  const { data: s } = await sb.auth.getSession();
  if (!s.session) return [];
  let q = sb.from('entries').select('*, comments(body,status)').order('created_at', { ascending: false }).limit(200);
  if (filter.address) q = q.eq('address_id', filter.address);
  if (filter.suburb) q = q.eq('suburb_slug', filter.suburb);
  if (filter.street) q = q.eq('street_slug', filter.street);
  const { data, error } = await q;
  return error ? [] : (data as Entry[]);
}

const stars = (n: number) => `<span aria-label="${n} out of 5">${'★'.repeat(n)}<span style="opacity:.25">${'★'.repeat(5 - n)}</span></span>`;
const yn = (v: boolean | null, yes: string, no: string, goodIsYes = true) =>
  v == null ? '' : `<span class="pill ${v === goodIsYes ? 'good' : 'bad'}">${esc(v ? yes : no)}</span>`;
const kind = (e: Entry) => (e.dwelling === 'room' ? 'Room in a share house' : `${e.bedrooms ?? '?'}-bed ${e.dwelling}${e.share_house ? ' (shared)' : ''}`);

export function entryHtml(e: Entry, mine: boolean, showAddress = false) {
  const c = Array.isArray(e.comments) ? e.comments[0] : e.comments;
  const comment = c && (c.status === 'approved' || mine)
    ? `<p style="margin:0">“${esc(c.body)}”${c.status === 'pending' ? ' <span class="note">(waiting for approval, only you can see it)</span>' : ''}</p>` : '';
  return `<article class="entry" data-id="${esc(e.id)}">
    <div class="row"><b style="font-size:20px">${money(e.rent_week)}<span class="note"> /week${e.dwelling === 'room' ? ' per room' : ''}</span></b>
      <span class="note">${esc(kind(e))} · lease from ${esc(e.lease_year)}${e.still_living ? ' · lives there now' : ''}</span>
      ${mine ? '<span class="pill">Your entry</span>' : ''}${e.hidden ? '<span class="pill bad">Hidden while reviewed</span>' : ''}</div>
    ${showAddress ? `<div><a href="/place/?id=${esc(e.address_id)}&st=${esc(e.suburb_slug)}/${esc(e.street_slug)}">${esc(e.address_label)}</a></div>` : ''}
    <div class="row" style="font-size:15px;column-gap:18px"><span>Condition ${stars(e.rating_condition)}</span><span>Landlord/agent ${stars(e.rating_landlord)}</span><span>Quiet ${stars(e.rating_noise)}</span>${e.rating_clean ? `<span>House cleanliness ${stars(e.rating_clean)}</span>` : ''}</div>
    <div class="row">${yn(e.mould, 'Mould or damp', 'No mould', false)}${yn(e.heating_cooling_ok, 'Heating/cooling works', 'Heating/cooling poor')}${yn(e.repairs_quick, 'Repairs done quickly', 'Slow repairs')}${yn(e.bond_returned, 'Bond returned', 'Bond not fully returned')}${yn(e.pets_allowed, 'Pets allowed', 'No pets')}</div>
    ${comment}
    ${mine ? '' : `<div><button class="btn ghost small" data-report="${esc(e.id)}">Report</button></div>`}
  </article>`;
}

export function teaserHtml(stats: Stat[]) {
  const n = stats.reduce((a, s) => a + Number(s.reports), 0);
  if (!n) return '';
  const avg = (k: keyof Stat) => (stats.reduce((a, s) => a + Number(s[k]) * Number(s.reports), 0) / n).toFixed(1);
  return `<div class="facts"><div><span>Renter reports</span><b>${n}</b></div><div><span>Average condition</span><b>${avg('avg_condition')} / 5</b></div><div><span>Average landlord/agent</span><b>${avg('avg_landlord')} / 5</b></div><div><span>Average quietness</span><b>${avg('avg_noise')} / 5</b></div></div>`;
}

export function lockHtml(addHref: string, n: number) {
  return `<div class="lock"><h3>${n ? `${n} renter${n > 1 ? 's have' : ' has'} shared what they really pay here` : 'Be the first renter to share this place'}</h3>
  <p>Add the rent you pay (or paid) anywhere in these suburbs. It takes about 30 seconds, no email needed. Then you can see every rent and review on RentalSpy.</p>
  <a class="btn" href="${esc(addHref)}">Add your rent to unlock</a></div>`;
}

export function bindReports(root: HTMLElement) {
  root.addEventListener('click', async (ev) => {
    const b = (ev.target as HTMLElement).closest<HTMLButtonElement>('[data-report]');
    if (!b) return;
    const reason = window.prompt?.('What is wrong with this entry? (for example: fake, names a person, abusive)') ?? 'Reported';
    if (reason === null) return;
    try {
      await ensureSession();
      const { error } = await sb!.rpc('report_entry', { p_entry: b.dataset.report, p_reason: reason || 'Reported' });
      if (error) throw error;
      b.textContent = 'Reported, thank you';
      b.disabled = true;
    } catch (e) { toast(niceError(e)); }
  });
}

export function toast(msg: string) {
  const t = document.createElement('div');
  t.className = 'toast'; t.role = 'status'; t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 4500);
}

/** Fill a renter-reports box: teaser for everyone, full entries if unlocked. */
export async function fillReports(box: HTMLElement, opts: { suburb: string; street?: string; address?: string; addHref: string; showAddress?: boolean }) {
  if (!sb) {
    box.innerHTML = `<div class="lock"><h3>Renter reviews are coming</h3><p>This preview isn't connected to the database yet.</p></div>`;
    return;
  }
  const [stats, status] = await Promise.all([placeStats(opts.suburb, opts.street), getStatus()]);
  const scoped = opts.address ? stats.filter((s) => s.address_id === opts.address) : stats;
  const n = scoped.reduce((a, s) => a + Number(s.reports), 0);
  const { data: sess } = await sb.auth.getSession();
  const me = sess.session?.user.id;
  if (status?.unlocked) {
    const list = await entriesFor({ address: opts.address, suburb: opts.address ? undefined : opts.suburb, street: opts.address ? undefined : opts.street });
    box.innerHTML = list.length
      ? `${teaserHtml(scoped)}<div style="display:grid;gap:12px;margin-top:16px">${list.map((e) => entryHtml(e, e.user_id === me, opts.showAddress)).join('')}</div>`
      : `<p>No renter has shared this ${opts.address ? 'place' : 'street'} yet.</p><a class="btn" href="${esc(opts.addHref)}">Add your experience</a>`;
    bindReports(box);
  } else {
    box.innerHTML = (n ? teaserHtml(scoped) : '') + lockHtml(opts.addHref, n);
  }
  return stats;
}
