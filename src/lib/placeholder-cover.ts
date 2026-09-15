/**
 * Генерирует SVG-плейсхолдер обложки прямо в памяти — без сетевых запросов
 * и без файлов с чужими авторскими правами в репозитории.
 *
 * Возвращает data URL, который можно подставить в <img src=...> напрямую.
 */

/** Цветовые пары [градиент-от, градиент-до] для разнообразия обложек */
const PALETTES: [string, string][] = [
  ['#1a1a2e', '#16213e'], // тёмно-синий
  ['#1a0a2e', '#2d1b69'], // фиолетовый
  ['#0a1628', '#1e3a5f'], // морской
  ['#1a0a0a', '#4a1010'], // тёмно-красный
  ['#0a1a0a', '#1a3a1a'], // тёмно-зелёный
];

/** Иконка книги (упрощённый path, не требует lucide) */
const BOOK_ICON = `
  <rect x="28" y="20" width="44" height="56" rx="3" fill="none"
        stroke="currentColor" stroke-width="2.5" opacity="0.4"/>
  <rect x="32" y="20" width="40" height="56" rx="3" fill="none"
        stroke="currentColor" stroke-width="2.5" opacity="0.6"/>
  <line x1="40" y1="32" x2="64" y2="32" stroke="currentColor"
        stroke-width="2" opacity="0.5"/>
  <line x1="40" y1="40" x2="64" y2="40" stroke="currentColor"
        stroke-width="2" opacity="0.4"/>
  <line x1="40" y1="48" x2="56" y2="48" stroke="currentColor"
        stroke-width="2" opacity="0.3"/>
`.trim();

/**
 * @param title  Название тайтла — отображается на плейсхолдере и влияет на цвет
 * @param width  Ширина SVG в пикселях (по умолчанию 300)
 * @param height Высота SVG в пикселях (по умолчанию 420, соотношение ~2:3)
 */
export function generatePlaceholderCover(
  title: string,
  width = 300,
  height = 420
): string {
  // Детерминированный выбор палитры по сумме кодов символов заголовка —
  // один и тот же тайтл всегда получает один и тот же цвет.
  const charSum = [...title].reduce((acc, ch) => acc + ch.charCodeAt(0), 0);
  const [colorFrom, colorTo] = PALETTES[charSum % PALETTES.length];

  // Инициалы: первые буквы первых двух слов
  const words = title.trim().split(/\s+/);
  const initials = words
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? '')
    .join('');

  // Обрезаем длинные заголовки многоточием
  const displayTitle = title.length > 24 ? title.slice(0, 22) + '…' : title;

  // Центр SVG
  const cx = width / 2;
  const cy = height / 2;

  const svg = `
<svg xmlns="http://www.w3.org/2000/svg"
     width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0.5" y2="1">
      <stop offset="0%" stop-color="${colorFrom}"/>
      <stop offset="100%" stop-color="${colorTo}"/>
    </linearGradient>
  </defs>

  <!-- Фон -->
  <rect width="${width}" height="${height}" fill="url(#bg)"/>

  <!-- Лёгкая текстура: диагональные линии -->
  <line x1="0" y1="0" x2="${width}" y2="${height}"
        stroke="white" stroke-width="0.5" opacity="0.03"/>
  <line x1="${width}" y1="0" x2="0" y2="${height}"
        stroke="white" stroke-width="0.5" opacity="0.03"/>

  <!-- Иконка книги по центру, смещена вверх -->
  <g transform="translate(${cx - 50}, ${cy - 60}) scale(1.1)"
     color="white">
    ${BOOK_ICON}
  </g>

  <!-- Инициалы поверх иконки -->
  <text x="${cx}" y="${cy - 18}"
        font-family="system-ui, sans-serif"
        font-size="28" font-weight="700"
        fill="white" opacity="0.85"
        text-anchor="middle" dominant-baseline="middle">
    ${initials}
  </text>

  <!-- Разделитель -->
  <line x1="${cx - 40}" y1="${cy + 10}" x2="${cx + 40}" y2="${cy + 10}"
        stroke="white" stroke-width="1" opacity="0.2"/>

  <!-- Название тайтла -->
  <text x="${cx}" y="${cy + 30}"
        font-family="system-ui, sans-serif"
        font-size="13" font-weight="500"
        fill="white" opacity="0.6"
        text-anchor="middle" dominant-baseline="middle">
    ${escapeXml(displayTitle)}
  </text>
</svg>`.trim();

  // encodeURIComponent безопаснее btoa для Unicode-строк
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
