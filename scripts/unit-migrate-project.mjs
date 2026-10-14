#!/usr/bin/env node
/**
 * Тест scripts/migrate-supabase-project.mjs.
 *
 * Сеть недоступна (песочница/CI), поэтому оба «проекта» — локальные mock-серверы:
 *   • OLD (http://localhost:<p1>) — отдаёт строки таблиц и файлы Storage;
 *   • NEW (http://127.0.0.1:<p2>) — принимает upsert'ы и загрузки файлов.
 *
 * Хосты намеренно разные (localhost ≠ 127.0.0.1), иначе скрипт справедливо
 * откажется работать: он требует два разных проекта.
 *
 * Проверяем: чтение таблиц с пагинацией, перезапись ссылок со старого хоста на
 * новый, upsert с сохранением id, копирование отсутствующих файлов и пропуск
 * уже существующих.
 */
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const script = join(dirname(fileURLToPath(import.meta.url)), 'migrate-supabase-project.mjs');

let failures = 0;
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ` — ${extra}` : ''}`);
  if (!ok) failures += 1;
};

// ── mock OLD ───────────────────────────────────────────────────────────────
const oldRows = {
  genres: [{ id: 'g1', name: 'Экшен' }],
  titles: [
    {
      id: 't1',
      slug: 'demo',
      title: 'Демо',
      cover_url: 'http://localhost:PORT/storage/v1/object/public/title-covers/t1.webp',
    },
  ],
  title_genres: [{ title_id: 't1', genre_id: 'g1' }],
  chapters: [{ id: 'c1', title_id: 't1', number: 1, name: null, published: true }],
  pages: [
    {
      id: 'p1',
      chapter_id: 'c1',
      image_url: 'http://localhost:PORT/storage/v1/object/public/manga/c1/1.webp',
      original_url: 'c1/1-original.jpg',
      page_order: 1,
    },
    {
      id: 'p2',
      chapter_id: 'c1',
      image_url: 'http://localhost:PORT/storage/v1/object/public/manga/c1/2.webp',
      original_url: null,
      page_order: 2,
    },
  ],
  chapter_voiceovers: [],
  ads: [],
};
const oldFiles = new Map([
  ['title-covers/t1.webp', Buffer.from('cover')],
  ['manga/c1/1.webp', Buffer.from('image-1')],
  ['manga/c1/2.webp', Buffer.from('image-2')],
]);

const oldServer = createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname.startsWith('/rest/v1/')) {
    const table = url.pathname.replace('/rest/v1/', '');
    const rows = oldRows[table];
    if (!rows) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ code: '42P01', message: `no table ${table}` }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(rows));
    return;
  }
  const m = url.pathname.match(/^\/storage\/v1\/object\/(?:public\/)?(.+)$/);
  if (m) {
    const file = oldFiles.get(decodeURI(m[1]));
    if (!file) {
      res.writeHead(400);
      res.end('not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'image/webp' });
    res.end(file);
    return;
  }
  res.writeHead(404);
  res.end();
});

// ── mock NEW ───────────────────────────────────────────────────────────────
const inserted = []; // {table, rows}
const uploads = []; // "bucket/path"

const newServer = createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname.startsWith('/rest/v1/')) {
    const table = url.pathname.replace('/rest/v1/', '');
    if (req.method === 'POST') {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        inserted.push({ table, rows: JSON.parse(body) });
        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end('[]');
      });
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('[]'); // preflight select
    return;
  }
  const m = url.pathname.match(/^\/storage\/v1\/object\/(.+)$/);
  if (m) {
    const id = decodeURI(m[1]);
    if (req.method === 'HEAD') {
      // «файл уже скопирован» — c1/2.webp
      res.writeHead(id === 'manga/c1/2.webp' ? 200 : 400);
      res.end();
      return;
    }
    if (req.method === 'POST') {
      req.resume();
      req.on('end', () => {
        uploads.push(id);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{}');
      });
      return;
    }
  }
  res.writeHead(404);
  res.end();
});

await once(oldServer.listen(0, 'localhost'), 'listening');
await once(newServer.listen(0, '127.0.0.1'), 'listening');
const oldPort = oldServer.address().port;
const newPort = newServer.address().port;

// подставляем реальный порт в фикстуры заранее — скрипт скачает файлы
// с OLD по URL из старых строк (после перезаписи хоста порт сохраняется).
const oldUrl = `http://localhost:${oldPort}`;
const newUrl = `http://127.0.0.1:${newPort}`;
for (const row of oldRows.titles) row.cover_url = row.cover_url.replace('PORT', String(oldPort));
for (const row of oldRows.pages) row.image_url = row.image_url.replace('PORT', String(oldPort));

// ── прогон ─────────────────────────────────────────────────────────────────
const child = spawn(process.execPath, [script], {
  env: {
    ...process.env,
    OLD_SUPABASE_URL: oldUrl,
    OLD_SUPABASE_KEY: 'old-service-role-key',
    NEW_SUPABASE_URL: newUrl,
    NEW_SUPABASE_KEY: 'new-service-role-key',
  },
});
let out = '';
child.stdout.on('data', (c) => (out += c));
child.stderr.on('data', (c) => (out += c));
const [code] = await once(child, 'close');

// ── проверки ───────────────────────────────────────────────────────────────
if (code !== 0) console.log(out); // вывод скрипта целиком: по нему видно, что упало
check('скрипт завершился успешно', code === 0, `exit=${code}`);
check('ссылка на обложку перезаписана на новый хост', out.includes('127.0.0.1') && !/localStorage/.test(out));
check('перенесены строки pages', inserted.some((i) => i.table === 'pages' && i.rows.length === 2));

const pagesInsert = inserted.find((i) => i.table === 'pages');
check(
  'image_url в новой базе указывает на новый хост',
  !!pagesInsert && pagesInsert.rows.every((r) => r.image_url.includes('127.0.0.1'))
);
check(
  'id и original_url не потеряны',
  !!pagesInsert && pagesInsert.rows[0].id === 'p1' && pagesInsert.rows[0].original_url === 'c1/1-original.jpg'
);
check('перенесены названия/главы/жанры', ['titles', 'chapters', 'genres', 'title_genres'].every((t) => inserted.some((i) => i.table === t)));
check(
  'скопированы отсутствующие файлы (обложка + 1.webp), существующий пропущен',
  uploads.length === 2 && uploads.includes('manga/c1/1.webp') && uploads.includes('title-covers/t1.webp'),
  uploads.join(', ')
);
check('2.webp пропущен как уже существующий', out.includes('уже было: 1'));
check('ошибок копирования нет', out.includes('ошибок: 0'));
check('итоговая сводка напечатана', out.includes('Итого за'));

// ── dry-run: ничего не пишет ───────────────────────────────────────────────
inserted.length = 0;
uploads.length = 0;
const dry = spawn(process.execPath, [script, '--dry-run'], {
  env: {
    ...process.env,
    OLD_SUPABASE_URL: oldUrl,
    OLD_SUPABASE_KEY: 'k',
    NEW_SUPABASE_URL: newUrl,
    NEW_SUPABASE_KEY: 'k',
  },
});
let dryOut = '';
dry.stdout.on('data', (c) => (dryOut += c));
dry.stderr.on('data', (c) => (dryOut += c));
const [dryCode] = await once(dry, 'close');
check('dry-run завершился успешно', dryCode === 0, `exit=${dryCode}`);
check('dry-run ничего не записал', inserted.length === 0 && uploads.length === 0);
check('dry-run перечислил бакеты', dryOut.includes('manga:') && dryOut.includes('title-covers:'));

// ── отказ при одинаковых проектах ──────────────────────────────────────────
const same = spawn(process.execPath, [script], {
  env: {
    ...process.env,
    OLD_SUPABASE_URL: oldUrl,
    OLD_SUPABASE_KEY: 'k',
    NEW_SUPABASE_URL: oldUrl,
    NEW_SUPABASE_KEY: 'k',
  },
});
let sameOut = '';
same.stdout.on('data', (c) => (sameOut += c));
same.stderr.on('data', (c) => (sameOut += c));
const [sameCode] = await once(same, 'close');
check('одинаковые проекты → отказ', sameCode === 1 && sameOut.includes('совпадают'));

oldServer.close();
newServer.close();

console.log(failures ? `\nunit-migrate-project: ${failures} проверок провалено` : '\nunit-migrate-project: все проверки пройдены');
process.exit(failures ? 1 : 0);
