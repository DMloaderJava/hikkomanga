// The SPA fallback must cover deep links without swallowing API/static files.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

const config = JSON.parse(readFileSync('vercel.json', 'utf8'));
const fallback = config.rewrites.find((rule) => rule.destination === '/index.html');
assert.ok(fallback, 'Vercel must have a SPA fallback');
const pattern = new RegExp(`^${fallback.source}$`);

for (const url of [
  '/', '/admin', '/admin/login', '/admin/login/confirm',
  '/admin/titles/title-id/chapters',
  '/admin/titles/title-id/chapters/chapter-id',
  '/admin/titles/title-id/chapters/import',
  '/admin/titles/title-id/chapters/chapter-id/pages',
  '/title/title-slug/chapter/1',
]) {
  assert.ok(pattern.test(url), `SPA deep link must match: ${url}`);
}
for (const url of [
  '/api', '/api/login-confirm', '/assets', '/assets/app.js', '/assets/app.css',
  '/media', '/media/cover.webp', '/favicon.ico', '/robots.txt', '/sitemap.xml',
  ...readdirSync('public', { withFileTypes: true })
    .filter((entry) => entry.isFile()).map((entry) => `/${entry.name}`),
]) {
  assert.ok(!pattern.test(url), `API/static URL must be excluded: ${url}`);
}
console.log('PASS  Vercel SPA deep links; API, assets, media and verification files excluded');
