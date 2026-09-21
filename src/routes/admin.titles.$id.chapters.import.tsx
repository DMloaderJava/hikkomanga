import { useRef, useState } from 'react';
import { createFileRoute, Link } from '@tanstack/react-router';
import { titles as titlesApi } from '@/data/titles';
import { chapters as chaptersApi } from '@/data/chapters';
import { pages as pagesApi } from '@/data/pages';
import { storage, uploadErrorMessage } from '@/data/storage';
import { auth } from '@/data/auth';
import { assertEntityId } from '@/lib/routeParams';
import { DuplicateChapterError, type Title } from '@/data/types';
import {
  ChaptersEditor,
  renumberPages,
  type EditorChapter,
} from '@/components/requests/ChaptersEditor';
import {
  buildImportPlan,
  formatBytes,
  groupPageFiles,
  parseChaptersCsv,
  type CsvChapterRow,
  type ImportPlan,
} from '@/lib/chaptersImport';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Progress } from '@/components/ui/progress';
import {
  AlertCircle,
  ArrowLeft,
  CheckCircle2,
  FileSpreadsheet,
  Loader2,
  Table2,
  UploadCloud,
} from 'lucide-react';

/**
 * Массовый импорт глав: CSV со списком глав → инлайн-превью → файлы страниц.
 *
 * Guard наследуется от layout /admin (beforeLoad в admin.tsx) — тот же, что у
 * остальных админ-роутов. Главы создаются черновиками (published=false);
 * конфликт номера — пропуск главы с записью в отчёт (ТЗ), а не сдвиг номера:
 * при импорте важнее не перепутать нумерацию, чем создать всё любой ценой.
 */
export const Route = createFileRoute('/admin/titles/$id/chapters/import')({
  loader: async ({ params }) => {
    const titleId = assertEntityId(params.id, 'тайтл');
    const [titleData, chapterList] = await Promise.all([
      titlesApi.getById(titleId),
      chaptersApi.listByTitle(titleId, true),
    ]);
    if (!titleData) throw new Error('Тайтл не найден');
    let isOwner = false;
    try {
      const session = await auth.getSession();
      const uid = session?.user?.id;
      if (uid) isOwner = await auth.hasRole(uid, 'owner');
    } catch {
      // ignore: не owner — форма создания глав недоступна, импорт тоже
    }
    return { title: titleData, existingNumbers: chapterList.map((c) => Number(c.number)), isOwner };
  },
  component: AdminChaptersImportPage,
});

const MAX_PAGES_PER_CHAPTER = 100;
const MAX_CHAPTERS = Number.MAX_SAFE_INTEGER;

const CSV_PLACEHOLDER = `number,name,description
1,Начало пути,Знакомство с героем
2,Первый бой
3,,Глава без названия`;

interface ChapterReport {
  number: number;
  name: string;
  status: 'pending' | 'running' | 'created' | 'skipped' | 'error';
  detail: string;
  /** Загружено страниц. */
  pages: number;
  /** Сколько страниц предстоит загрузить (для прогресс-бара). */
  total: number;
}

function AdminChaptersImportPage() {
  const { title, existingNumbers, isOwner } = Route.useLoaderData() as {
    title: Title;
    existingNumbers: number[];
    isOwner: boolean;
  };

  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [csvText, setCsvText] = useState('');
  const [csvErrors, setCsvErrors] = useState<string[]>([]);
  const [csvInfo, setCsvInfo] = useState<string | null>(null);
  const [chapters, setChapters] = useState<EditorChapter[]>([]);
  const [plan, setPlan] = useState<ImportPlan | null>(null);
  const [reports, setReports] = useState<ChapterReport[]>([]);
  const [running, setRunning] = useState(false);
  const [done, setDone] = useState(false);
  const [globalError, setGlobalError] = useState<string | null>(null);
  const csvInput = useRef<HTMLInputElement>(null);
  const filesInput = useRef<HTMLInputElement>(null);

  const handleCsv = (text: string) => {
    const parsed = parseChaptersCsv(text);
    setCsvText(text);
    setCsvErrors(parsed.errors);
    setCsvInfo(
      parsed.rows.length > 0
        ? `Распознано глав: ${parsed.rows.length}${parsed.headerSkipped ? ' (заголовок пропущен)' : ''}`
        : null
    );
  };

  const toStep2 = () => {
    const parsed = parseChaptersCsv(csvText);
    setCsvErrors(parsed.errors);
    if (parsed.rows.length === 0) {
      setGlobalError('Сначала введите хотя бы одну строку формата number,name[,description]');
      return;
    }
    setGlobalError(null);
    setChapters(
      parsed.rows.map((row: CsvChapterRow) => ({
        id: `csv-${row.line}-${row.number}`,
        number: String(row.number),
        name: row.name,
        description: row.description,
        pages: [],
      }))
    );
    setStep(2);
  };

  const rowsOf = (list: EditorChapter[]): CsvChapterRow[] =>
    list.map((ch, i) => ({
      number: Number(ch.number),
      name: ch.name,
      description: ch.description,
      line: i + 1,
    }));

  const toStep3 = () => {
    // План строится по факту появления файлов: до дропа предупреждать не о чем.
    setPlan(null);
    setStep(3);
  };

  /**
   * Дроп файлов на шаге 3: распределяем по главам по номеру из имени файла.
   * Повторный дроп дополняет главы, которых нет в новой пачке, и заменяет
   * страницы тех глав, что пришли снова.
   */
  const handleFiles = (files: File[]) => {
    if (files.length === 0) return;
    const grouped = groupPageFiles(files);

    const next = chapters.map((ch) => {
      const group = grouped.groups.get(Number(ch.number));
      if (!group) return ch;
      const pages = group.pages.map((p) => ({
        id: `f-${Number(ch.number)}-${p.page}-${p.file.name}`,
        file: p.file,
        index: p.page,
        name: p.file.name,
      }));
      return renumberPages({ ...ch, pages, pdf: group.pdf ?? ch.pdf });
    });
    setChapters(next);

    // План считаем по объединённому состоянию: главы из предыдущих дропов
    // plus главы, которых нет в CSV (они видны как предупреждение).
    const merged = new Map<number, { pages: Array<{ page: number; file: File }>; pdf: File | null }>();
    for (const ch of next) {
      if (ch.pages.length === 0 && !ch.pdf) continue;
      merged.set(Number(ch.number), {
        pages: ch.pages.map((pg) => ({ page: pg.index, file: pg.file })),
        pdf: ch.pdf ?? null,
      });
    }
    for (const [chapterNumber, group] of grouped.groups) {
      if (!merged.has(chapterNumber)) merged.set(chapterNumber, group);
    }
    setPlan(buildImportPlan(rowsOf(next), { groups: merged, unmatched: grouped.unmatched }));
  };

  const runImport = async () => {
    if (running || !isOwner) return;
    setRunning(true);
    setDone(false);
    setGlobalError(null);

    const targets = chapters
      .filter((ch) => ch.pages.length > 0 || ch.pdf)
      .slice()
      .sort((a, b) => Number(a.number) - Number(b.number));

    const initial: ChapterReport[] = targets.map((ch) => ({
      number: Number(ch.number),
      name: ch.name,
      status: 'pending',
      detail: 'В очереди',
      pages: 0,
      total: ch.pages.length,
    }));
    setReports(initial);

    const taken = new Set(existingNumbers);

    for (let i = 0; i < targets.length; i += 1) {
      const chapter = targets[i];
      const number = Number(chapter.number);
      const patch = (update: Partial<ChapterReport>) =>
        setReports((prev) => prev.map((r, idx) => (idx === i ? { ...r, ...update } : r)));

      patch({ status: 'running', detail: 'Создаём главу…' });

      if (!Number.isFinite(number) || number <= 0) {
        patch({ status: 'skipped', detail: 'Некорректный номер главы' });
        continue;
      }
      if (taken.has(number)) {
        patch({ status: 'skipped', detail: `Номер ${number} уже занят — глава пропущена` });
        continue;
      }

      let created;
      try {
        created = await chaptersApi.create({
          title_id: title.id,
          number,
          name: chapter.name.trim() || null,
          description: chapter.description.trim() || null,
          published: false,
        });
        taken.add(number);
      } catch (e) {
        if (e instanceof DuplicateChapterError) {
          patch({ status: 'skipped', detail: `Номер ${number} уже занят — глава пропущена` });
          continue;
        }
        patch({
          status: 'error',
          detail: e instanceof Error ? e.message : 'Не удалось создать главу',
        });
        continue;
      }

      let order = 1;
      let imported = 0;
      let failed = 0;

      for (const page of chapter.pages) {
        patch({ status: 'running', detail: `Страница ${order} из ${chapter.pages.length}…` });
        try {
          const uploaded = await storage.uploadPage(created.id, page.file, order);
          await pagesApi.create({ chapter_id: created.id, ...uploaded, page_order: order });
          order += 1;
          imported += 1;
          patch({ pages: imported });
        } catch (e) {
          failed += 1;
          patch({
            status: 'running',
            detail: uploadErrorMessage(e, page.file.name),
          });
        }
      }

      if (chapter.pdf) {
        patch({ status: 'running', detail: 'Разбираем PDF…' });
        try {
          for await (const page of storage.iteratePdfUploads(
            created.id,
            chapter.pdf,
            order,
            (stage, donePages, total) =>
              patch({
                status: 'running',
                detail: `${stage === 'parsing' ? 'Разбор PDF' : 'Загрузка страниц'} (${donePages}/${total})`,
              })
          )) {
            try {
              await pagesApi.create({ chapter_id: created.id, ...page, page_order: page.order });
              imported += 1;
              order = page.order + 1;
              patch({ pages: imported });
            } catch {
              failed += 1;
            }
          }
        } catch (e) {
          failed += 1;
          patch({ detail: uploadErrorMessage(e, chapter.pdf.name) });
        }
      }

      patch({
        status: failed > 0 ? 'error' : 'created',
        detail:
          failed > 0
            ? `Создана, но ${failed} файл(ов) не загрузились`
            : `Создана (черновик), страниц: ${imported}`,
      });
    }

    setRunning(false);
    setDone(true);
  };

  const created = reports.filter((r) => r.status === 'created').length;
  const skipped = reports.filter((r) => r.status === 'skipped').length;
  const failed = reports.filter((r) => r.status === 'error').length;
  const totalPages = reports.reduce((s, r) => s + r.pages, 0);

  return (
    <main className="mx-auto max-w-4xl px-4 py-8 space-y-6">
      <div className="flex items-start justify-between gap-4 border-b border-neutral-800 pb-4">
        <div className="flex items-center gap-4">
          <Link to="/admin/titles/$id/chapters" params={{ id: title.id }} className="text-neutral-400 hover:text-white">
            <ArrowLeft className="h-5 w-5" />
          </Link>
          <div>
            <h1 className="text-xl sm:text-2xl font-bold text-white tracking-tight">
              Импорт глав · «{title.title}»
            </h1>
            <p className="mt-0.5 text-xs text-neutral-400">
              CSV со списком глав → превью → файлы страниц. Главы создаются черновиками.
            </p>
          </div>
        </div>
        <ol className="hidden shrink-0 gap-2 text-[11px] text-neutral-500 sm:flex">
          {(['CSV', 'Превью', 'Файлы'] as const).map((label, i) => (
            <li
              key={label}
              className={`rounded-md px-2 py-1 ${step === i + 1 ? 'bg-neutral-800 text-white' : ''}`}
            >
              {i + 1}. {label}
            </li>
          ))}
        </ol>
      </div>

      {!isOwner && (
        <div className="rounded-xl border border-amber-800/60 bg-amber-950/30 p-3 text-sm text-amber-300">
          Импорт доступен только владельцу: создание глав и загрузка файлов
          требуют роли owner.
        </div>
      )}

      {globalError && (
        <div className="flex items-start gap-2 rounded-xl border border-red-800/60 bg-red-950/30 p-3 text-sm text-red-400">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{globalError}</span>
        </div>
      )}

      {step === 1 && (
        <section className="space-y-3">
          <div className="flex items-center justify-between gap-3">
            <Label htmlFor="csv-text">
              CSV <span className="text-neutral-500">(number,name[,description]; заголовок опционален)</span>
            </Label>
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="gap-1.5 border-neutral-700"
              onClick={() => csvInput.current?.click()}
            >
              <FileSpreadsheet className="h-3.5 w-3.5" /> Загрузить .csv
            </Button>
            <input
              ref={csvInput}
              type="file"
              accept=".csv,text/csv,text/plain"
              className="hidden"
              onChange={async (e) => {
                const file = e.target.files?.[0];
                e.target.value = '';
                if (!file) return;
                handleCsv(await file.text());
              }}
            />
          </div>
          <Textarea
            id="csv-text"
            value={csvText}
            rows={10}
            spellCheck={false}
            placeholder={CSV_PLACEHOLDER}
            onChange={(e) => handleCsv(e.target.value)}
            className="resize-y font-mono text-xs"
          />
          {csvInfo && <p className="text-xs text-neutral-400">{csvInfo}</p>}
          {csvErrors.length > 0 && (
            <ul className="space-y-0.5 rounded-lg border border-amber-800/50 bg-amber-950/20 p-2">
              {csvErrors.map((err) => (
                <li key={err} className="text-[11px] text-amber-300">
                  {err}
                </li>
              ))}
            </ul>
          )}
          <div className="flex justify-end">
            <Button onClick={toStep2} className="gap-2">
              <Table2 className="h-4 w-4" /> Дальше: превью
            </Button>
          </div>
        </section>
      )}

      {step === 2 && (
        <section className="space-y-3">
          <p className="text-xs text-neutral-500">
            Проверьте номера, названия и описания. Главу можно удалить или
            добавить — файлы привяжем на следующем шаге.
          </p>
          <ChaptersEditor
            maxChapters={MAX_CHAPTERS}
            maxPagesPerChapter={MAX_PAGES_PER_CHAPTER}
            value={chapters}
            onChange={setChapters}
            mode="fields"
          />
          <div className="flex justify-between">
            <Button variant="outline" onClick={() => setStep(1)} className="border-neutral-700">
              Назад к CSV
            </Button>
            <Button onClick={toStep3} className="gap-2" disabled={chapters.length === 0}>
              <UploadCloud className="h-4 w-4" /> Дальше: файлы
            </Button>
          </div>
        </section>
      )}

      {step === 3 && (
        <section className="space-y-4">
          <button
            type="button"
            onClick={() => filesInput.current?.click()}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              handleFiles(Array.from(e.dataTransfer.files));
            }}
            className="w-full rounded-2xl border-2 border-dashed border-neutral-700 p-8 text-center"
          >
            <UploadCloud className="mx-auto mb-3 h-8 w-8 text-rose-400" />
            <span className="block text-sm">Перетащите файлы страниц сюда или нажмите</span>
            <span className="mt-2 block text-xs text-neutral-400">
              Имена: {'{глава}.{страница}.{ext}'}, {'{глава}/{страница}.{ext}'},{' '}
              {'{глава}-{страница}.{ext}'} или {'{глава}.pdf'}
            </span>
          </button>
          <input
            ref={filesInput}
            type="file"
            multiple
            className="hidden"
            onChange={(e) => {
              handleFiles(Array.from(e.target.files ?? []));
              e.target.value = '';
            }}
          />

          {plan && plan.warnings.length > 0 && (
            <ul className="space-y-0.5 rounded-lg border border-amber-800/50 bg-amber-950/20 p-2">
              {plan.warnings.map((w) => (
                <li key={w} className="text-[11px] text-amber-300">
                  {w}
                </li>
              ))}
            </ul>
          )}

          {chapters.some((ch) => ch.pages.length > 0 || ch.pdf) && (
            <ul className="space-y-1 text-xs text-neutral-400">
              {chapters
                .filter((ch) => ch.pages.length > 0 || ch.pdf)
                .map((ch) => (
                  <li key={ch.id}>
                    Глава {ch.number || '—'}
                    {ch.name ? ` · ${ch.name}` : ''} — {ch.pages.length} стр.
                    {ch.pdf ? ` + PDF (${formatBytes(ch.pdf.size)})` : ''}
                  </li>
                ))}
            </ul>
          )}

          {reports.length > 0 && (
            <div className="space-y-2 rounded-xl border border-neutral-800 bg-neutral-900/60 p-3">
              {reports.map((r, i) => (
                <div key={`${r.number}-${i}`} className="space-y-1">
                  <div className="flex items-center justify-between gap-3 text-xs">
                    <span className="text-neutral-300">
                      Глава {r.number}
                      {r.name ? ` · ${r.name}` : ''}
                    </span>
                    <span
                      className={
                        r.status === 'created'
                          ? 'text-green-400'
                          : r.status === 'skipped'
                            ? 'text-amber-400'
                            : r.status === 'error'
                              ? 'text-red-400'
                              : 'text-neutral-500'
                      }
                    >
                      {r.detail}
                    </span>
                  </div>
                  {r.status === 'running' && (
                    <Progress value={r.total > 0 ? Math.round((r.pages / r.total) * 100) : 0} />
                  )}
                </div>
              ))}
              {done && (
                <p className="flex items-center gap-2 border-t border-neutral-800 pt-2 text-xs text-neutral-300">
                  <CheckCircle2 className="h-4 w-4 text-green-400" />
                  Создано глав: {created} · пропущено: {skipped} · с ошибками: {failed} ·
                  страниц загружено: {totalPages}
                </p>
              )}
            </div>
          )}

          <div className="flex justify-between">
            <Button
              variant="outline"
              className="border-neutral-700"
              disabled={running}
              onClick={() => setStep(2)}
            >
              Назад к превью
            </Button>
            <Button
              onClick={() => void runImport()}
              disabled={running || !isOwner || !chapters.some((ch) => ch.pages.length > 0 || ch.pdf)}
              className="gap-2"
            >
              {running ? <Loader2 className="h-4 w-4 animate-spin" /> : <UploadCloud className="h-4 w-4" />}
              {running ? 'Импорт…' : 'Импортировать главы'}
            </Button>
          </div>
        </section>
      )}
    </main>
  );
}
