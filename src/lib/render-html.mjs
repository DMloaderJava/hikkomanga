/**
 * Сборка итогового HTML для пререндера (build-time) и динамического рендера
 * (runtime): новые <head>-теги + отрендеренное тело в SPA-шаблон.
 *
 * Файл .mjs (+ render-html.d.ts), чтобы его импортировали и TS-код
 * (src/entry-render.ts через сборку Vite), и обычный Node (scripts/prerender.mjs),
 * и юнит-тесты (node --test) — одна реализация, ноль расхождений.
 */

// Теги, которыми управляет рендер: удаляем дефолтные из шаблона,
// чтобы в <head> не оказалось двух description / canonical.
const MANAGED_META =
  /<meta[^>]*(?:name|property)\s*=\s*"(?:description|robots|og:[^"]*|twitter:[^"]*)"/i;
const MANAGED_LINK = /<link[^>]*rel\s*=\s*"canonical"/i;
const TITLE_TAG = /<title[\s\S]*?<\/title>/i;
const ROOT_MARKER = '<div id="root"></div>';

/**
 * Собирает итоговый HTML: head-теги маршрута + отрендеренное тело приложения.
 * @param {string} template SPA-шаблон (dist/index.html после client-сборки)
 * @param {{ html: string, head: string }} result результат entry-server.prerender()
 * @returns {string}
 */
export function buildHtml(template, result) {
  const withoutManaged = template
    .split('\n')
    .filter(
      (line) =>
        !MANAGED_META.test(line) &&
        !MANAGED_LINK.test(line) &&
        !TITLE_TAG.test(line),
    )
    .join('\n');

  let out = withoutManaged;
  if (out.includes('</head>')) {
    out = out.replace('</head>', `    ${result.head}\n  </head>`);
  } else {
    // На всякий случай: шаблон без </head> — просто дописываем в начало.
    out = out.replace('<head>', `<head>\n    ${result.head}`);
  }

  if (out.includes(ROOT_MARKER)) {
    out = out.replace(ROOT_MARKER, `<div id="root">${result.html}</div>`);
  } else {
    console.warn('[render-html] в шаблоне нет <div id="root"></div> — пропуск вставки.');
  }

  return out;
}
