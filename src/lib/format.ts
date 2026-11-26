export type Point = [string, number | string | null, number | null, number | null]; // [quarter, count, median, metroMedian]

export const money = (v: number | null | undefined) => (v == null ? '—' : '$' + Math.round(Number(v)).toLocaleString('en-AU'));
export const cnt = (n: number | string | null | undefined) => (n == null ? '—' : n === '*' ? '1–5' : String(n));
export const qName = (q: string) => {
  const [y, m] = q.split('-');
  return ({ '03': 'Jan–Mar', '06': 'Apr–Jun', '09': 'Jul–Sep', '12': 'Oct–Dec' } as Record<string, string>)[m] + ' ' + y;
};
export const latest = (s: Point[]) => [...s].reverse().find((p) => p[2] != null) || null;
/** Latest median, but only if it's from the last 4 quarters (older figures would mislead). */
export const fresh = (s: Point[]) => { const l = latest(s); return l && s.findIndex((p) => p[0] === l[0]) >= s.length - 4 ? l : null; };
export const esc = (s: unknown) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);

export const RENT_SCALE: [number, number, string, string][] = [
  [0, 560, 'var(--s1)', 'Under $560'],
  [560, 580, 'var(--s2)', '$560–579'],
  [580, 600, 'var(--s3)', '$580–599'],
  [600, 620, 'var(--s4)', '$600–619'],
  [620, 1e9, 'var(--s5)', '$620+'],
];
export const rentColour = (v: number | null) => (v == null ? 'var(--soft)' : RENT_SCALE.find((s) => v >= s[0] && v < s[1])![2]);

export const CRIME_NAMES: Record<string, string> = {
  'SCT - Residence': 'Home break-ins',
  'Theft from retail premises': 'Shoplifting',
  'Damage or destroy property': 'Property damage',
  'Motor vehicle theft and related offences': 'Car theft and related',
  'Theft from a person': 'Theft from a person',
  'Obtain benefit by deception': 'Fraud',
  'Serious Assault': 'Serious assault',
  'Common Assault': 'Common assault',
  'Other unlawful entry with intent': 'Other break-ins',
  'SCT - Non Residence': 'Break-ins (not homes)',
};
