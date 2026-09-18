/**
 * Отдельная SSR-сборка для динамического рендеринга ботов.
 *
 *   vite build --config vite.ssr.config.ts   →  dist-ssr/render.mjs
 *
 * Особенности:
 *  - entry — src/entry-render.ts: рендер маршрута + SPA-шаблон, вшитый
 *    `?raw`-импортом готового dist/index.html. Поэтому SSR-сборка всегда
 *    запускается ПОСЛЕ клиентской (`vite build`) — см. npm run build.
 *  - ssr.noExternal + inlineDynamicImports: один самодостаточный .mjs без
 *    внешних зависимостей — Vercel-функция api/render.mjs просто импортирует
 *    его, и nft трассирует ровно один файл.
 *  - import.meta.env.VITE_* инлайнятся на этапе сборки (как в клиенте).
 */
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { TanStackRouterVite } from '@tanstack/router-plugin/vite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  // public/ в SSR-бандле не нужен: статику раскладывает клиентская сборка
  publicDir: false,
  plugins: [
    TanStackRouterVite({
      target: 'react',
      autoCodeSplitting: true,
      routesDirectory: './src/routes',
      generatedRouteTree: './src/routeTree.gen.ts',
    }),
    react(),
  ],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  // Всё в один бандл: react-dom/server, supabase-js и т.д.
  ssr: {
    noExternal: true,
  },
  build: {
    ssr: 'src/entry-render.ts',
    outDir: 'dist-ssr',
    target: 'node22',
    minify: true,
    rollupOptions: {
      output: {
        format: 'es',
        entryFileNames: 'render.mjs',
        // единственный entry → склейка динамических импортов роутов в один файл
        codeSplitting: false,
      },
    },
  },
});
