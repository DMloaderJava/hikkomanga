/**
 * Интеграционный тест админ-кнопок: «нажимается — реакции нет»?
 *
 *   npm i --no-save jsdom   # разовая зависимость (в package.json не добавляется)
 *   node scripts/unit-admin-buttons.mjs
 *
 * В отличие от smoke/unit-тестов здесь кнопки не «читаются», а КЛИКАЮТСЯ:
 * компоненты рендерятся в jsdom через createRoot, события — реальные
 * dispatchEvent (click/input/submit), данные — демо-режим (mockStore).
 *
 * Проверяется вся цепочка каждой кнопки:
 *   1. ChapterForm: клик «Создать главу» → chapters.create → глава в списке;
 *   2. TitleForm: клик «Создать тайтл» → titles.create → тайтл в списке,
 *      cover_url-путь сохраняется как есть, ошибки валидации показываются;
 *   2b. TitleForm: выбор файла в «Загрузить файл» → storage.uploadCover →
 *      cover_url заполнен, PDF отклоняется с сообщением, «Создать тайтл»
 *      сохраняет загруженную обложку;
 *   3. RequestForm: клик «Запросить…» → adminRequests.submit → «Заявка отправлена».
 */
let JSDOM;
try {
  ({ JSDOM } = await import('jsdom'));
} catch {
  console.error('unit-admin-buttons: нужен jsdom (одноразово): npm i --no-save jsdom');
  process.exit(2);
}

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  url: 'http://localhost:3000/',
  pretendToBeVisual: true,
});

// jsdom → globals (до загрузки модулей приложения).
// navigator в Node 21+ уже есть и только для чтения — переопределяем через defineProperty.
for (const key of [
  'document',
  'localStorage',
  'sessionStorage',
  'Event',
  'CustomEvent',
  'MouseEvent',
  'KeyboardEvent',
  'HTMLInputElement',
  'HTMLTextAreaElement',
  'HTMLFormElement',
  'HTMLElement',
  'Element',
  'Node',
  'getComputedStyle',
  'requestAnimationFrame',
  'cancelAnimationFrame',
]) {
  if (key in dom.window) {
    Object.defineProperty(globalThis, key, {
      value: dom.window[key],
      configurable: true,
      writable: true,
    });
  }
}
globalThis.window = dom.window;
try {
  Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true });
} catch {
  // navigator уже не переопределяем — оставляем node-овский
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const { forceDemoMode, DEMO_SERVER_OPTIONS } = await import('./lib/demo-mode.mjs');
forceDemoMode();

const failures = [];
const check = (name, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  if (!cond) failures.push(name);
};

const React = (await import('react')).default;
const { act } = await import('react');
const { createRoot } = await import('react-dom/client');

const root = document.getElementById('root');
/** Новый React-root на каждый сценарий: без перетекания состояния между шагами. */
let reactRoot = createRoot(root);
async function freshRoot() {
  await act(async () => {
    reactRoot.unmount();
  });
  root.innerHTML = '';
  reactRoot = createRoot(root);
}

/** Рендер компонента и стабилизация. */
async function render(element) {
  await act(async () => {
    reactRoot.render(element);
  });
}

const click = (el) =>
  act(async () => {
    el.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
  });

const setValue = (input, value) =>
  act(async () => {
    const proto = input.tagName === 'TEXTAREA' ? dom.window.HTMLTextAreaElement : dom.window.HTMLInputElement;
    Object.getOwnPropertyDescriptor(proto.prototype, 'value').set.call(input, value);
    input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  });

const submitForm = (form) =>
  act(async () => {
    form.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
  });

const buttonByText = (text) =>
  [...root.querySelectorAll('button')].find((b) => b.textContent.includes(text));

/**
 * Дождаться, пока асинхронный обработчик (например загрузка обложки) дойдёт до
 * state: React не ждёт наших промисов, поэтому крутим event loop внутри act,
 * пока предикат не сработает. Возвращает результат последней проверки.
 */
async function waitFor(predicate, timeoutMs = 5000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    if (predicate()) return true;
  }
  return predicate();
}

const { createServer } = await import('vite');
const vite = await createServer({
  ...DEMO_SERVER_OPTIONS,
  mode: 'test',
});

try {
  const { ChapterForm } = await vite.ssrLoadModule('/src/components/admin/ChapterForm.tsx');
  const { TitleForm } = await vite.ssrLoadModule('/src/components/admin/TitleForm.tsx');
  const { RequestForm } = await vite.ssrLoadModule('/src/components/admin/RequestForm.tsx');
  const { chapters } = await vite.ssrLoadModule('/src/data/chapters.ts');
  const { titles } = await vite.ssrLoadModule('/src/data/titles.ts');
  const { adminRequests } = await vite.ssrLoadModule('/src/data/adminRequests.ts');
  const { mockStore } = await vite.ssrLoadModule('/src/data/mockStore.ts');

  const seed = mockStore.getTitles(false)[0];

  // ── 1. Кнопка «Создать главу» ──────────────────────────────────────────
  let createdChapterInput = null;
  await render(
    React.createElement(ChapterForm, {
      titleId: seed.id,
      onSubmit: async (input) => {
        // как в admin.titles.$id.chapters.index.tsx: реальные данные → список
        const created = await chapters.create(input);
        createdChapterInput = input;
        return created;
      },
    })
  );

  const createChapterBtn = buttonByText('Создать главу');
  check('кнопка «Создать главу» найдена и кликабельна', Boolean(createChapterBtn) && !createChapterBtn.disabled);

  const numInput = root.querySelector('#ch-number');
  const nameInput = root.querySelector('#ch-name');
  check('поля формы главы на месте', Boolean(numInput) && Boolean(nameInput));

  await setValue(numInput, '7');
  await setValue(nameInput, 'Тестовая глава');
  const form1 = createChapterBtn.closest('form');
  await submitForm(form1);

  check('клик по «Создать главу» дошёл до chapters.create', createdChapterInput?.number === 7, JSON.stringify(createdChapterInput || {}));
  const list1 = await chapters.listByTitle(seed.id, true);
  check('глава реально появилась в данных', list1.some((c) => c.number === 7 && c.name === 'Тестовая глава'));

  // Ошибка валидации показывается, а не «молчит»
  await setValue(root.querySelector('#ch-number'), '0');
  await submitForm(root.querySelector('form'));
  check('невалидный номер → видно сообщение об ошибке', root.textContent.includes('Номер главы'));

  // ── 2. Кнопка «Создать тайтл» ──────────────────────────────────────────
  let createdTitleInput = null;
  const genresBefore = mockStore.getGenres().length;
  await render(
    React.createElement(TitleForm, {
      allGenres: mockStore.getGenres(),
      onSubmit: async (input) => {
        const created = await titles.create(input);
        createdTitleInput = input;
        return created;
      },
      onAddGenre: async (name) => mockStore.createGenre(name),
    })
  );

  const createTitleBtn = buttonByText('Создать тайтл');
  check('кнопка «Создать тайтл» найдена и кликабельна', Boolean(createTitleBtn) && !createTitleBtn.disabled);

  const titleInput = [...root.querySelectorAll('input')].find((i) => i.placeholder?.includes('Магическая'));
  await setValue(titleInput, 'Кнопочный тайтл');
  // slug автогенерится эффектом из названия
  const slugInput = [...root.querySelectorAll('input')].find((i) => i.value === 'knopochnyiy-taytl' || i.value.includes('knopochn'));
  check('slug автогенерируется из названия', Boolean(slugInput), slugInput?.value || '(slug не найден)');

  const coverInput = [...root.querySelectorAll('input')].find((i) => i.placeholder === '/media/covers/slug.webp');
  await setValue(coverInput, '/media/covers/knopochnyiy.webp');

  await submitForm(createTitleBtn.closest('form'));
  check('клик по «Создать тайтл» дошёл до titles.create', createdTitleInput?.title === 'Кнопочный тайтл');
  check('cover_url-путь сохранён как есть', createdTitleInput?.cover_url === '/media/covers/knopochnyiy.webp', createdTitleInput?.cover_url || '(null)');

  const allTitles = await titles.listAll();
  const createdTitle = allTitles.find((t) => t.title === 'Кнопочный тайтл');
  check('тайтл реально появился в данных', Boolean(createdTitle));
  check('чтение из списка не искажает cover_url', createdTitle?.cover_url === '/media/covers/knopochnyiy.webp', createdTitle?.cover_url || '(null)');

  // Валидация: пустое название → видимое сообщение, данные не меняются.
  // Чистый root + чистый draft-ключ, чтобы шаг не зависел от предыдущей формы.
  localStorage.removeItem('hikkomanga_title_draft_new');
  await freshRoot();
  await render(
    React.createElement(TitleForm, {
      allGenres: mockStore.getGenres(),
      onSubmit: async (input) => {
        await titles.create(input);
        return input;
      },
    })
  );
  await submitForm(buttonByText('Создать тайтл').closest('form'));
  check('пустое название → видно сообщение об ошибке', root.textContent.includes('Название обязательное поле'));

  // Инлайн-жанр: клик «Добавить»
  const genreInput = [...root.querySelectorAll('input')].find((i) => i.placeholder === 'Новый жанр...');
  if (genreInput) {
    await setValue(genreInput, 'Кнопочный жанр');
    await click(buttonByText('Добавить'));
    check('инлайн-кнопка «Добавить» создаёт жанр', mockStore.getGenres().length === genresBefore + 1);
  }

  // ── 2b. Кнопка «Загрузить файл»: обложка тайтла из файла ────────────────
  // Демо-режим: Storage не настроен, поэтому uploadCover возвращает data-URL —
  // но цепочка «выбрал файл → cover_url → Сохранить → titles.create» та же,
  // что в проде с бакетом covers.
  localStorage.removeItem('hikkomanga_title_draft_new');
  await freshRoot();
  let uploadedTitleInput = null;
  await render(
    React.createElement(TitleForm, {
      allGenres: mockStore.getGenres(),
      onSubmit: async (input) => {
        await titles.create(input);
        uploadedTitleInput = input;
        return input;
      },
    })
  );

  const fileInput = root.querySelector('input[type="file"]');
  check('input[type=file] для обложки на месте', Boolean(fileInput));
  check(
    'accept ограничен JPEG/PNG/WebP',
    fileInput?.getAttribute('accept') === 'image/jpeg,image/png,image/webp',
    fileInput?.getAttribute('accept') || '(нет)'
  );
  const uploadBtn = buttonByText('Загрузить файл');
  check('кнопка «Загрузить файл» найдена и кликабельна', Boolean(uploadBtn) && !uploadBtn.disabled);

  const coverField = () =>
    [...root.querySelectorAll('input')].find((i) => i.placeholder === '/media/covers/slug.webp');
  const chooseFile = (file) =>
    act(async () => {
      Object.defineProperty(fileInput, 'files', { value: [file], configurable: true });
      fileInput.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    });

  const pngBytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3, 4]);
  await chooseFile(new File([pngBytes], 'my-cover.png', { type: 'image/png' }));
  // Загрузка асинхронная (prepareCoverImage → Storage/data-URL) — ждём state.
  const filled = await waitFor(() => Boolean(coverField()?.value));
  check(
    'выбор файла заполнил cover_url (демо: data-URL, прод: URL бакета covers)',
    filled && coverField().value.startsWith('data:image/png;base64,'),
    coverField()?.value?.slice(0, 32) || '(пусто)'
  );
  check('форма сообщает, что файл загружен', /Загружен/i.test(root.textContent));

  // Мусор вместо картинки: PDF → понятная ошибка, cover_url не портится.
  const coverBeforeBad = coverField().value;
  await chooseFile(new File([new Uint8Array(Buffer.from('%PDF-1.7'))], 'bad.pdf'));
  const rejected = await waitFor(() => root.textContent.includes('Допустимы JPEG, PNG или WebP'));
  check('не-картинка отклоняется с сообщением в форме', rejected);
  check('после отказа cover_url остался прежним', coverField().value === coverBeforeBad);

  await setValue(
    [...root.querySelectorAll('input')].find((i) => i.placeholder?.includes('Магическая')),
    'Загрузочный тайтл'
  );
  await submitForm(uploadBtn.closest('form'));
  check(
    'клик «Создать тайтл» донёс загруженную обложку до titles.create',
    uploadedTitleInput?.cover_url?.startsWith('data:image/png;base64,'),
    uploadedTitleInput?.cover_url?.slice(0, 32) || '(null)'
  );
  const uploadedTitle = (await titles.listAll()).find((t) => t.title === 'Загрузочный тайтл');
  check('тайтл с загруженной обложкой реально появился в данных', Boolean(uploadedTitle));

  // ── 3. Кнопка заявки (RequestForm — ветка не-owner) ────────────────────
  await render(
    React.createElement(RequestForm, {
      type: 'new_chapter',
      target_id: seed.id,
      target_name: seed.title,
      payload: { suggested_number: 99 },
      title: 'Запрос на добавление главы',
      description: 'Владелец создаст главу.',
      submitLabel: 'Запросить создание главы',
    })
  );
  const requestBtn = buttonByText('Запросить создание главы');
  check('кнопка заявки найдена', Boolean(requestBtn));
  await submitForm(requestBtn.closest('form'));
  check('клик по заявке дошёл до adminRequests.submit', root.textContent.includes('Заявка отправлена'));

  // Чистим за собой: демо-хранилище общее для тестов репозитория
  const createdCh = list1.find((c) => c.number === 7);
  if (createdCh) await chapters.delete(createdCh.id);
  if (createdTitle) await titles.delete(createdTitle.id);
  if (uploadedTitle) await titles.delete(uploadedTitle.id);

  await act(async () => {
    reactRoot.unmount();
  });
} finally {
  await vite.close();
}

console.log(failures.length === 0 ? '\nALL BUTTON CHECKS PASS' : `\n${failures.length} FAILURES`);
process.exit(failures.length ? 1 : 0);
