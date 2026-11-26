export function GET() {
  const site = (import.meta.env.PUBLIC_SITE_URL || '').replace(/\/$/, '');
  return new Response(`User-agent: *\nAllow: /\nDisallow: /admin/\nDisallow: /me/\n${site ? `Sitemap: ${site}/sitemap.xml\n` : ''}`, { headers: { 'Content-Type': 'text/plain' } });
}
