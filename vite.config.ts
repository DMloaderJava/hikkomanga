import { localPdfAssets } from './build-plugins/pdf-assets.ts';
import { localHeicWorker } from './build-plugins/heic-worker.ts';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { TanStackRouterVite } from '@tanstack/router-plugin/vite';
import { visualizer } from 'rollup-plugin-visualizer';
import {
  buildLoginMailHtml,
  buildLoginMailSubject,
} from './supabase/functions/_shared/loginMailTemplate.ts';
import { generateLoginChallengeToken } from './supabase/functions/_shared/loginChallengeToken.ts';
// Тот же сборщик запросов к Gemini, что и в edge-функции gemini-proxy:
// dev-middleware и прод не разъезжаются по модели/форме запроса.
import {
  GEMINI_ANALYZE_MODEL,
  GEMINI_TTS_MODEL,
  TtsPlanError,
  buildTtsResponse,
  extractTtsAudio,
  geminiEndpoint,
  geminiErrorMessage,
  geminiHeaders,
  mergeTtsAudio,
  planTtsRequests,
} from './supabase/functions/_shared/gemini-tts.ts';
import path from 'path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Dev-хранилище challenge'ей (без Supabase). Файл в .gitignore-зоне .local. */
const DEV_CHALLENGES_PATH = path.resolve(__dirname, '.local/login-challenges.json');

type DevChallenge = {
  id: string;
  token: string;
  status: 'pending' | 'approved' | 'denied' | 'expired';
  adminEmail?: string;
  createdAt: string;
  expiresAt: string;
  resolvedAt?: string;
};

function readDevChallenges(): DevChallenge[] {
  try {
    if (!fs.existsSync(DEV_CHALLENGES_PATH)) return [];
    return JSON.parse(fs.readFileSync(DEV_CHALLENGES_PATH, 'utf8')) as DevChallenge[];
  } catch {
    return [];
  }
}

function writeDevChallenges(list: DevChallenge[]) {
  fs.mkdirSync(path.dirname(DEV_CHALLENGES_PATH), { recursive: true });
  fs.writeFileSync(DEV_CHALLENGES_PATH, JSON.stringify(list, null, 2));
}

function resolveDevChallenge(
  token: string,
  action: 'approve' | 'deny'
): { ok: boolean; status: string } {
  const list = readDevChallenges();
  const idx = list.findIndex((c) => c.token === token);
  if (idx < 0) return { ok: false, status: 'not_found' };
  const ch = list[idx];
  if (ch.status === 'approved') return { ok: true, status: 'already_approved' };
  if (ch.status === 'denied') return { ok: true, status: 'already_denied' };
  if (ch.status === 'expired' || new Date(ch.expiresAt).getTime() < Date.now()) {
    if (ch.status === 'pending') {
      ch.status = 'expired';
      ch.resolvedAt = new Date().toISOString();
      list[idx] = ch;
      writeDevChallenges(list);
    }
    return { ok: false, status: 'expired' };
  }
  ch.status = action === 'approve' ? 'approved' : 'denied';
  ch.resolvedAt = new Date().toISOString();
  list[idx] = ch;
  writeDevChallenges(list);
  return { ok: true, status: ch.status };
}

export default defineConfig(({ mode }) => {
  // Третий аргумент '' обязателен: без него loadEnv вернёт только VITE_*,
  // а GEMINI_API_KEY / RESEND_API_KEY / OWNER_NOTIFY_EMAIL — серверные секреты.
  const env = loadEnv(mode, process.cwd(), '');
  const geminiApiKey = env.GEMINI_API_KEY || process.env.GEMINI_API_KEY;
  // Адрес владельца для Login Guard.
  // Fail-fast: без OWNER_NOTIFY_EMAIL (и без placeholder) — не шлём в void.
  // Placeholder owner@example.com / *@example.com запрещены (тихий bounce).
  const rawOwnerEmail = (
    env.OWNER_NOTIFY_EMAIL ||
    process.env.OWNER_NOTIFY_EMAIL ||
    ''
  ).trim();
  const ownerNotifyEmail = (() => {
    if (!rawOwnerEmail) {
      console.warn(
        '[login-notify] OWNER_NOTIFY_EMAIL не задан — dev-мидлварь эмулирует, но письмо никуда не уйдёт. Задайте в .env'
      );
      return '';
    }
    if (/@example\.(com|org|net)$/i.test(rawOwnerEmail) || rawOwnerEmail === 'owner@example.com') {
      console.warn(
        `[login-notify] OWNER_NOTIFY_EMAIL=${rawOwnerEmail} — placeholder. Задайте реальный адрес владельца в .env`
      );
      return '';
    }
    return rawOwnerEmail;
  })();

  return {
    plugins: [
      localHeicWorker(),
      localPdfAssets(),
      TanStackRouterVite({
        target: 'react',
        autoCodeSplitting: true,
        routesDirectory: './src/routes',
        generatedRouteTree: './src/routeTree.gen.ts',
      }),
      react(),
      ...(process.env.ANALYZE === 'true'
        ? [
            visualizer({
              filename: 'dist/stats.html',
              open: false,
              gzipSize: true,
              brotliSize: true,
              template: 'treemap',
            }),
          ]
        : []),
      {
        name: 'gemini-proxy-middleware',
        configureServer(server) {
          server.middlewares.use(async (req, res, next) => {
            // Формат ответов — как у edge-функции gemini-proxy: успех = сырой
            // ответ Gemini, ошибка = { error, code, message } с понятным текстом.
            const sendJson = (status: number, body: unknown) => {
              res.statusCode = status;
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify(body));
            };

            const readJsonBody = () =>
              new Promise<any>((resolve, reject) => {
                let bodyStr = '';
                req.on('data', (chunk) => (bodyStr += chunk));
                req.on('end', () => {
                  try {
                    resolve(bodyStr ? JSON.parse(bodyStr) : {});
                  } catch (error) {
                    reject(error);
                  }
                });
              });

            // 1. Analyze endpoint
            if (req.url?.startsWith('/api/gemini/analyze') && req.method === 'POST') {
              if (!geminiApiKey) {
                sendJson(500, { error: 'GEMINI_API_KEY is not configured in .env' });
                return;
              }

              try {
                const { imageBase64, mimeType } = await readJsonBody();
                const promptText = `Ты — анализатор манги. Извлеки все диалоговые облака и закадровый текст со страницы. Верни СТРОГО чистый JSON массив без кода или markdown: [{"speaker":"Speaker1","text":"..."}]`;

                const googleRes = await fetch(geminiEndpoint(GEMINI_ANALYZE_MODEL), {
                  method: 'POST',
                  headers: geminiHeaders(geminiApiKey),
                  body: JSON.stringify({
                    contents: [
                      {
                        parts: [
                          { text: promptText },
                          { inlineData: { mimeType: mimeType || 'image/jpeg', data: imageBase64 } },
                        ],
                      },
                    ],
                  }),
                });

                const data = await googleRes.json().catch(() => null);
                if (!googleRes.ok) {
                  sendJson(502, {
                    error: 'gemini_upstream_error',
                    code: 'gemini_upstream_error',
                    status: googleRes.status,
                    message: `Анализ страницы не удался: ${geminiErrorMessage(data, `Gemini API вернул ${googleRes.status}`)}`,
                  });
                  return;
                }

                sendJson(200, data);
              } catch (err: any) {
                sendJson(500, { error: err.message });
              }
              return;
            }

            // 2. TTS Endpoint
            if (req.url?.startsWith('/api/gemini/tts') && req.method === 'POST') {
              if (!geminiApiKey) {
                sendJson(500, { error: 'GEMINI_API_KEY is not configured in .env' });
                return;
              }

              try {
                const { lines, voiceMap } = await readJsonBody();

                let plan: ReturnType<typeof planTtsRequests>;
                try {
                  plan = planTtsRequests(lines, voiceMap);
                } catch (error) {
                  if (error instanceof TtsPlanError) {
                    sendJson(400, { error: error.code, code: error.code, message: error.message });
                    return;
                  }
                  throw error;
                }

                // Чанк = максимум 2 голоса (лимит Gemini 3.8 TTS); порядок
                // реплик сохраняется, PCM склеивается на клиенте в один WAV.
                const audioChunks: string[] = [];
                for (const chunk of plan) {
                  const googleRes = await fetch(geminiEndpoint(GEMINI_TTS_MODEL), {
                    method: 'POST',
                    headers: geminiHeaders(geminiApiKey),
                    body: JSON.stringify(chunk.body),
                  });

                  const data = await googleRes.json().catch(() => null);
                  if (!googleRes.ok) {
                    sendJson(502, {
                      error: 'gemini_upstream_error',
                      code: 'gemini_upstream_error',
                      status: googleRes.status,
                      message: `Озвучка не удалась: ${geminiErrorMessage(data, `Gemini API вернул ${googleRes.status}`)}`,
                    });
                    return;
                  }

                  const audio = extractTtsAudio(data);
                  if (!audio) {
                    sendJson(502, { error: 'gemini_tts_empty', code: 'gemini_tts_empty', message: 'Gemini вернул ответ без аудио.' });
                    return;
                  }

                  audioChunks.push(audio);
                }

                sendJson(200, buildTtsResponse(mergeTtsAudio(audioChunks)));
              } catch (err: any) {
                sendJson(500, { error: err.message });
              }
              return;
            }

            next();
          });
        },
      },
      {
        name: 'login-guard-middleware',
        configureServer(server) {
          server.middlewares.use(async (req, res, next) => {
            const url = req.url?.split('?')[0] || '';

            const send = (code: number, obj: unknown) => {
              res.statusCode = code;
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify(obj));
            };

            // GET /api/login-challenge-status?id=... — polling в dev без Supabase
            if (url === '/api/login-challenge-status' && req.method === 'GET') {
              try {
                const u = new URL(req.url || '', 'http://localhost');
                const id = u.searchParams.get('id') || '';
                const list = readDevChallenges();
                let ch = id
                  ? list.find((c) => c.id === id)
                  : list.slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
                if (!ch) {
                  send(200, { status: 'none' });
                  return;
                }
                if (ch.status === 'pending' && new Date(ch.expiresAt).getTime() < Date.now()) {
                  ch = { ...ch, status: 'expired', resolvedAt: new Date().toISOString() };
                  writeDevChallenges(list.map((c) => (c.id === ch!.id ? ch! : c)));
                }
                send(200, { status: ch.status, id: ch.id, expiresAt: ch.expiresAt });
              } catch (err: any) {
                send(500, { status: 'error', error: err.message });
              }
              return;
            }

            // POST /api/login-confirm — approve/deny по токену (dev, без Supabase)
            if (url === '/api/login-confirm' && req.method === 'POST') {
              let bodyStr = '';
              req.on('data', (chunk) => (bodyStr += chunk));
              req.on('end', () => {
                try {
                  const body = JSON.parse(bodyStr || '{}') as {
                    token?: string;
                    action?: string;
                  };
                  const token = (body.token || '').trim();
                  const action = (body.action || '').trim().toLowerCase();
                  if (!token || (action !== 'approve' && action !== 'deny')) {
                    send(400, {
                      ok: false,
                      status: 'invalid_action',
                      error: 'token and action=approve|deny required',
                    });
                    return;
                  }
                  const result = resolveDevChallenge(
                    token,
                    action as 'approve' | 'deny'
                  );
                  send(result.ok ? 200 : 400, result);
                } catch (err: any) {
                  send(500, { ok: false, status: 'error', error: err.message });
                }
              });
              return;
            }

            // POST /api/login-notify — создать challenge + письмо
            if (url !== '/api/login-notify' || req.method !== 'POST') {
              return next();
            }

            let bodyStr = '';
            req.on('data', (chunk) => (bodyStr += chunk));
            req.on('end', async () => {
              try {
                const payload = JSON.parse(bodyStr || '{}');
                // Без реального email — эмуляция с пометкой; prod edge fn fail-fast 500.
                const to = ownerNotifyEmail || 'UNSET_OWNER_NOTIFY_EMAIL';
                const apiKey = env.RESEND_API_KEY || process.env.RESEND_API_KEY;
                const from =
                  env.OWNER_NOTIFY_FROM ||
                  process.env.OWNER_NOTIFY_FROM ||
                  'Hikkomanga Login Guard <onboarding@resend.dev>';

                const confirmToken = generateLoginChallengeToken();
                const now = Date.now();
                const challenge: DevChallenge = {
                  id: `ch-${now}`,
                  token: confirmToken,
                  status: 'pending',
                  adminEmail: payload.adminEmail,
                  createdAt: new Date(now).toISOString(),
                  expiresAt: new Date(now + 15 * 60 * 1000).toISOString(),
                };
                // Гасим предыдущие pending
                const prev = readDevChallenges().map((c) =>
                  c.status === 'pending'
                    ? { ...c, status: 'expired' as const, resolvedAt: new Date().toISOString() }
                    : c
                );
                writeDevChallenges([...prev, challenge]);

                const mailPayload = { ...payload, confirmToken };
                const subject = buildLoginMailSubject(mailPayload);
                const html = buildLoginMailHtml(mailPayload);
                const site = String(payload.siteUrl || '').replace(/\/$/, '');
                const approveUrl = site
                  ? `${site}/admin/login/confirm?token=${encodeURIComponent(confirmToken)}&action=approve`
                  : undefined;
                const denyUrl = site
                  ? `${site}/admin/login/confirm?token=${encodeURIComponent(confirmToken)}&action=deny`
                  : undefined;

                // Без ключа Resend — эмуляция: консоль + preview со ссылками.
                if (!apiKey) {
                  console.log(
                    `\n[login-notify] ЭМУЛЯЦИЯ письма → ${to}\n${subject}\n` +
                      `  approve: ${approveUrl}\n  deny:    ${denyUrl}\n` +
                      `  token:   ${confirmToken}\n`
                  );
                  send(200, {
                    ok: true,
                    emulated: true,
                    challengeId: challenge.id,
                    preview: { to, from, subject, html, approveUrl, denyUrl },
                  });
                  return;
                }

                const resendRes = await fetch('https://api.resend.com/emails', {
                  method: 'POST',
                  headers: {
                    Authorization: `Bearer ${apiKey}`,
                    'Content-Type': 'application/json',
                  },
                  body: JSON.stringify({ from, to: [to], subject, html }),
                });
                const data = await resendRes.json().catch(() => null);
                if (!resendRes.ok) {
                  send(502, {
                    ok: false,
                    error: (data as any)?.message || `Resend HTTP ${resendRes.status}`,
                  });
                  return;
                }
                send(200, {
                  ok: true,
                  challengeId: challenge.id,
                  id: (data as any)?.id,
                });
              } catch (err: any) {
                send(500, { ok: false, error: err.message });
              }
            });
          });
        },
      },
    ],
    // Какие env-переменные Vite вшивает в бандл. Кроме родных `VITE_*`
    // принимаем `NEXT_PUBLIC_*`: проекты, заведённые на хостинге по шаблону
    // Next.js, держат Supabase-ключи под этими именами
    // (`NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_ANON_KEY`).
    // Префикс `SUPABASE_` здесь отсутствует сознательно — иначе в браузерный
    // бандл утёк бы `SUPABASE_SERVICE_ROLE_KEY`. Публичные ключи читаются в
    // `src/integrations/supabase/config.ts`.
    envPrefix: ['VITE_', 'NEXT_PUBLIC_'],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, './src'),
      },
    },
    server: {
      host: '0.0.0.0',
      port: 3000,
      allowedHosts: true,
    },
    build: {
      target: 'es2022',
      rollupOptions: {
        output: {
          manualChunks(id) {
            if (id.includes('node_modules')) {
              if (
                id.includes('node_modules/react/') ||
                id.includes('node_modules/react-dom/') ||
                id.includes('node_modules/scheduler/')
              ) {
                return 'vendor-react';
              }
              if (
                id.includes('node_modules/@tanstack/react-router') ||
                id.includes('node_modules/@tanstack/react-query') ||
                id.includes('node_modules/@tanstack/router-core') ||
                id.includes('node_modules/@tanstack/query-core')
              ) {
                return 'vendor-tanstack';
              }
              if (id.includes('node_modules/@supabase/')) {
                return 'vendor-supabase';
              }
              if (
                id.includes('node_modules/lucide-react/') ||
                id.includes('node_modules/clsx/') ||
                id.includes('node_modules/tailwind-merge/') ||
                id.includes('node_modules/class-variance-authority/')
              ) {
                return 'vendor-ui';
              }
            }
          },
        },
      },
    },
    optimizeDeps: {
      include: [
        'react',
        'react-dom',
        '@tanstack/react-router',
        '@tanstack/react-query',
        'lucide-react',
        'clsx',
        'tailwind-merge',
        '@dnd-kit/core',
        '@dnd-kit/sortable',
        '@dnd-kit/utilities',
        '@supabase/supabase-js',
      ],
    },
  };
});
