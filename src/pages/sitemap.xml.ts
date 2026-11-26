import suburbs from '../data/suburbs.json';
import streets from '../data/streets.json';

export function GET() {
  const site = (import.meta.env.PUBLIC_SITE_URL || 'https://example.com').replace(/\/$/, '');
  const paths = ['/', '/about/', '/rules/', '/add/',
    ...suburbs.map((s: any) => `/suburb/${s.slug}/`),
    ...(streets as any[]).map((s) => `/street/${s.sslug}/${s.slug}/`)];
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${paths.map((p) => `<url><loc>${site}${p}</loc></url>`).join('\n')}\n</urlset>\n`;
  return new Response(xml, { headers: { 'Content-Type': 'application/xml' } });
}
