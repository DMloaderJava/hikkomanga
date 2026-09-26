# Демо-медиа: источники и лицензии

## Обложки

Обложки в этом каталоге — файлы репозитория: `public/media/covers/{slug}.webp`
(генерируются скриптом `scripts/generate-seed-covers.mjs` из собственного
SVG-генератора `src/lib/placeholder-cover.ts`, WebP 800px). Авторские права
третьих лиц не затрагиваются: это демо-обложки, а не сканы настоящих тайтлов.

Новая обложка для своего тайтла — любым из двух способов (админка → TitleForm):

1. **«Загрузить файл»** — JPEG/PNG/WebP до 5 MB. Картинка сожмётся в WebP
   ≤800 px и уйдёт в Supabase Storage (публичный бакет `covers`), в этом
   каталоге ничего не появится и бюджет сборки не изменится.
2. **Файл репозитория** — положите WebP в `public/media/covers/` и укажите путь
   `/media/covers/{имя}.webp`. Это осознанный коммит: вес каталога ограничен
   бюджетом 500 kB (`scripts/check-budgets.mjs`).

Проверить, что все обложки из базы доступны (файлы в `public/` и объекты
бакета `covers`): `npm run check:covers`.

## Страницы глав (public domain)

Все страницы — сканы «Хокусай манга» (Кацусика Хокусай, 1814–1878),
общественное достояние:

| Файл | Источник |
| --- | --- |
| `pages/hokusai-travelers.jpg` | Wikimedia Commons, `Hokusai Manga 01.jpg` |
| `pages/hokusai-bathing.jpg` | Wikimedia Commons, `HokusaiMangaBathingPeople.jpg` |
| `pages/hokusai-demon-monk.jpg` | Wikimedia Commons, `Hokusai Manga 04.jpg` |
| `pages/hokusai-vol6-wrestlers.jpg` | Wikimedia Commons, `Hokusai sketches - hokusai manga vol6.jpg` |
| `pages/hokusai-vol6-crop.jpg` | Wikimedia Commons, `Hokusai-sketches---hokusai-manga-vol6-crop.jpg` |
| `pages/hokusai-vol1-spread.jpg` | скан разворота тома 1 (fujiarts.com, PD) |

Это исторические скетчи, а не страницы современных тайтлов: настоящие сканы
манги защищены авторским правом и в репозиторий не помещаются. Загрузите свои
страницы через админ-панель (они уйдут в Supabase Storage, бакет `manga`).

## Формат

Страницы конвертированы одним прогоном `sharp` (без сохранения в package.json):
ширина ≤1000 px, JPEG q80, mozjpeg.
