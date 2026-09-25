/**
 * Интеграционный тест support-чата: «кликается — работает?»
 *
 *   npm i --no-save jsdom   # разовая зависимость (в package.json не добавляется)
 *   node scripts/unit-support-chat.mjs
 *
 * Компоненты рендерятся в jsdom через createRoot, события — настоящие
 * dispatchEvent (click/input/submit), сеть не нужна: `@/data/chat` и
 * `@/data/dialogTts` подменены виртуальными модулями (см. плагин ниже), так
 * что проверяется именно UI-цепочка, а не edge-функции.
 *
 * Что проверяется:
 *   1. закрытая панель не рисует чат и отдаёт контент страницы как есть;
 *   2. открытие/закрытие не перемонтирует контент страницы (тот же DOM-узел —
 *      иначе админские формы теряли бы несохранённые правки);
 *   3. отправка вопроса → токены стрима дописываются в сообщение ассистента;
 *   4. «Стоп» обрывает стрим, уже полученные токены остаются;
 *   5. картинка уходит в историю как inlineData (data-URL → base64);
 *   6. «Озвучить» создаёт blob:-ссылку, а при размонтировании она отзывается;
 *   7. на мобильных (< 768px) чат открывается шторкой и закрывается Escape;
 *   8. разметка страницы: кнопка в AdminHeader и провайдер в __root.tsx.
 */
let JSDOM;
try {
  ({ JSDOM } = await import('jsdom'));
} catch {
  console.error('unit-support-chat: нужен jsdom (одноразово): npm i --no-save jsdom');
  process.exit(2);
}

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  url: 'http://localhost:3000/admin',
  pretendToBeVisual: true,
});

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
  'Blob',
  'File',
  'FileReader',
  // react-resizable-panels вешает слушатели с сигналом: сигнал должен быть из
  // того же realm, что и DOM (иначе jsdom отвергает его как «не AbortSignal»).
  'AbortSignal',
  'AbortController',
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

// ── Чего в jsdom нет, но нужно React-компонентам ─────────────────────────────
/** Медиазапросы: тест переключает «десктоп/мобильный» через this.desktop. */
const media = {
  desktop: true,
  listeners: new Set(),
  set(desktop) {
    media.desktop = desktop;
    for (const listener of media.listeners) listener();
  },
};
dom.window.matchMedia = (query) => ({
  matches: /min-width:\s*768px/.test(query) ? media.desktop : false,
  media: query,
  addEventListener: (_type, listener) => media.listeners.add(listener),
  removeEventListener: (_type, listener) => media.listeners.delete(listener),
  addListener: (listener) => media.listeners.add(listener),
  removeListener: (listener) => media.listeners.delete(listener),
  dispatchEvent: () => false,
});
globalThis.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
dom.window.requestIdleCallback = (callback) => dom.window.setTimeout(callback, 0);
dom.window.cancelIdleCallback = (id) => dom.window.clearTimeout(id);
dom.window.Element.prototype.scrollIntoView = () => {};
dom.window.HTMLMediaElement.prototype.play = () => Promise.resolve();
dom.window.Element.prototype.getBoundingClientRect = function () {
  return { width: 1200, height: 800, top: 0, left: 0, right: 1200, bottom: 800, x: 0, y: 0, toJSON() {} };
};

/** blob:-ссылки: jsdom их не умеет, а нам важно, что их отзывают. */
const objectUrls = { created: [], revoked: [] };
const createObjectURL = (blob) => {
  const url = `blob:test-${objectUrls.created.length + 1}-${blob?.type ?? ''}`;
  objectUrls.created.push(url);
  return url;
};
const revokeObjectURL = (url) => objectUrls.revoked.push(url);
// Патчим и jsdom-объект, и глобальный URL: код приложения живёт в Node-realm
// (модули грузит Vite), поэтому обращается к глобальному `URL.createObjectURL`,
// а Node его для Blob из jsdom не умеет.
dom.window.URL.createObjectURL = createObjectURL;
dom.window.URL.revokeObjectURL = revokeObjectURL;
globalThis.URL.createObjectURL = createObjectURL;
globalThis.URL.revokeObjectURL = revokeObjectURL;

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
const { createServer } = await import('vite');

/** Подменяет клиентские модули сети: реальные edge-функции в тесте не нужны. */
const SUPPORT_STUBS = `
const calls = (globalThis.__supportCalls ??= { chat: [], tts: [] });
export const CHAT_ERROR_MESSAGES = Object.freeze({
  unauthorized: 'Сессия истекла', gemini_key_missing: 'Нужен ключ',
  rate_limit: 'Слишком много запросов', unknown: 'Чат недоступен',
});
export class ChatError extends Error {
  constructor(code, message) { super(message ?? CHAT_ERROR_MESSAGES[code] ?? code); this.name = 'ChatError'; this.code = code; }
}
export async function streamChat({ messages, signal }) {
  calls.chat.push({ messages, signal });
  return globalThis.__supportStream(signal);
}
export const DIALOG_TTS_ERROR_MESSAGES = Object.freeze({
  unauthorized: 'Сессия истекла', forbidden: 'Только для админов',
  gemini_key_missing: 'Добавьте ключ: /admin/settings', invalid_input: 'Проверьте текст',
  rate_limit: 'Слишком много запросов', unknown: 'Озвучка не удалась',
});
export class DialogTtsError extends Error {
  constructor(code, message) { super(message ?? DIALOG_TTS_ERROR_MESSAGES[code] ?? code); this.name = 'DialogTtsError'; this.code = code; }
}
export async function synthesizeDialog(input) {
  calls.tts.push(input);
  if (globalThis.__ttsResult instanceof Error) throw globalThis.__ttsResult;
  return new Blob([new Uint8Array([82, 73, 70, 70])], { type: 'audio/wav' });
}
`;

globalThis.__supportCalls = { chat: [], tts: [] };

const stubPlugin = {
  name: 'support-stubs',
  enforce: 'pre',
  resolveId(source) {
    if (/data[\\/]chat(\\.ts)?$/.test(source)) return '\0stub:support';
    if (/data[\\/]dialogTts(\\.ts)?$/.test(source)) return '\0stub:support';
    return null;
  },
  load(id) {
    if (id === '\0stub:support') return SUPPORT_STUBS;
    return null;
  },
};

const vite = await createServer({ ...DEMO_SERVER_OPTIONS, mode: 'test', plugins: [stubPlugin] });

const root = document.getElementById('root');
let reactRoot = createRoot(root);

/** Прокрутка асинхронных эффектов (динамический import раскладки, act-очередь). */
async function flush(times = 4) {
  for (let i = 0; i < times; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
  }
}

const click = (el) =>
  act(async () => {
    el.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
  });

const pressEnter = (el) =>
  act(async () => {
    el.dispatchEvent(
      new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
    );
  });

const pressEscape = () =>
  act(async () => {
    document.dispatchEvent(
      new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    );
  });

const setValue = (input, value) =>
  act(async () => {
    const proto = dom.window.HTMLTextAreaElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(input, value);
    input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  });

const submitForm = (form) =>
  act(async () => {
    form.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
  });

/** Тексты реплик ассистента (без служебных «…» и кнопок). */
const bubbleTexts = () =>
  [...root.querySelectorAll('div')]
    .filter((el) => el.className.includes('whitespace-pre-wrap'))
    .map((el) => el.textContent);

try {
  const { SupportChatSidebar } = await vite.ssrLoadModule('/src/components/support/SupportChatSidebar.tsx');
  const { SupportChatProvider, useSupportChat } = await vite.ssrLoadModule(
    '/src/components/support/SupportChatContext.tsx'
  );

  /** Кнопка-переключатель как в AdminHeader (там она на context.toggle). */
  function Toggle() {
    const { open, toggle } = useSupportChat();
    return React.createElement(
      'button',
      { type: 'button', onClick: toggle, 'data-testid': 'toggle' },
      open ? 'Закрыть чат' : 'Открыть чат'
    );
  }

  const page = React.createElement(
    'div',
    { 'data-testid': 'page' },
    React.createElement('h1', null, 'Каталог'),
    'Контент страницы'
  );

  /**
   * Стрим по умолчанию: три токена с паузой между ними — так «Стоп» успевает
   * сработать в середине ответа.
   */
  const makeStream = (tokens, { hang = false } = {}) =>
    (async function* () {
      for (const token of tokens) {
        await new Promise((resolve) => setTimeout(resolve, 5));
        yield token;
      }
      if (hang) await new Promise(() => {});
    })();

  /**
   * Стрим, который «висит» до отмены — как настоящий fetch под AbortController:
   * abort() роняет ожидание, и цикл `for await` в компоненте завершается.
   */
  const makeAbortableStream = (tokens, signal) =>
    (async function* () {
      for (const token of tokens) {
        await new Promise((resolve) => setTimeout(resolve, 5));
        yield token;
      }
      await new Promise((_resolve, reject) => {
        if (signal?.aborted) reject(new Error('AbortError'));
        signal?.addEventListener('abort', () => reject(new Error('AbortError')));
        setTimeout(() => reject(new Error('timeout')), 5000);
      });
    })();

  globalThis.__supportStream = () => makeStream(['Манга', ' загружается', ' в админке']);

  // Прогреваем динамический чанк раскладки: в SSR-контексте Vite первый
  // динамический import идёт через сервер и в jsdom-прогоне не успевает
  // разрешиться за время act-очереди. В браузере это обычный сетевой запрос
  // за чанком (см. SupportChatSidebar), сама логика от прогрева не меняется.
  const panelModule = await vite.ssrLoadModule('/src/components/support/SupportChatPanel.tsx');
  check(
    '0. модуль раскладки собирается и отдаёт обе раскладки',
    typeof panelModule.SupportChatDesktopLayout === 'function' &&
      typeof panelModule.SupportChatMobileSheet === 'function'
  );

  await act(async () => {
    reactRoot.render(
      React.createElement(
        SupportChatProvider,
        null,
        React.createElement(
          SupportChatSidebar,
          null,
          React.createElement(Toggle, null),
          page
        )
      )
    );
  });
  await flush();

  const pageNode = root.querySelector('[data-testid="page"]');
  const toggle = root.querySelector('[data-testid="toggle"]');
  check('1a. контент страницы отрендерился', pageNode?.textContent.includes('Контент страницы'));
  check('1b. в закрытом состоянии чата нет', !root.querySelector('textarea'));
  check('1c. кнопка-переключатель на месте', toggle?.textContent === 'Открыть чат');

  // ── 2. Открытие ───────────────────────────────────────────────────────────
  await click(toggle);
  await flush();

  const openedTextarea = root.querySelector('textarea');
  check('2a. по кнопке появился чат (поле ввода)', Boolean(openedTextarea));
  check(
    '2b. контент страницы — тот же DOM-узел (панель не перемонтировала страницу)',
    root.querySelector('[data-testid="page"]') === pageNode
  );
  check(
    '2c. раскладка — resizable-панели с ручкой (не оверлей)',
    Boolean(root.querySelector('[data-panel-group]')) &&
      Boolean(root.querySelector('[data-panel-resize-handle-id]')) &&
      root.querySelector('[data-testid="toggle"]')?.textContent === 'Закрыть чат'
  );
  // Тесты идут в демо-режиме (forceDemoMode): панель обязана сразу сказать, что
  // Supabase не настроен, а не показывать ошибку про «незадеплоенную функцию».
  check(
    '2d. в демо-режиме панель предупреждает про ненастроенный Supabase',
    root.textContent.includes('Демо-режим: Supabase не настроен') &&
      root.textContent.includes('VITE_SUPABASE_URL')
  );

  // ── 3. Стрим ответа ───────────────────────────────────────────────────────
  const form = openedTextarea.closest('form');
  await setValue(openedTextarea, 'Как загрузить главу?');
  await submitForm(form);
  await flush();

  const streamedBubble = bubbleTexts().find((text) => text.includes('Манга'));
  check(
    '3a. токены стрима дописаны в сообщение ассистента',
    streamedBubble?.includes('Манга загружается в админке'),
    streamedBubble
  );
  check('3b. вопрос пользователя виден в истории', bubbleTexts().includes('Как загрузить главу?'));
  check('3c. в запрос ушла вся история (user + пустой assistant не шлём)', globalThis.__supportCalls.chat.at(-1).messages.length === 1);
  check(
    '3d. после завершения стрима снова доступна отправка',
    [...root.querySelectorAll('button')].some((button) => button.getAttribute('aria-label') === 'Отправить')
  );

  // ── 4. «Стоп» посреди ответа ──────────────────────────────────────────────
  globalThis.__supportStream = (signal) => makeAbortableStream(['Часть ответа'], signal);

  const input2 = root.querySelector('textarea');
  await setValue(input2, 'Второй вопрос');
  await submitForm(input2.closest('form'));
  await flush(6);

  const stopButton = [...root.querySelectorAll('button')].find(
    (button) => button.getAttribute('aria-label') === 'Стоп'
  );
  check('4a. во время стрима показана кнопка «Стоп»', Boolean(stopButton));

  const seenBeforeStop = bubbleTexts().join('|');
  await click(stopButton);
  await flush(4);

  check('4b. после «Стоп» полученная часть ответа осталась в истории', seenBeforeStop.includes('Часть ответа'));
  check(
    '4c. кнопка «Стоп» сменилась на «Отправить»',
    ![...root.querySelectorAll('button')].some((b) => b.getAttribute('aria-label') === 'Стоп')
  );

  // ── 5. Картинка уходит как inlineData ─────────────────────────────────────
  const fileInput = root.querySelector('input[type="file"]');
  const file = new dom.window.File([new Uint8Array([1, 2, 3])], 'screenshot.png', {
    type: 'image/png',
  });
  Object.defineProperty(fileInput, 'files', { value: [file], configurable: true });
  await act(async () => {
    fileInput.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  });
  await flush(4);

  const preview = root.querySelector('img[alt="screenshot.png"]');
  check('5a. превью прикреплённого файла появилось', Boolean(preview));
  check('5b. превью — data-URL из FileReader', preview?.getAttribute('src')?.startsWith('data:image/png;base64,'));

  const input3 = root.querySelector('textarea');
  await setValue(input3, 'Что не так на скриншоте?');
  await submitForm(input3.closest('form'));
  await flush();

  const lastMessages = globalThis.__supportCalls.chat.at(-1).messages;
  const imagePart = lastMessages.at(-1).content.find?.((part) => part.type === 'inlineData');
  check(
    '5c. сообщение с картинкой ушло частями: text + inlineData',
    Array.isArray(lastMessages.at(-1).content) && imagePart?.mimeType === 'image/png' && Boolean(imagePart.data)
  );
  check('5d. поле ввода очистилось после отправки', root.querySelector('textarea').value === '');

  // ── 6. Озвучка: blob:-ссылка и её отзыв при размонтировании ───────────────
  const speakButton = [...root.querySelectorAll('button')].find((button) =>
    button.textContent.includes('Озвучить')
  );
  check('6a. у ответа ассистента есть кнопка «Озвучить»', Boolean(speakButton));

  await click(speakButton);
  await flush(4);

  const ttsCall = globalThis.__supportCalls.tts.at(-1);
  check(
    '6b. озвучка уходит как транскрипт одного Speaker 1',
    ttsCall?.transcript.startsWith('Speaker 1: ') && Object.keys(ttsCall.voices).length === 1
  );
  check('6c. создан blob:-URL и показан аудиоплеер', objectUrls.created.length > 0 && Boolean(root.querySelector('audio')));

  await act(async () => {
    reactRoot.unmount();
  });
  check(
    '6d. при размонтировании blob:-ссылка отзывается',
    objectUrls.created.every((url) => objectUrls.revoked.includes(url)),
    `created=${objectUrls.created.length} revoked=${objectUrls.revoked.length}`
  );

  // ── 7. Мобильная шторка ───────────────────────────────────────────────────
  media.set(false);
  root.innerHTML = '';
  reactRoot = createRoot(root);
  globalThis.__supportStream = () => makeStream(['ок']);

  await act(async () => {
    reactRoot.render(
      React.createElement(
        SupportChatProvider,
        null,
        React.createElement(
          SupportChatSidebar,
          null,
          React.createElement(Toggle, null),
          page
        )
      )
    );
  });
  await flush();

  const mobilePageNode = root.querySelector('[data-testid="page"]');
  await click(root.querySelector('[data-testid="toggle"]'));
  await flush();

  const sheet = document.querySelector('[role="dialog"]');
  check('7a. на мобильных чат открывается шторкой (role=dialog)', Boolean(sheet));
  check('7b. шторка прижата к низу экрана', sheet?.className.includes('bottom-0'));
  check(
    '7c. контент страницы не перемонтировался при открытии шторки',
    root.querySelector('[data-testid="page"]') === mobilePageNode
  );

  await pressEscape();
  await flush();
  check('7d. Escape закрывает шторку', !document.querySelector('[role="dialog"]'));

  await act(async () => {
    reactRoot.unmount();
  });

  // ── 8. Разметка страниц (без рендера роутера) ─────────────────────────────
  const { readFileSync } = await import('node:fs');
  const rootLayout = readFileSync('src/routes/__root.tsx', 'utf8');
  const adminHeader = readFileSync('src/components/layout/AdminHeader.tsx', 'utf8');

  check(
    '8a. __root.tsx оборачивает <Outlet /> в провайдер и сайдбар',
    /<SupportChatProvider>[\s\S]*<SupportChatSidebar>[\s\S]*<Outlet \/>[\s\S]*<\/SupportChatSidebar>[\s\S]*<\/SupportChatProvider>/.test(
      rootLayout
    )
  );
  check(
    '8b. кнопка чата живёт в AdminHeader и переключает контекст',
    adminHeader.includes('MessageCircle') && adminHeader.includes('support?.toggle()')
  );
} finally {
  await vite.close();
}

if (failures.length) {
  console.error(`\nunit-support-chat: провалено проверок — ${failures.length}`);
  for (const name of failures) console.error(`  - ${name}`);
  process.exitCode = 1;
} else {
  console.log('\nunit-support-chat: все проверки пройдены');
}
