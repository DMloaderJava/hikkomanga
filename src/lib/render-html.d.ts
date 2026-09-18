/**
 * Типы для src/lib/render-html.mjs (см. комментарий в самом файле:
 * реализация на plain JS, чтобы её импортировали Node-скрипты и edge/node
 * рантаймы без сборки TS).
 */
export declare function buildHtml(
  template: string,
  result: { html: string; head: string },
): string;
