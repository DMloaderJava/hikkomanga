/**
 * Юнит-тесты массового импорта глав: CSV, парсер имён файлов, сортировка,
 * конфликты номеров (src/lib/chaptersImport.ts — чистый модуль без DOM/Supabase).
 *
 *   npm run test:chapters-import
 *
 * Кейсы:
 *   1. CSV: заголовок опционален, number,name[,description], кавычки, ; и tab;
 *   2. битые строки не валят весь разбор — ошибки с номером строки;
 *   3. сортировка глав числовая (2 < 10), не лексикографическая;
 *   4. дубликаты номеров определяются;
 *   5. имена файлов: {ch}.{pg}, {ch}/{pg}, {ch}-{pg}, ch-{n}-page-{m}, {ch}.pdf;
 *   6. группировка по главам, дубли страницы и лишний PDF → unmatched;
 *   7. план импорта: глава без файлов, файлы без главы, нераспознанные имена.
 */
import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';

const failures = [];
const check = (name, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  if (!cond) failures.push(name);
};

const server = await createServer({
  // fileURLToPath, а не URL.pathname: на Windows `.pathname` даёт '/D:/…',
  // и Vite делает из этого несуществующий 'D:\D:\…' → ENOENT при mkdir .vite.
  root: fileURLToPath(new URL('..', import.meta.url)),
  envFile: false,
  server: { middlewareMode: true },
  appType: 'custom',
  logLevel: 'error',
});

try {
  const mod = await server.ssrLoadModule('/src/lib/chaptersImport.ts');
  const {
    parseCsvLine,
    parseChaptersCsv,
    parsePageFileName,
    groupPageFiles,
    buildImportPlan,
    findDuplicateNumbers,
    sortChapterRows,
    formatBytes,
  } = mod;

  const file = (name, size = 1024, relPath = '') => {
    const f = new File([new Uint8Array(Math.min(size, 64))], name);
    if (size !== f.size) Object.defineProperty(f, 'size', { value: size });
    if (relPath) Object.defineProperty(f, 'webkitRelativePath', { value: relPath });
    return f;
  };

  // ── 1. CSV ──────────────────────────────────────────────────────────────
  {
    const withHeader = parseChaptersCsv(
      'number,name,description\n1,Начало пути,Знакомство\n2,Первый бой\n'
    );
    check('1a. заголовок распознан и пропущен', withHeader.headerSkipped === true);
    check('1b. строки разобраны', withHeader.rows.length === 2, JSON.stringify(withHeader.rows));
    check(
      '1c. описание опционально',
      withHeader.rows[0].description === 'Знакомство' && withHeader.rows[1].description === ''
    );
    check('1d. ошибок нет', withHeader.errors.length === 0, withHeader.errors.join('; '));

    const withoutHeader = parseChaptersCsv('1,Начало пути\n2,Первый бой');
    check('2a. без заголовка тоже работает', withoutHeader.headerSkipped === false && withoutHeader.rows.length === 2);

    // «number,1» — не заголовок (вторая ячейка числовая): строка уходит в данные
    // и падает в ошибки разбора, а не молча съедается как шапка.
    const numericFirst = parseChaptersCsv('number,1\n2,Второй');
    check(
      '2b. «number,1» не считается заголовком',
      numericFirst.headerSkipped === false &&
        numericFirst.rows.length === 1 &&
        numericFirst.errors.length === 1,
      JSON.stringify({ rows: numericFirst.rows.length, errors: numericFirst.errors })
    );
  }

  {
    const quoted = parseCsvLine('3,"Глава, с запятой","Он сказал: ""привет"""');
    check(
      '3a. кавычки RFC4180',
      quoted[0] === '3' && quoted[1] === 'Глава, с запятой' && quoted[2] === 'Он сказал: "привет"',
      JSON.stringify(quoted)
    );
    check('3b. разделитель ; ', parseCsvLine('4;Четвёртая;описание')[1] === 'Четвёртая');
    check('3c. разделитель tab', parseCsvLine('5\tПятая')[1] === 'Пятая');
  }

  {
    const broken = parseChaptersCsv('1,Норм\nabc,Битая\n2\n3,Ок,описание');
    check('4a. битые строки — в ошибки, не в исключение', broken.errors.length === 1, broken.errors.join('; '));
    check('4b. ошибка указывает номер строки', /Строка 2/.test(broken.errors[0] ?? ''), broken.errors[0]);
    check(
      '4c. остальные строки разобраны',
      JSON.stringify(broken.rows.map((r) => r.number)) === '[1,2,3]',
      JSON.stringify(broken.rows.map((r) => r.number))
    );

    const empty = parseChaptersCsv('   \n\n');
    check('4d. пустой CSV — понятная ошибка', empty.rows.length === 0 && empty.errors.length === 1, empty.errors[0]);

    const fractional = parseChaptersCsv('1.5,Дробный');
    check('4e. дробный номер отклонён', fractional.rows.length === 0 && /целым/.test(fractional.errors[0] ?? ''));
  }

  // ── 2. Сортировка и конфликты ───────────────────────────────────────────
  {
    const rows = [
      { number: 10, name: '', description: '', line: 1 },
      { number: 2, name: '', description: '', line: 2 },
      { number: 1, name: '', description: '', line: 3 },
    ];
    check(
      '5a. сортировка числовая, не лексикографическая',
      JSON.stringify(sortChapterRows(rows).map((r) => r.number)) === '[1,2,10]'
    );
    check(
      '5b. CSV отдаёт главы отсортированными',
      JSON.stringify(parseChaptersCsv('10,Десятая\n2,Вторая\n1,Первая').rows.map((r) => r.number)) === '[1,2,10]'
    );
    check(
      '5c. дубликаты номеров видны',
      JSON.stringify(findDuplicateNumbers([{ number: 1 }, { number: 2 }, { number: 1 }])) === '[1]'
    );
    check('5d. без дубликатов — пустой список', findDuplicateNumbers([{ number: 1 }, { number: 2 }]).length === 0);
  }

  // ── 3. Имена файлов ─────────────────────────────────────────────────────
  {
    const cases = [
      ['1.2.jpg', 1, 2, false],
      ['01.02.png', 1, 2, false],
      ['3/7.webp', 3, 7, false],
      ['12-4.jpg', 12, 4, false],
      ['ch-5-page-11.webp', 5, 11, false],
      ['ch-5-page-11', 5, 11, false],
      ['folder/2/9.jpg', 2, 9, false],
      ['7.pdf', 7, 0, true],
      ['ch-7.pdf', 7, 0, true],
    ];
    let allOk = true;
    for (const [name, chapter, page, pdf] of cases) {
      const parsed = parsePageFileName(name);
      if (!parsed || parsed.chapter !== chapter || parsed.page !== page || parsed.pdf !== pdf) {
        allOk = false;
        console.log(`   → ${name}: ${JSON.stringify(parsed)}`);
      }
    }
    check('6a. все шаблоны имён распознаются', allOk, cases.map((c) => c[0]).join(', '));

    const badNames = ['глава1.jpg', 'page-1.jpg', '1.jpg', '', 'archive.zip', '1.2.3.jpg'];
    const badParsed = badNames
      .map((name) => [name, parsePageFileName(name)])
      .filter(([, parsed]) => parsed !== null);
    check(
      '6b. мусорные имена не распознаются',
      badParsed.length === 0,
      badParsed.map(([n, r]) => `${n}→${JSON.stringify(r)}`).join(', ')
    );
  }

  // ── 4. Группировка ──────────────────────────────────────────────────────
  {
    const grouped = groupPageFiles([
      file('2.1.jpg'),
      file('1.2.jpg'),
      file('1.1.jpg'),
      file('1.10.jpg'),
      file('1.pdf'),
      file('обложка.png'),
    ]);
    check('7a. главы сгруппированы', grouped.groups.size === 2, [...grouped.groups.keys()].join(','));
    check(
      '7b. страницы главы 1 отсортированы по номеру',
      JSON.stringify(grouped.groups.get(1).pages.map((p) => p.page)) === '[1,2,10]'
    );
    check('7c. PDF вынесен отдельно', grouped.groups.get(1).pdf?.name === '1.pdf');
    check('7d. нераспознанное имя — в unmatched', grouped.unmatched.map((f) => f.name).includes('обложка.png'));

    const dupes = groupPageFiles([file('1.1.jpg'), file('1.1.png'), file('1.pdf'), file('1.pdf')]);
    check(
      '8a. дубль страницы → unmatched',
      dupes.unmatched.some((f) => f.name === '1.1.png') && dupes.groups.get(1).pages.length === 1,
      dupes.unmatched.map((f) => f.name).join(',')
    );
    check('8b. второй PDF главы → unmatched', dupes.unmatched.some((f) => f.name === '1.pdf'));

    const rel = groupPageFiles([file('2.jpg', 1024, '5/2.jpg')]);
    check('8c. webkitRelativePath приоритетнее имени', rel.groups.get(5)?.pages.length === 1);
  }

  // ── 5. План импорта ─────────────────────────────────────────────────────
  {
    const rows = [
      { number: 1, name: 'Первая', description: '', line: 1 },
      { number: 2, name: 'Вторая', description: '', line: 2 },
    ];
    const grouped = groupPageFiles([file('1.1.jpg'), file('1.2.jpg'), file('3.1.jpg'), file('мусор.txt')]);
    const plan = buildImportPlan(rows, grouped);

    check('9a. план по строкам CSV', plan.items.length === 2);
    check('9b. глава с файлами привязана', plan.items[0].group?.pages.length === 2);
    check('9c. глава без файлов — без группы', plan.items[1].group === null);
    check(
      '9d. предупреждение о главе без файлов',
      plan.warnings.some((w) => /Глава 2: нет файлов/.test(w)),
      plan.warnings.join(' | ')
    );
    check(
      '9e. предупреждение о файлах без главы в CSV',
      plan.warnings.some((w) => /главы 3/.test(w)),
      plan.warnings.join(' | ')
    );
    check(
      '9f. предупреждение о нераспознанных именах',
      plan.warnings.some((w) => /Не распознано имён: 1/.test(w)),
      plan.warnings.join(' | ')
    );

    const dupPlan = buildImportPlan(
      [
        { number: 1, name: 'a', description: '', line: 1 },
        { number: 1, name: 'b', description: '', line: 2 },
      ],
      { groups: new Map(), unmatched: [] }
    );
    check('9g. дубликаты номеров помечены', dupPlan.items.every((i) => i.duplicate === true));
  }

  check('10a. formatBytes: килобайты', formatBytes(2048) === '2 kB', formatBytes(2048));
  check('10b. formatBytes: мегабайты', formatBytes(3 * 1024 * 1024) === '3.0 MB', formatBytes(3 * 1024 * 1024));
} finally {
  await server.close();
}

console.log('');
if (failures.length) {
  console.error(`unit-chapters-import: провалено ${failures.length}: ${failures.join(', ')}`);
  process.exit(1);
}
console.log('unit-chapters-import: все проверки пройдены');
