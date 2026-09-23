#!/usr/bin/env node
/**
 * Render an admin chapter voiceover player to a silent WebM screen capture,
 * then mux the exact signed WAV used by the player into an MP4.
 *
 * Start `npm run dev` (or set RENDER_BASE_URL to a local/staging deployment),
 * then run:
 *   npm run render:chapter -- --chapter <chapter-id>
 *   npm run render:chapter -- --chapters <id1,id2,id3> --out ./out/chain.mp4
 *
 * Auth is read from --storage-state / RENDER_STORAGE_STATE or from
 * RENDER_ADMIN_EMAIL + RENDER_ADMIN_PASSWORD in .env. The renderer only needs
 * the public Supabase key plus an authenticated admin session; never use a
 * service-role key here.
 */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { constants as fsConstants, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const VIDEO_SIZE = Object.freeze({ width: 1280, height: 720 });
const DEFAULT_BASE_URL = 'http://127.0.0.1:5173';
const DEFAULT_LOGIN_TIMEOUT_MS = 180_000;
const DEFAULT_PAGE_TIMEOUT_MS = 45_000;
const DEFAULT_TAIL_MS = 500;
const DURATION_TOLERANCE_MS = 100;

export const RENDER_HELP = `
Render an admin chapter voiceover to MP4.

Usage:
  npm run dev
  npm run render:chapter -- --chapter <chapter-id> [--out ./out/chapter.mp4]
  npm run render:chapter -- --chapters <id1,id2,...> [--out ./out/chain.mp4]

Options:
  --chapter <id>           Render one chapter.
  --chapters <id1,id2,...> Render chapters in the given order and concatenate them.
  --out <file.mp4>         Output file (default: ./out/chapter-<id>.mp4 or ./out/chapters.mp4).
  --base-url <url>         App origin (default: RENDER_BASE_URL or ${DEFAULT_BASE_URL}).
  --storage-state <file>   Playwright storage-state JSON; overrides RENDER_STORAGE_STATE.
  --help                   Show this help.

Auth in .env:
  RENDER_STORAGE_STATE=./.auth/admin.json
  # or
  RENDER_ADMIN_EMAIL=admin@example.com
  RENDER_ADMIN_PASSWORD=...

The app must point at a local/staging Supabase project via VITE_SUPABASE_URL and
VITE_SUPABASE_ANON_KEY (or VITE_SUPABASE_PUBLISHABLE_KEY). Use an approved
Login Guard session; email/password login may wait for owner confirmation.
The renderer refuses hosts that match .env.production; when a staging site
intentionally shares the production Supabase project, opt in explicitly with
RENDER_ALLOW_PROD_DB=1 (a warning is printed for every run).
Chromium install: npx playwright install chromium
`;

function usageError(message) {
  return new Error(`${message}\nRun npm run render:chapter -- --help for usage.`);
}

export function nonNegativeEnvNumber(env, name, fallback) {
  const value = Number(env?.[name]);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function isTruthyEnv(value) {
  return /^(1|true|yes)$/i.test(String(value ?? '').trim());
}

function requiredOptionValue(argv, index, option) {
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) throw usageError(`${option} requires a value.`);
  return value;
}

function safeSegment(value) {
  return String(value).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 100) || 'chapter';
}

export function parseArgs(argv, env = process.env) {
  const parsed = {
    chapter: null,
    chapters: null,
    out: null,
    baseUrl: null,
    storageState: null,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--help' || token === '-h') {
      parsed.help = true;
    } else if (token === '--chapter') {
      parsed.chapter = requiredOptionValue(argv, index, token);
      index += 1;
    } else if (token === '--chapters') {
      parsed.chapters = requiredOptionValue(argv, index, token);
      index += 1;
    } else if (token === '--out') {
      parsed.out = requiredOptionValue(argv, index, token);
      index += 1;
    } else if (token === '--base-url') {
      parsed.baseUrl = requiredOptionValue(argv, index, token);
      index += 1;
    } else if (token === '--storage-state') {
      parsed.storageState = requiredOptionValue(argv, index, token);
      index += 1;
    } else {
      throw usageError(`Unknown option: ${token}`);
    }
  }

  if (parsed.help) return parsed;
  if (parsed.chapter && parsed.chapters) {
    throw usageError('Use either --chapter or --chapters, not both.');
  }

  const chapterIds = parsed.chapter
    ? [parsed.chapter.trim()]
    : parsed.chapters
      ? parsed.chapters.split(',').map((id) => id.trim())
      : [];
  if (chapterIds.length === 0 || chapterIds.some((id) => !id)) {
    throw usageError('Provide --chapter <id> or --chapters <id1,id2,...> with no empty IDs.');
  }
  if (new Set(chapterIds).size !== chapterIds.length) {
    throw usageError('--chapters cannot contain duplicate chapter IDs.');
  }

  const defaultOut = parsed.chapter
    ? `./out/chapter-${safeSegment(parsed.chapter)}.mp4`
    : chapterIds.length === 1
      ? `./out/chapter-${safeSegment(chapterIds[0])}.mp4`
      : './out/chapters.mp4';
  const out = path.resolve(parsed.out || defaultOut);
  if (path.extname(out).toLowerCase() !== '.mp4') {
    throw usageError('--out must have an .mp4 extension.');
  }

  let baseUrl = parsed.baseUrl || env.RENDER_BASE_URL || DEFAULT_BASE_URL;
  try {
    const url = new URL(baseUrl);
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('unsupported protocol');
    baseUrl = url.origin;
  } catch {
    throw usageError('--base-url must be a valid http(s) URL.');
  }

  return {
    ...parsed,
    chapterIds,
    out,
    baseUrl,
    storageState: parsed.storageState || env.RENDER_STORAGE_STATE || null,
  };
}

export function validateChapterBundle(chapterId, bundle) {
  const chapter = bundle?.chapter;
  const pages = bundle?.pages;
  const voiceover = bundle?.voiceover;
  if (!chapter) throw new Error(`Chapter ${chapterId} was not found.`);
  if (!Array.isArray(pages) || pages.length === 0) {
    throw new Error(`Chapter ${chapterId} has no pages; there is nothing to render.`);
  }
  if (!voiceover) throw new Error(`Chapter ${chapterId} has no voiceover row.`);
  if (typeof voiceover.audio_url !== 'string' || !voiceover.audio_url.trim()) {
    throw new Error(`Chapter ${chapterId} voiceover row has no audio_url.`);
  }

  const durationMs = Number(voiceover.duration_ms);
  if (!Number.isFinite(durationMs) || durationMs <= 0) {
    throw new Error(`Chapter ${chapterId} has an invalid voiceover duration_ms.`);
  }
  if (!Array.isArray(voiceover.timings) || voiceover.timings.length === 0) {
    throw new Error(
      `Chapter ${chapterId} has no page timings (legacy voiceover row). Regenerate its voiceover before rendering.`
    );
  }

  const coveredPages = new Set();
  const timings = voiceover.timings.map((timing, index) => {
    const startMs = Number(timing?.start_ms);
    const segmentDurationMs = Number(timing?.duration_ms);
    if (!Number.isFinite(startMs) || startMs < 0 || !Number.isFinite(segmentDurationMs) || segmentDurationMs <= 0) {
      throw new Error(`Chapter ${chapterId} has an invalid timing entry at index ${index}.`);
    }
    if (startMs + segmentDurationMs > durationMs + DURATION_TOLERANCE_MS) {
      throw new Error(`Chapter ${chapterId} timing ${index} extends beyond duration_ms.`);
    }

    const pageById = timing?.page_id
      ? pages.findIndex((page) => page.id === timing.page_id)
      : -1;
    const requestedIndex = pageById >= 0 ? pageById : Number(timing?.page_index);
    if (!Number.isInteger(requestedIndex) || requestedIndex < 0 || requestedIndex >= pages.length) {
      throw new Error(`Chapter ${chapterId} timing ${index} refers to a missing page.`);
    }
    coveredPages.add(requestedIndex);
    return { pageIndex: requestedIndex, startMs, durationMs: segmentDurationMs };
  });

  const missingPages = pages
    .map((_, index) => index)
    .filter((index) => !coveredPages.has(index));
  if (missingPages.length > 0) {
    throw new Error(
      `Chapter ${chapterId} timings are stale; no timing covers page(s) ${missingPages.map((i) => i + 1).join(', ')}. Regenerate the voiceover.`
    );
  }

  if (pages.some((page) => typeof page?.image_url !== 'string' || !page.image_url)) {
    throw new Error(`Chapter ${chapterId} has a page with no image URL.`);
  }
  if (!chapter.title_id) throw new Error(`Chapter ${chapterId} has no title_id.`);

  return { chapter, pages, voiceover, durationMs, timings };
}

export function assertDurationWithin(actualMs, expectedMs, label) {
  const actual = Number(actualMs);
  const expected = Number(expectedMs);
  if (!Number.isFinite(actual) || !Number.isFinite(expected)) {
    throw new Error(`${label}: duration is not finite (actual=${actualMs}, expected=${expectedMs}).`);
  }
  const deltaMs = Math.abs(actual - expected);
  if (deltaMs > DURATION_TOLERANCE_MS) {
    throw new Error(
      `${label}: duration mismatch is ${Math.round(deltaMs)} ms (actual ${Math.round(actual)} ms, expected ${Math.round(expected)} ms; allowed ±${DURATION_TOLERANCE_MS} ms).`
    );
  }
  return deltaMs;
}

export function inspectWav(input) {
  const buffer = Buffer.isBuffer(input) ? input : Buffer.from(input);
  if (buffer.length < 44 || buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('Downloaded voiceover is not a valid RIFF/WAVE file.');
  }

  let format = null;
  let dataSize = null;
  for (let offset = 12; offset + 8 <= buffer.length;) {
    const chunkId = buffer.toString('ascii', offset, offset + 4);
    const chunkSize = buffer.readUInt32LE(offset + 4);
    const chunkStart = offset + 8;
    const chunkEnd = chunkStart + chunkSize;
    if (chunkEnd > buffer.length) throw new Error(`WAV ${chunkId} chunk is truncated.`);

    if (chunkId === 'fmt ') {
      if (chunkSize < 16) throw new Error('WAV fmt chunk is too short.');
      format = {
        audioFormat: buffer.readUInt16LE(chunkStart),
        channels: buffer.readUInt16LE(chunkStart + 2),
        sampleRate: buffer.readUInt32LE(chunkStart + 4),
        byteRate: buffer.readUInt32LE(chunkStart + 8),
        blockAlign: buffer.readUInt16LE(chunkStart + 12),
        bitsPerSample: buffer.readUInt16LE(chunkStart + 14),
      };
    } else if (chunkId === 'data') {
      dataSize = chunkSize;
    }

    offset = chunkEnd + (chunkSize % 2);
  }

  if (!format || dataSize === null || !format.byteRate || !format.blockAlign) {
    throw new Error('WAV is missing a usable fmt or data chunk.');
  }
  if (format.audioFormat !== 1) throw new Error(`WAV is not uncompressed PCM (format ${format.audioFormat}).`);
  if (format.channels < 1 || format.sampleRate < 1 || format.bitsPerSample < 1) {
    throw new Error('WAV contains invalid PCM format metadata.');
  }

  return {
    ...format,
    dataSize,
    durationMs: (dataSize / format.byteRate) * 1000,
  };
}

export function buildMuxArgs({ webmPath, wavPath, outPath, trimSeconds = 0 }) {
  const seek = Math.max(0, Number(trimSeconds) || 0).toFixed(3);
  return [
    '-y',
    '-ss', seek,
    '-i', webmPath,
    '-i', wavPath,
    '-map', '0:v:0',
    '-map', '1:a:0',
    '-vf', `scale=${VIDEO_SIZE.width}:${VIDEO_SIZE.height}:force_original_aspect_ratio=decrease,pad=${VIDEO_SIZE.width}:${VIDEO_SIZE.height}:(ow-iw)/2:(oh-ih)/2,setsar=1`,
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-crf', '20',
    '-r', '30',
    // Не -fps_mode cfr: бинарь @ffmpeg-installer (N-47683, 2018) его не знает
    // (опция появилась в ffmpeg 5.1). -vsync cfr работает и там, и там.
    '-vsync', 'cfr',
    '-pix_fmt', 'yuv420p',
    '-c:a', 'aac',
    '-b:a', '192k',
    '-shortest',
    '-movflags', '+faststart',
    outPath,
  ];
}

export function buildConcatFile(paths) {
  return paths.map((filePath) => {
    const escaped = path.resolve(filePath).replace(/\\/g, '/').replace(/'/g, "'\\''");
    return `file '${escaped}'`;
  }).join('\n') + '\n';
}

export function buildConcatArgs({ listPath, outPath }) {
  return [
    '-y',
    '-f', 'concat',
    '-safe', '0',
    '-i', listPath,
    '-c', 'copy',
    '-movflags', '+faststart',
    outPath,
  ];
}

export function buildConcatReencodeArgs({ listPath, outPath }) {
  return [
    '-y',
    '-f', 'concat',
    '-safe', '0',
    '-i', listPath,
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-crf', '20',
    '-r', '30',
    '-vsync', 'cfr', // см. buildMuxArgs: -fps_mode не поддержан @ffmpeg-installer
    '-pix_fmt', 'yuv420p',
    '-c:a', 'aac',
    '-b:a', '192k',
    '-movflags', '+faststart',
    outPath,
  ];
}

export async function runRenderWorkflow({
  chapterIds,
  outPath,
  tempDir,
  renderChapter,
  runFfmpeg,
  ffmpegPath,
  writeFileImpl = writeFile,
}) {
  if (!Array.isArray(chapterIds) || chapterIds.length === 0) throw new Error('No chapter IDs to render.');
  if (chapterIds.length === 1) {
    await renderChapter({ chapterId: chapterIds[0], outPath });
    return outPath;
  }

  const clips = [];
  for (let index = 0; index < chapterIds.length; index += 1) {
    const chapterId = chapterIds[index];
    const clipPath = path.join(tempDir, `chapter-${String(index + 1).padStart(3, '0')}-${safeSegment(chapterId)}.mp4`);
    await renderChapter({ chapterId, outPath: clipPath });
    clips.push(clipPath);
  }

  const listPath = path.join(tempDir, 'chapters.concat.txt');
  await writeFileImpl(listPath, buildConcatFile(clips), 'utf8');
  try {
    await runFfmpeg(ffmpegPath, buildConcatArgs({ listPath, outPath }));
  } catch (copyError) {
    // Stream copy only works when every clip shares codec parameters; if a
    // chapter slipped through with different encoding, re-encode the join.
    console.warn(`Stream-copy concat failed (${copyError.message}); retrying with a re-encode.`);
    await runFfmpeg(ffmpegPath, buildConcatReencodeArgs({ listPath, outPath }));
  }
  return outPath;
}

export function resolveFfmpegPath({ env = process.env, requireImpl = require, exists = existsSync } = {}) {
  if (env.FFMPEG_PATH?.trim()) return env.FFMPEG_PATH.trim();
  try {
    const installed = requireImpl('@ffmpeg-installer/ffmpeg');
    if (installed?.path && exists(installed.path)) return installed.path;
  } catch {
    // The installer package is optional at runtime; fall back to system ffmpeg.
  }
  return 'ffmpeg';
}

export function runFfmpeg(executable, args, { spawnImpl = spawn } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnImpl(executable, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    } catch (error) {
      reject(new Error(`Could not start ffmpeg (${executable}): ${error.message}`));
      return;
    }

    let stderr = '';
    child.stderr?.on('data', (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-24_000);
    });
    child.once('error', (error) => {
      reject(new Error(`Could not start ffmpeg (${executable}): ${error.message}`));
    });
    child.once('close', (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      const detail = stderr.trim();
      reject(new Error(
        `ffmpeg failed${signal ? ` (${signal})` : ` with exit code ${code}`}.${detail ? `\n${detail}` : ''}`
      ));
    });
  });
}

function makeRestUrl(supabaseUrl, table, query) {
  const url = new URL(`/rest/v1/${table}`, supabaseUrl);
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, String(value));
  return url;
}

async function fetchRestRows({ supabaseUrl, anonKey, accessToken, table, query, fetchImpl = fetch }) {
  const url = makeRestUrl(supabaseUrl, table, query);
  const response = await fetchImpl(url, {
    headers: {
      apikey: anonKey,
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
    },
    signal: AbortSignal.timeout(45_000),
  });
  const text = await response.text();
  if (!response.ok) {
    let message = text;
    try {
      const data = JSON.parse(text);
      message = data.message || data.error || data.hint || text;
    } catch {
      // Keep the raw, truncated response.
    }
    throw new Error(`Supabase REST ${table} returned HTTP ${response.status}: ${String(message).slice(0, 400)}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Supabase REST ${table} returned invalid JSON.`);
  }
}

export async function fetchChapterBundle({
  chapterId,
  supabaseUrl,
  anonKey,
  accessToken,
  fetchImpl = fetch,
}) {
  const chapterRows = await fetchRestRows({
    supabaseUrl,
    anonKey,
    accessToken,
    table: 'chapters',
    query: { select: 'id,title_id,number', id: `eq.${chapterId}`, limit: '1' },
    fetchImpl,
  });
  const chapter = chapterRows[0];
  if (!chapter) throw new Error(`Chapter ${chapterId} was not found or is not accessible to this admin.`);

  const [pages, voiceovers] = await Promise.all([
    fetchRestRows({
      supabaseUrl,
      anonKey,
      accessToken,
      table: 'pages',
      query: { select: 'id,page_order,image_url', chapter_id: `eq.${chapterId}`, order: 'page_order.asc' },
      fetchImpl,
    }),
    fetchRestRows({
      supabaseUrl,
      anonKey,
      accessToken,
      table: 'chapter_voiceovers',
      query: { select: 'audio_url,duration_ms,timings', chapter_id: `eq.${chapterId}`, limit: '1' },
      fetchImpl,
    }).catch((error) => {
      if (/timings|column/i.test(error.message)) {
        throw new Error('chapter_voiceovers.timings is unavailable; apply migration 16 before rendering.');
      }
      throw error;
    }),
  ]);

  return validateChapterBundle(chapterId, {
    chapter,
    pages,
    voiceover: voiceovers[0] || null,
  });
}

async function readStorageState(filePath) {
  const resolved = path.resolve(filePath);
  try {
    await access(resolved, fsConstants.R_OK);
  } catch {
    throw new Error(`Playwright storage state is not readable: ${resolved}`);
  }
  try {
    return JSON.parse(await readFile(resolved, 'utf8'));
  } catch (error) {
    throw new Error(`Could not parse Playwright storage state ${resolved}: ${error.message}`);
  }
}

async function pageText(page) {
  try {
    return (await page.locator('body').innerText()).slice(0, 800);
  } catch {
    return '';
  }
}

function isAdminPath(url) {
  const pathname = new URL(url).pathname.replace(/\/$/, '');
  return (pathname === '/admin' || pathname.startsWith('/admin/')) &&
    pathname !== '/admin/login' && !pathname.startsWith('/admin/login/');
}

async function tryStoredSession(page, baseUrl) {
  try {
    await page.goto(new URL('/admin', baseUrl).href, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page.waitForFunction(() => {
      const pathname = window.location.pathname.replace(/\/$/, '');
      return pathname === '/admin/login' || pathname.startsWith('/admin/login/') || Boolean(document.querySelector('main h1'));
    }, null, { timeout: 15_000 });
    return isAdminPath(page.url());
  } catch {
    return false;
  }
}

async function waitForCredentialLogin(page, baseUrl, email, password, timeoutMs) {
  await page.goto(new URL('/admin/login', baseUrl).href, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.locator('#email').fill(email);
  await page.locator('#password').fill(password);
  await page.getByRole('button', { name: /Войти/ }).click();

  try {
    await page.waitForFunction(() => {
      const pathname = window.location.pathname.replace(/\/$/, '');
      const body = document.body?.innerText || '';
      return (pathname.startsWith('/admin') && pathname !== '/admin/login' && !pathname.startsWith('/admin/login/')) ||
        /Неверный email или пароль|Нет прав администратора|Вход отклонён|Срок истёк|Сервис недоступен/i.test(body);
    }, null, { timeout: timeoutMs });
  } catch {
    const body = await pageText(page);
    if (/Подтвердите вход|OWNER_NOTIFY_EMAIL/i.test(body)) {
      throw new Error(
        `Login Guard is still waiting for owner email approval after ${timeoutMs} ms. ` +
        'Approve the pending login, then use RENDER_STORAGE_STATE for later renders.'
      );
    }
    throw new Error(`Admin login timed out after ${timeoutMs} ms. Page says: ${body || '(no page text)'}`);
  }

  if (!isAdminPath(page.url())) {
    throw new Error(`Admin login failed: ${await pageText(page) || 'the account is not an approved admin.'}`);
  }
}

async function readAccessToken(page) {
  return page.evaluate(() => {
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      if (!key || !key.startsWith('sb-')) continue;
      try {
        const value = JSON.parse(localStorage.getItem(key) || 'null');
        const token = value?.access_token || value?.currentSession?.access_token || value?.session?.access_token;
        if (typeof token === 'string' && token) return token;
      } catch {
        // Not a Supabase session entry.
      }
    }
    return null;
  });
}

async function authorizeBrowser({ browser, baseUrl, storageStatePath, env }) {
  const email = env.RENDER_ADMIN_EMAIL?.trim();
  const password = env.RENDER_ADMIN_PASSWORD;
  const loginTimeoutMs = nonNegativeEnvNumber(env, 'RENDER_LOGIN_TIMEOUT_MS', DEFAULT_LOGIN_TIMEOUT_MS);
  if ((email && !password) || (!email && password)) {
    throw new Error('Set both RENDER_ADMIN_EMAIL and RENDER_ADMIN_PASSWORD, or use RENDER_STORAGE_STATE.');
  }

  let storageState = null;
  const statePath = storageStatePath || env.RENDER_STORAGE_STATE;
  if (statePath) storageState = await readStorageState(statePath);
  if (!statePath && (!email || !password)) {
    throw new Error(
      'Authentication is required. Set RENDER_STORAGE_STATE or both RENDER_ADMIN_EMAIL and RENDER_ADMIN_PASSWORD in .env.'
    );
  }

  let context = await browser.newContext(storageState ? { storageState } : {});
  let page = await context.newPage();
  let authorized = false;
  try {
    if (storageState) authorized = await tryStoredSession(page, baseUrl);
    if (!authorized && email && password) {
      await context.close();
      context = await browser.newContext();
      page = await context.newPage();
      await waitForCredentialLogin(page, baseUrl, email, password, loginTimeoutMs);
      authorized = true;
    }
    if (!authorized) {
      throw new Error(
        'The storage state is not an active admin session. Refresh it after Login Guard approval or provide admin credentials.'
      );
    }

    const accessToken = await readAccessToken(page);
    if (!accessToken) throw new Error('Could not find an authenticated Supabase access token in browser localStorage.');
    const nextState = await context.storageState();
    return { storageState: nextState, accessToken };
  } finally {
    await context.close().catch(() => undefined);
  }
}

function publicErrorUrl(value) {
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}`;
  } catch {
    return String(value).slice(0, 160);
  }
}

export function assertPageImagesLoaded(expectedCount, thumbnails, failures = []) {
  if (thumbnails.length !== expectedCount) {
    throw new Error(`Page thumbnails did not finish loading (${thumbnails.length}/${expectedCount} found).`);
  }
  const broken = thumbnails.filter((image) => !image.complete || image.naturalWidth === 0);
  if (broken.length > 0 || failures.length > 0) {
    const details = [
      ...broken.map((image) => `${image.alt || 'page image'}: ${publicErrorUrl(image.src)} (naturalWidth=${image.naturalWidth})`),
      ...failures,
    ];
    throw new Error(`One or more chapter page images failed to load: ${[...new Set(details)].join('; ')}`);
  }
}

export function assertSlidesVisited(timings, observedSlides) {
  const expected = new Set(timings.map((timing) => timing.pageIndex + 1));
  const observed = observedSlides instanceof Set ? observedSlides : new Set(observedSlides);
  const missing = [...expected].filter((pageNumber) => !observed.has(pageNumber));
  if (missing.length > 0) {
    throw new Error(`The player did not display page(s) from timings: ${missing.join(', ')}.`);
  }
  return expected;
}

async function fetchSignedWav(url, fetchImpl = fetch) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('The voiceover player did not expose a downloadable signed URL.');
  }
  if (!/^https?:$/.test(parsed.protocol) || !/\/storage\/v1\/object\/sign\/voiceovers\//.test(parsed.pathname)) {
    throw new Error(
      `Expected a private signed voiceover URL, got ${publicErrorUrl(url)}. Check the private voiceovers bucket and migration 16.`
    );
  }

  let response;
  try {
    response = await fetchImpl(url, { signal: AbortSignal.timeout(120_000) });
  } catch (error) {
    const code = error?.cause?.code || error?.code || error?.name || 'network error';
    throw new Error(`Could not download signed WAV from ${publicErrorUrl(url)} (${code}).`);
  }
  if (!response.ok) {
    throw new Error(`Could not download signed WAV (${response.status}) from ${publicErrorUrl(url)}.`);
  }
  const audio = Buffer.from(await response.arrayBuffer());
  if (audio.length === 0) throw new Error('Signed WAV download was empty.');
  return audio;
}

async function renderChapterInBrowser({
  browser,
  baseUrl,
  storageState,
  chapterId,
  bundle,
  outPath,
  tempDir,
  ffmpegPath,
  runFfmpegImpl = runFfmpeg,
  fetchImpl = fetch,
  pageTimeoutMs = DEFAULT_PAGE_TIMEOUT_MS,
  tailMs = DEFAULT_TAIL_MS,
}) {
  const videoDir = path.join(tempDir, `video-${safeSegment(chapterId)}`);
  await mkdir(videoDir, { recursive: true });
  await mkdir(path.dirname(outPath), { recursive: true });

  const context = await browser.newContext({
    storageState,
    viewport: VIDEO_SIZE,
    deviceScaleFactor: 1,
    colorScheme: 'dark',
    locale: 'ru-RU',
    recordVideo: { dir: videoDir, size: VIDEO_SIZE },
  });
  const recordingStartedAt = Date.now();
  const page = await context.newPage();
  const video = page.video();
  if (!video) {
    await context.close();
    throw new Error('Playwright did not create a page video; recordVideo is unavailable.');
  }

  const imageFailures = [];
  const pageErrors = [];
  const seenSlides = new Set();
  let playbackStartedAt = null;
  let wavBufferForMux = null;
  page.on('response', (response) => {
    if (response.request().resourceType() === 'image' && response.status() >= 400) {
      imageFailures.push(`${response.status()} ${publicErrorUrl(response.url())}`);
    }
  });
  page.on('requestfailed', (request) => {
    if (request.resourceType() === 'image') {
      imageFailures.push(`request failed ${publicErrorUrl(request.url())}`);
    }
  });
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.exposeFunction('__renderVideoObserveSlide', (pageNumber) => {
    const value = Number(pageNumber);
    if (Number.isInteger(value) && value > 0) seenSlides.add(value);
  });
  // Node's clock is the single time source for the trim math. Comparing a
  // browser timestamp against Date.now() only works while Chromium is local.
  await page.exposeFunction('__renderVideoAudioStarted', () => {
    if (!playbackStartedAt) playbackStartedAt = Date.now();
  });

  const route = new URL(
    `/admin/titles/${encodeURIComponent(bundle.chapter.title_id)}/chapters/${encodeURIComponent(chapterId)}`,
    baseUrl
  ).href;
  console.log(`Rendering chapter #${bundle.chapter.number ?? '?'} (${chapterId}) -> ${path.basename(outPath)}`);
  try {
    let documentResponse;
    try {
      documentResponse = await page.goto(route, { waitUntil: 'domcontentloaded', timeout: pageTimeoutMs });
    } catch (error) {
      throw new Error(`Could not open admin chapter page ${publicErrorUrl(route)}: ${error.message}`);
    }
    if (documentResponse && documentResponse.status() >= 400) {
      throw new Error(
        `Admin chapter page returned HTTP ${documentResponse.status()}: ${publicErrorUrl(route)}. ` +
        'Check RENDER_BASE_URL and the SPA route fallback.'
      );
    }
    if (!isAdminPath(page.url())) {
      throw new Error('The saved admin session was rejected; refresh the Playwright storage state.');
    }
    try {
      await page.getByRole('heading', { name: /Редактирование главы/ }).waitFor({ state: 'visible', timeout: pageTimeoutMs });
    } catch {
      const body = await pageText(page);
      throw new Error(`Admin chapter editor did not load. ${body || 'The route did not render its chapter heading.'}`);
    }

    const voiceoverHeading = page.getByRole('heading', { name: /ИИ-Озвучка и Запись экрана главы/ });
    await voiceoverHeading.scrollIntoViewIfNeeded();
    await page.waitForSelector('audio', { state: 'attached', timeout: pageTimeoutMs }).catch(async () => {
      const body = await pageText(page);
      throw new Error(`The chapter editor did not load its voiceover player. ${body.slice(-350)}`);
    });

    try {
      await page.waitForFunction((expectedCount) => {
        const images = Array.from(document.querySelectorAll('img[alt^="Стр."]'));
        return images.length === expectedCount && images.every((image) => image.complete);
      }, bundle.pages.length, { timeout: pageTimeoutMs });
    } catch {
      const count = await page.locator('img[alt^="Стр."]').count();
      throw new Error(`Page thumbnails did not finish loading (${count}/${bundle.pages.length} found).`);
    }

    const thumbnails = await page.locator('img[alt^="Стр."]').evaluateAll((images) => images.map((image) => ({
      alt: image.alt,
      src: image.currentSrc || image.src,
      naturalWidth: image.naturalWidth,
      complete: image.complete,
    })));
    assertPageImagesLoaded(bundle.pages.length, thumbnails, imageFailures);

    const staleWarning = await page.getByText(/Список страниц изменился после генерации/).count();
    if (staleWarning > 0) throw new Error('The player reports stale page timings; regenerate the chapter voiceover.');

    const audio = page.locator('audio');
    await page.waitForFunction(() => {
      const player = document.querySelector('audio');
      return Boolean(player && player.readyState >= 1 && Number.isFinite(player.duration));
    }, null, { timeout: pageTimeoutMs }).catch(async () => {
      const state = await audio.evaluate((player) => ({
        readyState: player.readyState,
        duration: player.duration,
        error: player.error?.message || null,
      }));
      throw new Error(`Voiceover audio metadata did not load (readyState=${state.readyState}, error=${state.error || 'none'}). Check signed URL CORS/Storage access.`);
    });

    const browserDurationMs = await audio.evaluate((player) => player.duration * 1000);
    assertDurationWithin(browserDurationMs, bundle.durationMs, `Chapter ${chapterId} HTMLAudioElement`);
    const signedUrl = await audio.evaluate((player) => player.currentSrc || player.src);
    wavBufferForMux = await fetchSignedWav(signedUrl, fetchImpl);
    const wavInfo = inspectWav(wavBufferForMux);
    assertDurationWithin(wavInfo.durationMs, bundle.durationMs, `Chapter ${chapterId} WAV header`);

    await page.evaluate(() => {
      const player = document.querySelector('audio');
      if (player) {
        player.addEventListener('playing', () => {
          void window.__renderVideoAudioStarted();
        }, { once: true });
      }
      let lastPage = null;
      const reportSlide = () => {
        const image = document.querySelector('img[alt^="Слайд"]');
        const match = image?.alt.match(/Слайд\s+(\d+)/);
        if (match && match[1] !== lastPage) {
          lastPage = match[1];
          void window.__renderVideoObserveSlide(Number(match[1]));
        }
      };
      new MutationObserver(reportSlide).observe(document.documentElement, {
        subtree: true,
        childList: true,
        attributes: true,
        attributeFilter: ['alt'],
      });
      reportSlide();
    });

    await page.getByRole('button', { name: 'Воспроизвести', exact: true }).click();
    await page.waitForFunction(() => {
      const player = document.querySelector('audio');
      return Boolean(player && !player.paused);
    }, null, { timeout: 10_000 });
    if (!playbackStartedAt) playbackStartedAt = Date.now();
    // Keep the current comic page inside the fixed 1280x720 capture viewport.
    await page.locator('img[alt^="Слайд"]').scrollIntoViewIfNeeded();

    await page.waitForFunction(() => {
      const player = document.querySelector('audio');
      return Boolean(player && (player.ended || player.error));
    }, null, { timeout: bundle.durationMs + pageTimeoutMs });
    const playbackResult = await audio.evaluate((player) => ({
      ended: player.ended,
      error: player.error?.message || null,
      currentTimeMs: player.currentTime * 1000,
    }));
    if (playbackResult.error) throw new Error(`Voiceover playback failed: ${playbackResult.error}`);
    if (!playbackResult.ended) throw new Error('Voiceover playback stopped before the WAV ended.');

    const elapsedMs = Date.now() - playbackStartedAt;
    const remainingWaitMs = bundle.durationMs + tailMs - elapsedMs;
    if (remainingWaitMs > 0) await page.waitForTimeout(remainingWaitMs);

    assertSlidesVisited(bundle.timings, seenSlides);
    if (pageErrors.length > 0) {
      throw new Error(`Browser page error during playback: ${pageErrors.join('; ')}`);
    }
    if (imageFailures.length > 0) {
      throw new Error(`A page image failed during playback: ${[...new Set(imageFailures)].join('; ')}`);
    }
  } finally {
    await context.close().catch(() => undefined);
  }

  const webmPath = path.join(videoDir, `${safeSegment(chapterId)}.webm`);
  await video.saveAs(webmPath);
  const webmStat = await stat(webmPath).catch(() => null);
  if (!webmStat?.size) throw new Error(`Playwright produced an empty video for chapter ${chapterId}.`);

  if (!Buffer.isBuffer(wavBufferForMux)) {
    throw new Error(`No WAV bytes were retained for chapter ${chapterId}.`);
  }
  const wavPath = path.join(tempDir, `chapter-${safeSegment(chapterId)}.wav`);
  await writeFile(wavPath, wavBufferForMux);
  const trimSeconds = Math.max(0, (playbackStartedAt - recordingStartedAt) / 1000);
  await runFfmpegImpl(ffmpegPath, buildMuxArgs({ webmPath, wavPath, outPath, trimSeconds }));
  return outPath;
}

function readEnvFileValue(fileContents, name) {
  const assignment = fileContents.match(new RegExp(`^\\s*${name}\\s*=\\s*(.*)$`, 'm'));
  if (!assignment) return '';
  let value = assignment[1].trim();
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    value = value.slice(1, -1);
  } else {
    value = value.replace(/\\s+#.*$/, '').trim();
  }
  return value;
}

export async function assertNonProductionTarget({ baseUrl, supabaseUrl, productionEnvPath, allowOverride = false }) {
  let productionConfig = '';
  try {
    productionConfig = await readFile(productionEnvPath, 'utf8');
  } catch {
    return;
  }
  const productionSupabaseUrl = readEnvFileValue(productionConfig, 'VITE_SUPABASE_URL');
  const productionSiteUrl = readEnvFileValue(productionConfig, 'VITE_SITE_URL');
  const targetSupabaseHost = new URL(supabaseUrl).hostname.toLowerCase();
  const targetSiteHost = new URL(baseUrl).hostname.toLowerCase();
  let productionDbHost = '';
  try {
    productionDbHost = productionSupabaseUrl ? new URL(productionSupabaseUrl).hostname.toLowerCase() : '';
  } catch {
    // Ignore malformed production URL; Supabase configuration validation reports the target itself.
  }
  let productionWebHost = '';
  try {
    productionWebHost = productionSiteUrl ? new URL(productionSiteUrl).hostname.toLowerCase() : '';
  } catch {
    // Ignore a malformed canonical URL in the sample deployment config.
  }
  if (productionDbHost && targetSupabaseHost === productionDbHost) {
    const message = 'This renderer is restricted to local/staging data; VITE_SUPABASE_URL matches .env.production.';
    if (!allowOverride) throw new Error(message);
    console.warn(`${message} Proceeding because RENDER_ALLOW_PROD_DB is enabled.`);
    return;
  }
  if (productionWebHost && targetSiteHost === productionWebHost) {
    const message = 'This renderer is restricted to local/staging; RENDER_BASE_URL matches the production site in .env.production.';
    if (!allowOverride) throw new Error(message);
    console.warn(`${message} Proceeding because RENDER_ALLOW_PROD_DB is enabled.`);
  }
}

async function ensureSupabaseConfig(env) {
  const supabaseUrl = env.VITE_SUPABASE_URL?.trim();
  const anonKey = (env.VITE_SUPABASE_ANON_KEY || env.VITE_SUPABASE_PUBLISHABLE_KEY || env.VITE_SUPABASE_PUBLIC_KEY || '').trim();
  if (!supabaseUrl || !anonKey) {
    throw new Error('VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY (or VITE_SUPABASE_PUBLISHABLE_KEY) are required in .env.');
  }
  let parsed;
  try {
    parsed = new URL(supabaseUrl);
    if (!/^https?:$/.test(parsed.protocol)) throw new Error('unsupported protocol');
  } catch {
    throw new Error('VITE_SUPABASE_URL must be a valid http(s) URL.');
  }
  return { supabaseUrl: parsed.origin, anonKey };
}

export async function runRenderMain(argv = process.argv.slice(2), dependencies = {}) {
  if (typeof process.loadEnvFile === 'function') {
    try {
      process.loadEnvFile(path.resolve(process.cwd(), '.env'));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }

  const env = dependencies.env || process.env;
  const options = parseArgs(argv, env);
  if (options.help) {
    console.log(RENDER_HELP.trim());
    return null;
  }

  const baseUrl = options.baseUrl || env.RENDER_BASE_URL || DEFAULT_BASE_URL;
  const { supabaseUrl, anonKey } = await ensureSupabaseConfig(env);
  await assertNonProductionTarget({
    baseUrl,
    supabaseUrl,
    productionEnvPath: path.resolve(process.cwd(), '.env.production'),
    allowOverride: isTruthyEnv(env.RENDER_ALLOW_PROD_DB),
  });
  const ffmpegPath = dependencies.ffmpegPath || resolveFfmpegPath({ env });
  const chromium = dependencies.chromium || (await import('playwright')).chromium;
  const fetchImpl = dependencies.fetchImpl || fetch;
  const spawnFfmpeg = dependencies.runFfmpeg || runFfmpeg;

  const outputPath = path.resolve(options.out);
  await mkdir(path.dirname(outputPath), { recursive: true });
  const tempDir = await mkdtemp(path.join(tmpdir(), 'hikkomanga-render-'));
  let browser;
  try {
    try {
      browser = await chromium.launch({ headless: true });
    } catch (error) {
      if (/Executable doesn't exist|browserType\.launch/i.test(error.message)) {
        throw new Error(`Could not launch Chromium. Install it with: npx playwright install chromium. ${error.message}`);
      }
      throw error;
    }

    const { storageState, accessToken } = await authorizeBrowser({
      browser,
      baseUrl,
      storageStatePath: options.storageState,
      env,
    });

    const bundles = new Map();
    for (const chapterId of options.chapterIds) {
      const bundle = await fetchChapterBundle({
        chapterId,
        supabaseUrl,
        anonKey,
        accessToken,
        fetchImpl,
      });
      bundles.set(chapterId, bundle);
    }

    const renderChapter = ({ chapterId, outPath }) => renderChapterInBrowser({
      browser,
      baseUrl,
      storageState,
      chapterId,
      bundle: bundles.get(chapterId),
      outPath,
      tempDir,
      ffmpegPath,
      runFfmpegImpl: spawnFfmpeg,
      fetchImpl,
      pageTimeoutMs: nonNegativeEnvNumber(env, 'RENDER_PAGE_TIMEOUT_MS', DEFAULT_PAGE_TIMEOUT_MS),
      tailMs: nonNegativeEnvNumber(env, 'RENDER_TAIL_MS', DEFAULT_TAIL_MS),
    });

    await runRenderWorkflow({
      chapterIds: options.chapterIds,
      outPath: outputPath,
      tempDir,
      renderChapter,
      runFfmpeg: spawnFfmpeg,
      ffmpegPath,
    });

    const outputStat = await stat(outputPath).catch(() => null);
    if (!outputStat?.size) throw new Error(`Renderer did not create a non-empty MP4 at ${outputPath}.`);
    console.log(`MP4 saved: ${outputPath}`);
    return outputPath;
  } finally {
    await browser?.close().catch(() => undefined);
    await rm(tempDir, { recursive: true, force: true });
  }
}

const executedDirectly = process.argv[1] &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (executedDirectly) {
  runRenderMain().catch((error) => {
    console.error(`Render failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
