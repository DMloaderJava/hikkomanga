# Демо-медиа: источники и лицензии

Файлы используются **только как заглушки** для локального демо-режима
(`mockStore`, когда Supabase не подключён). Для публичного деплоя замените их
собственными ассетами или лицензионными обложками: права на обложки
принадлежат правообладателям.

## Обложки (copyright, fair-use демонстрация)

| Файл | Произведение | Источник | Права |
| --- | --- | --- | --- |
| `covers/solo-leveling.jpg` | Solo Leveling / «Поднятие уровня в одиночку» | официальный арт артбука (manhwa, REDICE Studio), найдено через поиск изображений | © Chugong, DUBU (REDICE STUDIO) |
| `covers/jujutsu-kaisen.jpg` | Jujutsu Kaisen / «Магическая битва» | очищенный скан официальной обложки (Jujutsu Kaisen Modulo, Vol. 1) | © Gege Akutami / Shueisha |
| `covers/kimetsu-no-yaiba.jpg` | Kimetsu no Yaiba / «Клинок, рассекающий демонов», том 1 | скан обложки Jump Comics | © Koyoharu Gotouge / Shueisha |

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

Конвертация одним прогоном `sharp` (без сохранения в package.json):
обложки — ширина ≤600 px, JPEG q84; страницы — ширина ≤1000 px, JPEG q80,
mozjpeg. Итог ~1.2 MB на весь набор.
