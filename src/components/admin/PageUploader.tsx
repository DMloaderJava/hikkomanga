import { useState, useRef, useEffect } from 'react';
import { storage, uploadErrorMessage } from '@/data/storage';
import { pages as pagesApi } from '@/data/pages';
import { FILE_ACCEPT } from '@/lib/imageFormats';
import { prepareQueue, runQueue, type QueueFile } from '@/lib/pageUploadQueue';
import { checkAbort } from '@/lib/pdfToPages';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { UploadCloud, FileImage } from 'lucide-react';

interface Props { chapterId: string; currentPagesCount: number; onPagesUploaded: () => void }
interface Card extends QueueFile { controller: AbortController; preview?: string; status: string; progress: number; finished: boolean }
export function PageUploader({chapterId, onPagesUploaded}: Props) {
  const [cards,setCards] = useState<Card[]>([]);
  const [uploading,setUploading] = useState(false);
  const [error,setError] = useState('');
  const [dragging,setDragging] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const busy = useRef(false);
  const active = useRef<Card[]>([]);
  const previews = useRef<string[]>([]);
  useEffect(() => () => {
    active.current.forEach(c => c.controller.abort());
    previews.current.forEach(url => URL.revokeObjectURL(url));
  },[]);
  useEffect(() => {
    const beforeUnload = (e: BeforeUnloadEvent) => { if (uploading) { e.preventDefault(); e.returnValue = ''; } };
    window.addEventListener('beforeunload',beforeUnload);
    return () => window.removeEventListener('beforeunload',beforeUnload);
  },[uploading]);
  const patch = (index: number, update: Partial<Card>) => setCards(old => old.map((c,i) => i === index ? {...c,...update} : c));
  const handleFiles = async (files: File[]) => {
    if (busy.current || !files.length) return;
    busy.current = true; setUploading(true); setError('');
    try {
      const queue = await prepareQueue(files);
      previews.current.forEach(url => URL.revokeObjectURL(url)); previews.current = [];
      const next = queue.map(item => {
        const preview = item.kind && item.kind !== 'pdf' ? URL.createObjectURL(item.file) : undefined;
        if (preview) previews.current.push(preview);
        return {...item,preview,controller:new AbortController(),status:item.error || 'В очереди',progress:0,finished:!!item.error};
      });
      active.current = next; setCards(next);
      const existing = await pagesApi.listByChapter(chapterId);
      let order = Math.max(0,...existing.map(p => p.page_order)) + 1;
      await runQueue(next,async (card,index) => {
        if (card.error) return;
        const signal = card.controller.signal;
        checkAbort(signal);
        const save = async (result: {image_url:string;original_url:string|null}) => {
          try { await pagesApi.create({chapter_id:chapterId,...result,page_order:order}); }
          catch (error) { await storage.deletePage(result.image_url, result.original_url); throw error; }
          order++;
          onPagesUploaded();
        };
        if (card.kind === 'pdf') {
          patch(index,{status:'Разбор PDF…'});
          for await (const page of storage.iteratePdfUploads(chapterId,card.file,order,(stage,done,total) => {
            patch(index,{status:`${stage === 'parsing' ? 'Разбор PDF' : 'Загрузка страниц'} (${done}/${total})`,progress:Math.round(((stage === 'parsing' ? done - 0.5 : done) / total) * 100)});
          },signal)) await save(page);
        } else {
          patch(index,{status:card.kind === 'animated-gif' ? 'Загрузка GIF без сжатия…' : 'Обработка и загрузка…'});
          // Native image decoders and Supabase uploads are not interruptible; keep a completed upload.
          const result = await storage.uploadPage(chapterId,card.file,order);
          await save(result);
          checkAbort(signal);
        }
        patch(index,{status:'Готово',progress:100,finished:true});
      },(err,index) => patch(index,{status:uploadErrorMessage(err,next[index].file.name),error:uploadErrorMessage(err,next[index].file.name),finished:true}));
    } catch (err) { setError((err as Error).message); }
    finally { busy.current = false; setUploading(false); if (input.current) input.current.value = ''; }
  };
  return <div className="space-y-4">
    {error && <p role="alert" className="text-sm text-red-400">{error}</p>}
    <button type="button" disabled={uploading} onClick={() => input.current?.click()}
      onDragOver={e => {e.preventDefault();setDragging(true);}} onDragLeave={() => setDragging(false)}
      onDrop={e => {e.preventDefault();setDragging(false);void handleFiles(Array.from(e.dataTransfer.files));}}
      className={`w-full rounded-2xl border-2 border-dashed p-8 text-center disabled:opacity-60 ${dragging ? 'border-rose-500' : 'border-neutral-700'}`}>
      <UploadCloud className="mx-auto mb-3 h-8 w-8 text-rose-400" />
      <span className="block">Перетащите файлы сюда или нажмите для выбора</span>
      <span className="mt-2 block text-xs text-neutral-400">JPG, PNG, WebP, GIF, AVIF, BMP, TIFF, HEIC/HEIF — до 20 MB. PDF — до 200 MB. До 100 файлов за раз.</span>
    </button>
    <input ref={input} type="file" multiple disabled={uploading} accept={FILE_ACCEPT} className="hidden" onChange={e => e.target.files && void handleFiles(Array.from(e.target.files))} />
    {cards.map((card,i) => <div key={i} className="flex items-start gap-3 rounded-xl border border-neutral-800 p-4">
      {card.preview ? <img src={card.preview} alt="" className="h-16 w-12 object-contain" onError={e => {e.currentTarget.style.display = 'none';}} /> : <FileImage className="h-12 w-12 shrink-0 text-neutral-500" />}
      <div className="min-w-0 flex-1 space-y-2"><p className="break-all text-sm">{card.file.name}</p>
        <p aria-live="polite" className={`text-xs ${card.error ? 'text-red-400' : 'text-neutral-400'}`}>{card.status}</p>
        <Progress value={card.progress} />
      </div>
      {!card.finished && <Button type="button" variant="outline" size="sm" onClick={() => {card.controller.abort();patch(i,{status:'Отмена…'});}}>Отменить</Button>}
    </div>)}
  </div>;
}
