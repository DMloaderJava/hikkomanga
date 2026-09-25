import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  assertDurationWithin,
  assertNonProductionTarget,
  assertPageImagesLoaded,
  assertSlidesVisited,
  buildConcatArgs,
  buildConcatFile,
  buildConcatReencodeArgs,
  buildMuxArgs,
  fetchChapterBundle,
  inspectWav,
  nonNegativeEnvNumber,
  parseArgs,
  resolveFfmpegPath,
  runFfmpeg,
  runRenderWorkflow,
  validateChapterBundle,
} from './render-chapter-video.mjs';

function chapterBundle(overrides = {}) {
  const pages = [
    { id: 'p1', page_order: 1, image_url: 'https://images.example/p1.webp' },
    { id: 'p2', page_order: 2, image_url: 'https://images.example/p2.webp' },
  ];
  return {
    chapter: { id: 'chapter-1', title_id: 'title-1', number: 1 },
    pages,
    voiceover: {
      audio_url: 'chapter-1/audio.wav',
      duration_ms: 2_000,
      timings: [
        { page_id: 'p1', page_index: 0, start_ms: 0, duration_ms: 1_000 },
        { page_id: 'p2', page_index: 1, start_ms: 1_000, duration_ms: 1_000 },
      ],
    },
    ...overrides,
  };
}

function makePcmWav({ sampleRate = 24_000, channels = 1, bitsPerSample = 16, durationMs = 250 } = {}) {
  const bytesPerSample = bitsPerSample / 8;
  const dataSize = Math.round(sampleRate * channels * bytesPerSample * durationMs / 1000);
  const wav = Buffer.alloc(44 + dataSize);
  wav.write('RIFF', 0);
  wav.writeUInt32LE(36 + dataSize, 4);
  wav.write('WAVE', 8);
  wav.write('fmt ', 12);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(channels, 22);
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate * channels * bytesPerSample, 28);
  wav.writeUInt16LE(channels * bytesPerSample, 32);
  wav.writeUInt16LE(bitsPerSample, 34);
  wav.write('data', 36);
  wav.writeUInt32LE(dataSize, 40);
  return wav;
}

test('parseArgs accepts single and ordered multi-chapter modes', () => {
  const single = parseArgs(['--chapter', 'chapter-1']);
  assert.deepEqual(single.chapterIds, ['chapter-1']);
  assert.equal(path.basename(single.out), 'chapter-chapter-1.mp4');

  const chain = parseArgs(['--chapters', 'ch-a, ch-b,ch-c', '--out', './out/chain.mp4']);
  assert.deepEqual(chain.chapterIds, ['ch-a', 'ch-b', 'ch-c']);
  assert.equal(chain.out, path.resolve('./out/chain.mp4'));
  assert.throws(() => parseArgs(['--chapter', 'a', '--chapters', 'b,c']), /either --chapter or --chapters/);
  assert.throws(() => parseArgs(['--chapters', 'a,a']), /duplicate/);
  assert.throws(() => parseArgs(['--chapter', 'a', '--out', './out/result.webm']), /\.mp4/);
  assert.throws(() => parseArgs(['--chapters', 'a,,b']), /no empty IDs/);

  const configured = parseArgs(['--chapter', 'chapter-z'], {
    RENDER_BASE_URL: 'https://staging.example.test/admin/path',
    RENDER_STORAGE_STATE: './.auth/staging.json',
  });
  assert.equal(configured.baseUrl, 'https://staging.example.test');
  assert.equal(configured.storageState, './.auth/staging.json');
});

test('chapter preflight rejects missing voiceover, legacy timings, stale pages and invalid intervals', () => {
  const valid = validateChapterBundle('chapter-1', chapterBundle());
  assert.equal(valid.durationMs, 2_000);
  assert.deepEqual(valid.timings.map((timing) => timing.pageIndex), [0, 1]);

  assert.throws(() => validateChapterBundle('chapter-1', chapterBundle({ voiceover: null })), /no voiceover row/);
  assert.throws(() => validateChapterBundle('chapter-1', chapterBundle({
    voiceover: { audio_url: '', duration_ms: 1000, timings: [] },
  })), /no audio_url/);
  assert.throws(() => validateChapterBundle('chapter-1', chapterBundle({
    voiceover: { audio_url: 'old.wav', duration_ms: 1000, timings: [] },
  })), /legacy voiceover row/);
  assert.throws(() => validateChapterBundle('chapter-1', chapterBundle({
    voiceover: {
      audio_url: 'audio.wav', duration_ms: 2000,
      timings: [{ page_id: 'p1', page_index: 0, start_ms: 0, duration_ms: 2000 }],
    },
  })), /stale/);
  assert.throws(() => validateChapterBundle('chapter-1', chapterBundle({
    voiceover: {
      audio_url: 'audio.wav', duration_ms: 1000,
      timings: [{ page_id: 'p1', page_index: 0, start_ms: 0, duration_ms: 1200 }],
    },
  })), /extends beyond/);
});

test('WAV parser validates PCM metadata and duration tolerance is inclusive at 100 ms', () => {
  const wav = makePcmWav({ durationMs: 250 });
  const info = inspectWav(wav);
  assert.equal(info.audioFormat, 1);
  assert.equal(info.channels, 1);
  assert.equal(info.sampleRate, 24_000);
  assert.equal(info.bitsPerSample, 16);
  assert.equal(info.durationMs, 250);
  assert.equal(assertDurationWithin(2_100, 2_000, 'browser'), 100);
  assert.throws(() => assertDurationWithin(2_101, 2_000, 'browser'), /allowed ±100 ms/);
  assert.throws(() => inspectWav(Buffer.from('not a wav')), /not a valid RIFF\/WAVE/);
});

test('image and slide assertions surface missing image loads and unvisited timed pages', () => {
  assertPageImagesLoaded(2, [
    { alt: 'Стр. 1', src: 'https://images.example/1', complete: true, naturalWidth: 40 },
    { alt: 'Стр. 2', src: 'https://images.example/2', complete: true, naturalWidth: 40 },
  ]);
  assert.throws(() => assertPageImagesLoaded(2, [
    { alt: 'Стр. 1', src: 'https://images.example/1', complete: true, naturalWidth: 0 },
    { alt: 'Стр. 2', src: 'https://images.example/2', complete: true, naturalWidth: 40 },
  ]), /failed to load/);
  assert.throws(() => assertPageImagesLoaded(2, [
    { alt: 'Стр. 1', src: 'https://images.example/1', complete: false, naturalWidth: 0 },
    { alt: 'Стр. 2', src: 'https://images.example/2', complete: true, naturalWidth: 40 },
  ], ['404 https://images.example/1']), /404/);

  const timings = [{ pageIndex: 0 }, { pageIndex: 1 }];
  assertSlidesVisited(timings, new Set([1, 2]));
  assert.throws(() => assertSlidesVisited(timings, new Set([1])), /did not display page\(s\) from timings: 2/);
});

test('mux command trims setup frames and encodes 1280x720 at constant 30 fps with AAC', () => {
  const args = buildMuxArgs({ webmPath: '/tmp/in.webm', wavPath: '/tmp/in.wav', outPath: '/tmp/out.mp4', trimSeconds: 2.3456 });
  assert.deepEqual(args.slice(0, 5), ['-y', '-ss', '2.346', '-i', '/tmp/in.webm']);
  assert.ok(args.includes('libx264'));
  assert.ok(args.includes('30'));
  // -vsync cfr, не -fps_mode: бандловый @ffmpeg-installer (2018) не знает -fps_mode.
  assert.ok(args.includes('-vsync'));
  assert.equal(args[args.indexOf('-vsync') + 1], 'cfr');
  assert.ok(!args.includes('-fps_mode'));
  assert.ok(args.includes('aac'));
  assert.ok(args.includes('192k'));
  assert.ok(args.includes('-shortest'));
  assert.equal(args.at(-1), '/tmp/out.mp4');
});

test('ffmpeg resolver prefers installer, then explicit/system fallback', () => {
  assert.equal(resolveFfmpegPath({
    env: {},
    requireImpl: () => ({ path: '/vendor/ffmpeg' }),
    exists: (candidate) => candidate === '/vendor/ffmpeg',
  }), '/vendor/ffmpeg');
  assert.equal(resolveFfmpegPath({
    env: { FFMPEG_PATH: '/custom/ffmpeg' },
    requireImpl: () => { throw new Error('unused'); },
  }), '/custom/ffmpeg');
  assert.equal(resolveFfmpegPath({
    env: {},
    requireImpl: () => { throw new Error('optional dependency absent'); },
  }), 'ffmpeg');
});

test('multi-chapter orchestration uses mocked Playwright renders then ffmpeg concat in order', async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), 'render-orchestrator-test-'));
  const outPath = path.join(tempDir, 'joined.mp4');
  const renderCalls = [];
  const ffmpegCalls = [];
  let concatContents = '';

  // Mock Playwright adapter: each call stands for one chapter UI capture + WAV mux.
  const mockPlaywright = {
    async renderChapter({ chapterId, outPath: clipPath }) {
      renderCalls.push({ chapterId, clipPath });
      await writeFile(clipPath, Buffer.from(`mock mp4 ${chapterId}`));
    },
  };
  // Mock ffmpeg process: read the concat demuxer list and create its output.
  const mockFfmpeg = async (executable, args) => {
    ffmpegCalls.push({ executable, args });
    assert.deepEqual(buildConcatArgs({ listPath: args[args.indexOf('-i') + 1], outPath }), args);
    concatContents = await readFile(args[args.indexOf('-i') + 1], 'utf8');
    await writeFile(args.at(-1), Buffer.from('mock concatenated mp4'));
  };

  try {
    await runRenderWorkflow({
      chapterIds: ['chapter-a', 'chapter-b', 'chapter-c'],
      outPath,
      tempDir,
      renderChapter: mockPlaywright.renderChapter,
      runFfmpeg: mockFfmpeg,
      ffmpegPath: 'mock-ffmpeg',
    });
    assert.deepEqual(renderCalls.map((call) => call.chapterId), ['chapter-a', 'chapter-b', 'chapter-c']);
    assert.equal(ffmpegCalls.length, 1);
    assert.equal(ffmpegCalls[0].executable, 'mock-ffmpeg');
    assert.match(concatContents, /chapter-001-chapter-a\.mp4/);
    assert.match(concatContents, /chapter-002-chapter-b\.mp4/);
    assert.match(concatContents, /chapter-003-chapter-c\.mp4/);
    assert.equal(await readFile(outPath, 'utf8'), 'mock concatenated mp4');
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('single-chapter workflow delegates once and does not run concat ffmpeg', async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), 'render-single-test-'));
  const outPath = path.join(tempDir, 'chapter.mp4');
  let renderCount = 0;
  let ffmpegCount = 0;
  try {
    await runRenderWorkflow({
      chapterIds: ['chapter-one'],
      outPath,
      tempDir,
      renderChapter: async ({ chapterId, outPath: target }) => {
        renderCount += 1;
        assert.equal(chapterId, 'chapter-one');
        await writeFile(target, 'mock chapter mp4');
      },
      runFfmpeg: async () => { ffmpegCount += 1; },
      ffmpegPath: 'mock-ffmpeg',
    });
    assert.equal(renderCount, 1);
    assert.equal(ffmpegCount, 0);
    assert.equal(await readFile(outPath, 'utf8'), 'mock chapter mp4');
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('runFfmpeg can be exercised with a mocked child process', async () => {
  const child = new EventEmitter();
  child.stderr = new EventEmitter();
  let spawnArgs;
  const finished = runFfmpeg('mock-ffmpeg', ['-version'], {
    spawnImpl: (executable, args, options) => {
      spawnArgs = { executable, args, options };
      queueMicrotask(() => child.emit('close', 0, null));
      return child;
    },
  });
  await finished;
  assert.equal(spawnArgs.executable, 'mock-ffmpeg');
  assert.deepEqual(spawnArgs.args, ['-version']);
  assert.deepEqual(spawnArgs.options.stdio, ['ignore', 'ignore', 'pipe']);
});

test('concat demuxer input escapes paths and preserves chapter order', () => {
  // Конкатенатор сам резолвит переданные пути в абсолютные и нормализует их
  // в прямые слэши, поэтому ожидать конкретный корень (/tmp) нельзя: на Windows
  // это диск текущего проекта. Проверяем форму строк `file '…'`, порядок глав
  // и экранирование кавычки в имени файла.
  const first = path.resolve('one.mp4');
  const second = path.resolve("two's.mp4");
  const list = buildConcatFile([first, second]);
  const [line1, line2] = list.trim().split('\n');
  assert.match(line1, /^file '.*one\.mp4'$/);
  assert.match(line2, /two'\\''s\.mp4/);
});

test('multi-chapter concat falls back to a re-encode when stream copy fails', async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), 'render-concat-fallback-test-'));
  const outPath = path.join(tempDir, 'joined.mp4');
  const ffmpegCalls = [];
  const originalWarn = console.warn;

  const mockFfmpeg = async (executable, args) => {
    ffmpegCalls.push({ executable, args });
    if (ffmpegCalls.length === 1) {
      assert.deepEqual(buildConcatArgs({ listPath: args[args.indexOf('-i') + 1], outPath }), args);
      throw new Error('mock ffmpeg: stream copy failed');
    }
    assert.deepEqual(buildConcatReencodeArgs({ listPath: args[args.indexOf('-i') + 1], outPath }), args);
    assert.ok(args.includes('libx264'));
    await writeFile(args.at(-1), Buffer.from('mock re-encoded mp4'));
  };

  try {
    console.warn = () => undefined;
    await runRenderWorkflow({
      chapterIds: ['chapter-a', 'chapter-b'],
      outPath,
      tempDir,
      renderChapter: async ({ chapterId, outPath: clipPath }) => {
        await writeFile(clipPath, Buffer.from(`mock mp4 ${chapterId}`));
      },
      runFfmpeg: mockFfmpeg,
      ffmpegPath: 'mock-ffmpeg',
    });
    assert.equal(ffmpegCalls.length, 2);
    assert.equal(await readFile(outPath, 'utf8'), 'mock re-encoded mp4');
  } finally {
    console.warn = originalWarn;
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('production guard blocks .env.production hosts unless explicitly overridden', async () => {
  const configDir = await mkdtemp(path.join(tmpdir(), 'render-prod-guard-test-'));
  const productionEnvPath = path.join(configDir, '.env.production');
  await writeFile(productionEnvPath, [
    'VITE_SUPABASE_URL=https://prod-project.supabase.co',
    'VITE_SITE_URL=https://www.prod-site.example',
    '',
  ].join('\n'));
  const originalWarn = console.warn;

  try {
    await assert.rejects(
      assertNonProductionTarget({
        baseUrl: 'http://127.0.0.1:5173',
        supabaseUrl: 'https://prod-project.supabase.co',
        productionEnvPath,
      }),
      /matches \.env\.production/
    );
    await assert.rejects(
      assertNonProductionTarget({
        baseUrl: 'https://www.prod-site.example',
        supabaseUrl: 'https://staging-project.supabase.co',
        productionEnvPath,
      }),
      /RENDER_BASE_URL matches the production site/
    );
    await assertNonProductionTarget({
      baseUrl: 'http://127.0.0.1:5173',
      supabaseUrl: 'https://staging-project.supabase.co',
      productionEnvPath,
    });

    console.warn = () => undefined;
    await assertNonProductionTarget({
      baseUrl: 'http://127.0.0.1:5173',
      supabaseUrl: 'https://prod-project.supabase.co',
      productionEnvPath,
      allowOverride: true,
    });

    await assertNonProductionTarget({
      baseUrl: 'https://prod-project.supabase.co',
      supabaseUrl: 'https://prod-project.supabase.co',
      productionEnvPath: path.join(configDir, 'missing.env'),
    });
  } finally {
    console.warn = originalWarn;
    await rm(configDir, { recursive: true, force: true });
  }
});

test('nonNegativeEnvNumber keeps explicit zero and falls back on missing or invalid values', () => {
  assert.equal(nonNegativeEnvNumber({}, 'X_TIMEOUT', 5_000), 5_000);
  assert.equal(nonNegativeEnvNumber({ X_TIMEOUT: '0' }, 'X_TIMEOUT', 5_000), 0);
  assert.equal(nonNegativeEnvNumber({ X_TIMEOUT: '12000' }, 'X_TIMEOUT', 5_000), 12_000);
  assert.equal(nonNegativeEnvNumber({ X_TIMEOUT: 'soon' }, 'X_TIMEOUT', 5_000), 5_000);
  assert.equal(nonNegativeEnvNumber({ X_TIMEOUT: '-1' }, 'X_TIMEOUT', 5_000), 5_000);
});

test('fetchChapterBundle queries pages ordered by page_order with admin bearer headers', async () => {
  const requests = [];
  const restJson = (rows) => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify(rows),
  });
  const fetchImpl = async (url, options = {}) => {
    const parsed = new URL(url);
    const table = parsed.pathname.split('/').pop();
    requests.push({ table, search: parsed.searchParams, headers: options.headers });
    if (table === 'chapters') return restJson([{ id: 'chapter-1', title_id: 'title-1', number: 3 }]);
    if (table === 'pages') return restJson([
      { id: 'p1', page_order: 1, image_url: 'https://images.example/p1.webp' },
      { id: 'p2', page_order: 2, image_url: 'https://images.example/p2.webp' },
    ]);
    if (table === 'chapter_voiceovers') return restJson([{
      audio_url: 'chapter-1/audio.wav',
      duration_ms: 2_000,
      timings: [
        { page_id: 'p1', page_index: 0, start_ms: 0, duration_ms: 1_000 },
        { page_id: 'p2', page_index: 1, start_ms: 1_000, duration_ms: 1_000 },
      ],
    }]);
    throw new Error(`Unexpected table ${table}`);
  };

  const bundle = await fetchChapterBundle({
    chapterId: 'chapter-1',
    supabaseUrl: 'https://staging-project.supabase.co',
    anonKey: 'anon-key',
    accessToken: 'admin-token',
    fetchImpl,
  });

  assert.equal(bundle.durationMs, 2_000);
  assert.deepEqual(bundle.timings.map((timing) => timing.pageIndex), [0, 1]);
  const pagesRequest = requests.find((request) => request.table === 'pages');
  assert.equal(pagesRequest.search.get('chapter_id'), 'eq.chapter-1');
  assert.equal(pagesRequest.search.get('order'), 'page_order.asc');
  for (const request of requests) {
    assert.equal(request.headers.apikey, 'anon-key');
    assert.equal(request.headers.Authorization, 'Bearer admin-token');
  }
});

test('admin DOM contract: every renderer selector is pinned to the frontend sources', async () => {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const [player, sortList, chapterRoute] = await Promise.all([
    readFile(path.join(repoRoot, 'src/components/admin/VoiceoverPlayer.tsx'), 'utf8'),
    readFile(path.join(repoRoot, 'src/components/admin/PageSortList.tsx'), 'utf8'),
    readFile(path.join(repoRoot, 'src/routes/admin.titles.$id.chapters.$cid.tsx'), 'utf8'),
  ]);
  // render-скрипт: img[alt^="Слайд"] + /Слайд\s+(\d+)/
  assert.match(player, /alt=\{`Слайд \$\{/);
  // render-скрипт: img[alt^="Стр."]
  assert.match(sortList, /alt=\{`Стр\. \$\{/);
  // render-скрипт: getByRole('heading', { name: /Редактирование главы/ })
  assert.match(chapterRoute, /<h1[\s\S]{0,200}?Редактирование главы/);
  // render-скрипт: getByRole('button', { name: 'Воспроизвести' }) — доступное имя из текста кнопки
  assert.match(player, /<Play[^>]*\/>\s*Воспроизвести/);
});
