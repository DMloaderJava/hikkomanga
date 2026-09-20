export interface PdfPage { blob: Blob; width: number; height: number; index: number }
interface Options { maxWidth?: number; quality?: number; onProgress?: (done: number, total: number) => void; signal?: AbortSignal }
const configuredLimit = Number(import.meta.env.VITE_MAX_PDF_PAGES);
export const MAX_PDF_PAGES = Number.isSafeInteger(configuredLimit) && configuredLimit > 0 ? configuredLimit : 500;
export function checkPdfPageCount(n: number) {
  if (n > MAX_PDF_PAGES) throw new Error(`PDF содержит ${n} страниц, лимит — ${MAX_PDF_PAGES}. Разделите на части`);
}
export function checkAbort(signal?: AbortSignal) {
  if (signal?.aborted) throw new DOMException('Загрузка отменена', 'AbortError');
}
/** Streaming API used by storage: only one rendered page is retained. */
export async function* iteratePdfPages(file: File, opts: Options = {}): AsyncGenerator<PdfPage> {
  checkAbort(opts.signal);
  const pdfjsLib = await import('pdfjs-dist');
  pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url).toString();
  checkAbort(opts.signal);
  const data = new Uint8Array(await file.arrayBuffer());
  checkAbort(opts.signal);
  const assetBase = `${import.meta.env.BASE_URL}assets/pdfjs/`;
  const task = pdfjsLib.getDocument({
    data,
    cMapUrl: `${assetBase}cmaps/`, cMapPacked: true,
    standardFontDataUrl: `${assetBase}standard_fonts/`,
    wasmUrl: `${assetBase}wasm/`, iccUrl: `${assetBase}iccs/`,
    useSystemFonts: false,
    // CSP permits no WASM compilation: use pdf.js's local JS decoder fallbacks.
    useWasm: false,
  });
  const abort = () => { void task.destroy(); };
  opts.signal?.addEventListener('abort', abort, {once:true});
  try {
    const pdf = await task.promise;
    checkAbort(opts.signal);
    checkPdfPageCount(pdf.numPages);
    for (let index = 1; index <= pdf.numPages; index++) {
      checkAbort(opts.signal);
      const page = await pdf.getPage(index);
      const base = page.getViewport({scale:1});
      const viewport = page.getViewport({scale: Math.min(1, (opts.maxWidth ?? 1600) / base.width)});
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.floor(viewport.width));
      canvas.height = Math.max(1, Math.floor(viewport.height));
      try {
        const render = page.render({canvas, canvasContext: canvas.getContext('2d')!, viewport});
        const cancelRender = () => render.cancel();
        opts.signal?.addEventListener('abort', cancelRender, {once:true});
        try { await render.promise; } finally { opts.signal?.removeEventListener('abort', cancelRender); }
        checkAbort(opts.signal);
        const blob = await new Promise<Blob>((resolve,reject) => canvas.toBlob(b => b?.type === 'image/webp' ? resolve(b) : reject(new Error(`Не удалось обработать \`${file.name}\`. Попробуйте другой файл.`)), 'image/webp', opts.quality ?? 0.85));
        checkAbort(opts.signal);
        opts.onProgress?.(index,pdf.numPages);
        yield {blob, width:canvas.width, height:canvas.height, index};
      } finally { canvas.width = canvas.height = 0; page.cleanup(); }
    }
  } catch (error) {
    checkAbort(opts.signal);
    const name = (error as Error).name;
    if (name === 'PasswordException') throw new Error(`PDF \`${file.name}\` защищён паролем — загрузка невозможна.`);
    if (name === 'InvalidPDFException') throw new Error(`PDF \`${file.name}\` не читается (повреждён).`);
    throw error;
  } finally {
    opts.signal?.removeEventListener('abort', abort);
    await task.destroy();
  }
}
export async function pdfToPages(file: File, opts: Options = {}): Promise<PdfPage[]> {
  const result: PdfPage[] = [];
  for await (const page of iteratePdfPages(file,opts)) result.push(page);
  return result;
}
