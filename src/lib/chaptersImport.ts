/**
 * Чистые помощники массового импорта глав и заявок на главы.
 *
 * Никакого React/DOM/Supabase — модуль грузится юнит-тестами
 * (scripts/unit-chapters-import.mjs) через Vite SSR и переиспользуется
 * роутом /admin/titles/$id/chapters/import и модалками подачи заявок.
 *
 * Форматы имён файлов (ТЗ):
 *   {ch}.{pg}.{ext}   1.2.jpg
 *   {ch}/{pg}.{ext}   1/2.jpg  (webkitRelativePath при дропе папки)
 *   {ch}-{pg}.{ext}   1-2.jpg
 *   {ch}.pdf          1.pdf    (глава целиком, разбивается на страницы)
 * плюс каноническое имя заявки: ch-{n}-page-{m}.{ext}.
 */

import { naturalCompare } from './imageFormats';

export interface CsvChapterRow {
  number: number;
  name: string;
  description: string;
  /** Номер строки в исходном тексте (1-based) — для сообщений об ошибках. */
  line: number;
}

export interface ParsedCsv {
  rows: CsvChapterRow[];
  errors: string[];
  /** Первая строка была распознана как заголовок и пропущена. */
  headerSkipped: boolean;
}

export interface GroupedPageFile {
  page: number;
  file: File;
}

export interface ChapterFileGroup {
  pages: GroupedPageFile[];
  pdf: File | null;
}

export interface GroupedFiles {
  /** Ключ — номер главы. */
  groups: Map<number, ChapterFileGroup>;
  /** Файлы, имя которых не подошло ни под один шаблон. */
  unmatched: File[];
}

export interface ImportPlanItem {
  row: CsvChapterRow;
  group: ChapterFileGroup | null;
  /** Номер встречается в CSV больше одного раза. */
  duplicate: boolean;
}

export interface ImportPlan {
  items: ImportPlanItem[];
  /** Главы из CSV без файлов и файлы без главы в CSV. */
  warnings: string[];
}

// ── CSV ──────────────────────────────────────────────────────────────────────

const HEADER_RE = /^(number|num|no|chapter|гл\.?|глава|номер|№)$/i;

/**
 * Одна строка CSV: запятая, точка с запятой или таб как разделитель,
 * кавычки по правилам RFC 4180 ("" внутри кавычек = литеральная кавычка).
 */
export function parseCsvLine(line: string): string[] {
  const cells: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i];
    if (inQuotes) {
      if (c === '"') {
        if (line[i + 1] === '"') {
          current += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        current += c;
      }
      continue;
    }
    if (c === '"') {
      inQuotes = true;
    } else if (c === ',' || c === ';' || c === '\t') {
      cells.push(current);
      current = '';
    } else {
      current += c;
    }
  }
  cells.push(current);
  return cells.map((c) => c.trim());
}

/**
 * Разбор CSV `number,name[,description]`. Заголовок опционален: первая строка
 * пропускается, если её первая ячейка — «number/номер/глава/№», а вторая не число.
 * Битые строки не валят весь импорт — собираются в errors с номером строки.
 */
export function parseChaptersCsv(text: string): ParsedCsv {
  const rows: CsvChapterRow[] = [];
  const errors: string[] = [];
  let headerSkipped = false;

  const lines = String(text ?? '')
    .replace(/\r\n?/g, '\n')
    .split('\n');

  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i];
    if (!raw.trim()) continue;
    const cells = parseCsvLine(raw);
    const lineNo = i + 1;

    if (!headerSkipped && rows.length === 0 && HEADER_RE.test(cells[0] ?? '')) {
      const secondIsNumber = Number(cells[1]) > 0;
      if (!secondIsNumber) {
        headerSkipped = true;
        continue;
      }
    }

    const numberText = (cells[0] ?? '').replace(',', '.');
    const number = Number(numberText);
    if (!numberText || !Number.isFinite(number) || number <= 0) {
      errors.push(`Строка ${lineNo}: «${cells[0] ?? ''}» — не номер главы`);
      continue;
    }
    if (!Number.isInteger(number)) {
      errors.push(`Строка ${lineNo}: номер главы должен быть целым (${numberText})`);
      continue;
    }

    rows.push({
      number,
      name: cells[1] ?? '',
      description: cells[2] ?? '',
      line: lineNo,
    });
  }

  if (rows.length === 0 && errors.length === 0) {
    errors.push('В CSV нет ни одной строки формата number,name[,description]');
  }
  return { rows: sortChapterRows(rows), errors, headerSkipped };
}

/** Сортировка глав по номеру (числовая, не лексикографическая). */
export function sortChapterRows(rows: CsvChapterRow[]): CsvChapterRow[] {
  return rows.slice().sort((a, b) => a.number - b.number);
}

/** Номера, которые встречаются в списке больше одного раза. */
export function findDuplicateNumbers(rows: Array<{ number: number }>): number[] {
  const counts = new Map<number, number>();
  for (const r of rows) counts.set(r.number, (counts.get(r.number) ?? 0) + 1);
  return [...counts.entries()]
    .filter(([, n]) => n > 1)
    .map(([number]) => number)
    .sort((a, b) => a - b);
}

// ── Имена файлов ─────────────────────────────────────────────────────────────

/**
 * Разбор имени файла страницы/ PDF.
 * Пробуем шаблоны по убыванию специфичности: сначала каноническое
 * ch-{n}-page-{m}, затем {ch}/{pg}, {ch}.{pg}, {ch}-{pg}, в конце {ch}.pdf.
 */
export function parsePageFileName(
  name: string
): { chapter: number; page: number; ext: string; pdf: boolean } | null {
  const clean = String(name ?? '').trim().replace(/\\/g, '/');
  if (!clean) return null;

  const canonical = /(?:^|\/)ch-(\d{1,6})-page-(\d{1,4})(?:\.([A-Za-z0-9]+))?$/.exec(clean);
  if (canonical) {
    return {
      chapter: Number(canonical[1]),
      page: Number(canonical[2]),
      ext: (canonical[3] ?? '').toLowerCase(),
      pdf: false,
    };
  }

  const slashed = /(?:^|\/)(\d{1,6})\/(\d{1,4})(?:\.([A-Za-z0-9]+))?$/.exec(clean);
  if (slashed) {
    return {
      chapter: Number(slashed[1]),
      page: Number(slashed[2]),
      ext: (slashed[3] ?? '').toLowerCase(),
      pdf: false,
    };
  }

  const dotted = /(?:^|\/)(\d{1,6})\.(\d{1,4})\.([A-Za-z0-9]+)$/.exec(clean);
  if (dotted) {
    return {
      chapter: Number(dotted[1]),
      page: Number(dotted[2]),
      ext: dotted[3].toLowerCase(),
      pdf: false,
    };
  }

  const dashed = /(?:^|\/)(\d{1,6})-(\d{1,4})(?:\.([A-Za-z0-9]+))?$/.exec(clean);
  if (dashed) {
    return {
      chapter: Number(dashed[1]),
      page: Number(dashed[2]),
      ext: (dashed[3] ?? '').toLowerCase(),
      pdf: false,
    };
  }

  const pdf = /(?:^|\/)ch-(\d{1,6})\.pdf$/i.exec(clean) ?? /(?:^|\/)(\d{1,6})\.pdf$/i.exec(clean);
  if (pdf) {
    return { chapter: Number(pdf[1]), page: 0, ext: 'pdf', pdf: true };
  }

  return null;
}

/**
 * Группировка файлов по главам. Внутри главы страницы сортируются по номеру
 * из имени; PDF кладётся отдельно (глава может прийти и картинками, и PDF —
 * тогда PDF считается дополнительным оригиналом, страницы важнее).
 */
export function groupPageFiles(files: File[]): GroupedFiles {
  const groups = new Map<number, ChapterFileGroup>();
  const unmatched: File[] = [];

  for (const file of files) {
    // webkitRelativePath даёт «1/2.jpg» при дропе папки — берём его, если есть.
    const relPath = (file as File & { webkitRelativePath?: string }).webkitRelativePath;
    const name = relPath || file.name;
    const parsed = parsePageFileName(name);
    if (!parsed) {
      unmatched.push(file);
      continue;
    }
    let group = groups.get(parsed.chapter);
    if (!group) {
      group = { pages: [], pdf: null };
      groups.set(parsed.chapter, group);
    }
    if (parsed.pdf) {
      // Несколько PDF на главу — берём первый, остальные в unmatched (видны в отчёте).
      if (group.pdf) unmatched.push(file);
      else group.pdf = file;
      continue;
    }
    if (group.pages.some((p) => p.page === parsed.page)) {
      unmatched.push(file);
      continue;
    }
    group.pages.push({ page: parsed.page, file });
  }

  for (const group of groups.values()) {
    group.pages.sort((a, b) => a.page - b.page);
  }
  return { groups, unmatched };
}

/** Сопоставление строк CSV с файлами + человекочитаемые предупреждения. */
export function buildImportPlan(
  rows: CsvChapterRow[],
  grouped: GroupedFiles
): ImportPlan {
  const duplicates = new Set(findDuplicateNumbers(rows));
  const knownNumbers = new Set(rows.map((r) => r.number));
  const warnings: string[] = [];

  const items: ImportPlanItem[] = sortChapterRows(rows).map((row) => {
    const group = grouped.groups.get(row.number) ?? null;
    if (!group) {
      warnings.push(`Глава ${row.number}: нет файлов — глава не будет создана`);
    } else if (group.pages.length === 0 && !group.pdf) {
      warnings.push(`Глава ${row.number}: файлы не распознаны как страницы`);
    }
    return { row, group, duplicate: duplicates.has(row.number) };
  });

  for (const [chapterNumber, group] of grouped.groups) {
    if (!knownNumbers.has(chapterNumber)) {
      const count = group.pages.length + (group.pdf ? 1 : 0);
      warnings.push(
        `Файлы главы ${chapterNumber} (${count} шт.) не импортируются: такой главы нет в CSV`
      );
    }
  }

  if (grouped.unmatched.length > 0) {
    warnings.push(
      `Не распознано имён: ${grouped.unmatched.length} (${grouped.unmatched
        .slice(0, 5)
        .map((f) => f.name)
        .join(', ')}${grouped.unmatched.length > 5 ? ', …' : ''}). ` +
        'Ожидались {глава}.{страница}.{ext}, {глава}/{страница}.{ext}, {глава}-{страница}.{ext} или {глава}.pdf'
    );
  }

  return { items, warnings };
}

/** Суммарный размер файлов группы (для показа в превью). */
export function groupBytes(group: ChapterFileGroup | null): number {
  if (!group) return 0;
  return (
    group.pages.reduce((sum, p) => sum + p.file.size, 0) + (group.pdf?.size ?? 0)
  );
}

/** Человекочитаемый размер. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 kB';
  const mb = bytes / 1024 / 1024;
  if (mb >= 1) return `${mb.toFixed(mb >= 10 ? 0 : 1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} kB`;
}

/** Сортировка файлов страниц по «естественному» порядку имён. */
export function sortFilesByName(files: File[]): File[] {
  return files.slice().sort((a, b) => naturalCompare(a.name, b.name));
}
