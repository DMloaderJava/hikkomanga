// Check the ownership file, deployment routing, and optionally the build/live site.
// Usage: node scripts/check-verification.mjs [--built] [--url https://your-domain]
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import JSON5 from 'json5';

const filename = 'google65ee958671ecedb0.html';
const yandexFilename = 'yandex_4ba4f536815316a1.html';
const verificationFiles = [
  {
    filename,
    expected: `google-site-verification: ${filename}`,
    normalize: (content) => content.trim(),
  },
  {
    filename: yandexFilename,
    expected: '<html><head><meta http-equiv="Content-Type" content="text/html; charset=UTF-8"></head><body>Verification: 4ba4f536815316a1</body></html>',
    // Allow formatting/minification between HTML tags, not arbitrary extra markup.
    normalize: (content) => content.trim().replace(/>\s+</g, '><'),
  },
];
const resolve = (path) => new URL(`../${path}`, import.meta.url);
const read = (path) => readFileSync(resolve(path), 'utf8');
function checkFiles(directory) {
  for (const file of verificationFiles) {
    const path = `${directory}/${file.filename}`;
    assert.ok(existsSync(resolve(path)), `Missing verification file: ${path}`);
    assert.equal(file.normalize(read(path)), file.expected, `Wrong verification content: ${path}`);
  }
}
checkFiles('public');

let config;
try {
  config = JSON5.parse(read('vercel.json'));
} catch (error) {
  throw new Error(`Cannot read or parse vercel.json: ${error.message}`, { cause: error });
}
assert.ok(Array.isArray(config.rewrites), 'vercel.json must define a rewrites array');
// These sources use Vercel's parenthesized regex syntax.
const fallbacks = config.rewrites
  .filter((rule) => rule.destination === '/index.html')
  .map((rule) => new RegExp(`^${rule.source}$`));
assert.ok(fallbacks.length, 'Expected a SPA fallback');
for (const path of [
  `/${filename}`,
  '/google-another-token.html',
  `/${yandexFilename}`,
  '/yandex_another-token.html',
  '/sitemap.xml',
  '/robots.txt',
  '/assets/app.js',
  '/media/cover.webp',
  '/api',
  '/api/login',
]) {
  assert.ok(!fallbacks.some((rule) => rule.test(path)), `${path} must not return the SPA shell`);
}
for (const path of ['/', '/advertise', '/admin', '/title/example', '/title/example/chapter/1']) {
  assert.ok(fallbacks.some((rule) => rule.test(path)), `${path} must retain SPA routing`);
}
assert.ok(
  !read('index.html').includes('name="google-site-verification" content="65ee958671ecedb0"'),
  'Do not reuse an HTML-file ID as an HTML-tag verification token',
);

if (process.argv.includes('--built')) {
  // This checks build artifacts only. Production HTTP routing needs --url.
  checkFiles('dist');
}

const urlIndex = process.argv.indexOf('--url');
if (urlIndex !== -1) {
  assert.ok(process.argv[urlIndex + 1], '--url requires the deployed site URL');
  for (const file of verificationFiles) {
    const url = new URL(`/${file.filename}`, process.argv[urlIndex + 1]);
    assert.ok(['http:', 'https:'].includes(url.protocol), '--url must be an HTTP(S) site URL');
    const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(20_000) });
    assert.equal(response.status, 200, `${url} must return HTTP 200 without a redirect`);
    assert.equal(file.normalize(await response.text()), file.expected, `${url} returned the wrong verification content`);
    console.log(`Live verification file OK: ${url}`);
  }
}
console.log('Ownership verification checks passed.');
