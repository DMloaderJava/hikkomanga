import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const exec = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));
const google = 'google65ee958671ecedb0.html';
const yandex = 'yandex_4ba4f536815316a1.html';

async function fixture(run) {
  // Inside the project so the copied script resolves the project's dependencies.
  const dir = await mkdtemp(`${root}.verification-test-`);
  try {
    await mkdir(`${dir}/scripts`);
    await cp(`${root}scripts/check-verification.mjs`, `${dir}/scripts/check-verification.mjs`);
    for (const path of ['public', 'index.html', 'vercel.json']) {
      await cp(`${root}${path}`, `${dir}/${path}`, { recursive: true });
    }
    await cp(`${dir}/public`, `${dir}/dist`, { recursive: true });
    const check = (...args) => exec(process.execPath, [`${dir}/scripts/check-verification.mjs`, ...args]);
    await run({ dir, check });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('accepts JSON5 comments/trailing commas and formatted build files', () => fixture(async ({ dir, check }) => {
  const config = await readFile(`${dir}/vercel.json`, 'utf8');
  await writeFile(`${dir}/vercel.json`, `// Routing config\n${config.replace(/}\s*$/, ',\n}')}`);
  await writeFile(`${dir}/dist/${google}`, `\n google-site-verification: ${google}\r\n`);
  const html = await readFile(`${dir}/dist/${yandex}`, 'utf8');
  await writeFile(`${dir}/dist/${yandex}`, html.trim().replace(/>\s+</g, '><'));
  await check('--built');
}));

test('reports malformed configuration clearly', () => fixture(async ({ dir, check }) => {
  await writeFile(`${dir}/vercel.json`, '{ broken:');
  await assert.rejects(check(), /Cannot read or parse vercel.json/);
}));

for (const filename of [google, yandex]) {
  test(`rejects missing build file: ${filename}`, () => fixture(async ({ dir, check }) => {
    await rm(`${dir}/dist/${filename}`);
    await assert.rejects(check('--built'), /Missing verification file/);
  }));
  test(`rejects SPA shell in build file: ${filename}`, () => fixture(async ({ dir, check }) => {
    await writeFile(`${dir}/dist/${filename}`, '<html><body><div id="root"></div></body></html>');
    await assert.rejects(check('--built'), /Wrong verification content/);
  }));
}

test('live checks accept both files and reject SPA responses and redirects', () => fixture(async ({ dir, check }) => {
  const contents = new Map(await Promise.all([google, yandex].map(async (name) => [
    `/${name}`, await readFile(`${dir}/public/${name}`, 'utf8'),
  ])));
  let mode = 'files';
  const server = createServer((req, res) => {
    if (mode === 'redirect') {
      res.writeHead(302, { Location: '/' });
      res.end();
    } else {
      res.end(mode === 'spa' ? '<html><div id="root"></div></html>' : contents.get(req.url));
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const url = `http://127.0.0.1:${server.address().port}`;
    const { stdout } = await check('--url', url);
    assert.equal((stdout.match(/Live verification file OK/g) || []).length, 2);
    mode = 'spa';
    await assert.rejects(check('--url', url), /returned the wrong verification content/);
    mode = 'redirect';
    await assert.rejects(check('--url', url), /must return HTTP 200 without a redirect/);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}));
