import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { TanStackRouterVite } from '@tanstack/router-plugin/vite';
import { buildLoginMailHtml, buildLoginMailSubject } from './src/lib/loginMailTemplate.ts';
import path from 'path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const geminiApiKey = env.GEMINI_API_KEY || process.env.GEMINI_API_KEY;

  return {
    plugins: [
      TanStackRouterVite({
        target: 'react',
        autoCodeSplitting: true,
        routesDirectory: './src/routes',
        generatedRouteTree: './src/routeTree.gen.ts',
      }),
      react(),
      {
        name: 'gemini-proxy-middleware',
        configureServer(server) {
          server.middlewares.use(async (req, res, next) => {
            // 1. Analyze endpoint
            if (req.url?.startsWith('/api/gemini/analyze') && req.method === 'POST') {
              if (!geminiApiKey) {
                res.statusCode = 500;
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({ error: 'GEMINI_API_KEY is not configured in .env' }));
                return;
              }

              let bodyStr = '';
              req.on('data', (chunk) => (bodyStr += chunk));
              req.on('end', async () => {
                try {
                  const { imageBase64, mimeType } = JSON.parse(bodyStr);
                  const promptText = `Ты — анализатор манги. Извлеки все диалоговые облака и закадровый текст со страницы. Верни СТРОГО чистый JSON массив без кода или markdown: [{"speaker":"Speaker1","text":"..."}]`;

                  const googleRes = await fetch(
                    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${geminiApiKey}`,
                    {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({
                        contents: [
                          {
                            parts: [
                              { text: promptText },
                              { inline_data: { mime_type: mimeType || 'image/jpeg', data: imageBase64 } },
                            ],
                          },
                        ],
                      }),
                    }
                  );

                  const data = await googleRes.json();
                  res.statusCode = googleRes.status;
                  res.setHeader('Content-Type', 'application/json');
                  res.end(JSON.stringify(data));
                } catch (err: any) {
                  res.statusCode = 500;
                  res.setHeader('Content-Type', 'application/json');
                  res.end(JSON.stringify({ error: err.message }));
                }
              });
              return;
            }

            // 2. TTS Endpoint
            if (req.url?.startsWith('/api/gemini/tts') && req.method === 'POST') {
              if (!geminiApiKey) {
                res.statusCode = 500;
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({ error: 'GEMINI_API_KEY is not configured in .env' }));
                return;
              }

              let bodyStr = '';
              req.on('data', (chunk) => (bodyStr += chunk));
              req.on('end', async () => {
                try {
                  const { lines, voiceMap } = JSON.parse(bodyStr);
                  const textInput = (lines || [])
                    .map((l: any) => `${l.speaker || 'Narrator'}: ${l.text || ''}`)
                    .join('\n');

                  const speechConfig = Object.entries(voiceMap || {}).map(([speaker, voice]) => ({
                    speaker,
                    voiceConfig: { prebuiltVoiceConfig: { voiceName: voice || 'Kore' } },
                  }));

                  const googleRes = await fetch(
                    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-tts:generateContent?key=${geminiApiKey}`,
                    {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({
                        contents: [{ parts: [{ text: textInput }] }],
                        generationConfig: {
                          responseModalities: ['AUDIO'],
                          speechConfig:
                            speechConfig.length > 0
                              ? { multiSpeakerVoiceConfig: { speakerVoiceConfigs: speechConfig } }
                              : undefined,
                        },
                      }),
                    }
                  );

                  const data = await googleRes.json();
                  res.statusCode = googleRes.status;
                  res.setHeader('Content-Type', 'application/json');
                  res.end(JSON.stringify(data));
                } catch (err: any) {
                  res.statusCode = 500;
                  res.setHeader('Content-Type', 'application/json');
                  res.end(JSON.stringify({ error: err.message }));
                }
              });
              return;
            }

            next();
          });
        },
      },
      {
        name: 'login-notify-middleware',
        configureServer(server) {
          server.middlewares.use(async (req, res, next) => {
            if (!req.url?.startsWith('/api/login-notify') || req.method !== 'POST') {
              return next();
            }

            const send = (code: number, obj: unknown) => {
              res.statusCode = code;
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify(obj));
            };

            let bodyStr = '';
            req.on('data', (chunk) => (bodyStr += chunk));
            req.on('end', async () => {
              try {
                const payload = JSON.parse(bodyStr || '{}');
                const to = env.OWNER_NOTIFY_EMAIL || process.env.OWNER_NOTIFY_EMAIL;
                const apiKey = env.RESEND_API_KEY || process.env.RESEND_API_KEY;
                const from =
                  env.OWNER_NOTIFY_FROM ||
                  process.env.OWNER_NOTIFY_FROM ||
                  'Hikkomanga Login Guard <onboarding@resend.dev>';

                if (!to) {
                  send(500, { ok: false, error: 'OWNER_NOTIFY_EMAIL не задан в .env' });
                  return;
                }

                const subject = buildLoginMailSubject(payload);
                const html = buildLoginMailHtml(payload);

                // Без ключа Resend письмо некуда слать — эмулируем:
                // печатаем в консоль dev-сервера и отдаём preview клиенту.
                if (!apiKey) {
                  console.log(`\n[login-notify] ЭМУЛЯЦИЯ письма → ${to}\n${subject}\n`);
                  send(200, { ok: true, emulated: true, preview: { to, from, subject, html } });
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
                send(200, { ok: true, id: (data as any)?.id });
              } catch (err: any) {
                send(500, { ok: false, error: err.message });
              }
            });
          });
        },
      },
    ],
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
