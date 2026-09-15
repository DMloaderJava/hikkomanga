# Демо-медиа: источники и лицензии

## Обложки

Обложки в демо-режиме генерируются программно (`src/lib/placeholder-cover.ts`)
как SVG-плейсхолдеры — авторские права третьих лиц не затрагиваются.
Загрузите настоящие обложки через админ-панель: они уйдут в Supabase Storage
(бакет `manga`), а в демо-режиме без Supabase останутся data-URL в localStorage.

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
