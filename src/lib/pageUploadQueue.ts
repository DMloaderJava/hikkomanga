import { naturalCompare, validateFile, type FileKind } from './imageFormats';
export interface QueueFile { file: File; kind?: FileKind; error?: string }
export async function prepareQueue(files: File[]): Promise<QueueFile[]> {
  if (files.length > 100) throw new Error(`Выбрано ${files.length} файлов. За один раз можно загрузить не более 100 файлов.`);
  const queue: QueueFile[] = [];
  for (const file of files) {
    try {
      const result = await validateFile(file);
      queue.push(result.ok ? {file,kind:result.kind} : {file,error:result.reason});
    } catch { queue.push({file,error:`Не удалось обработать \`${file.name}\`. Попробуйте другой файл.`}); }
  }
  return queue.sort((a,b) => Number(a.kind === 'pdf') - Number(b.kind === 'pdf') || naturalCompare(a.file.name,b.file.name));
}
export async function runQueue<T>(items: T[], upload: (item: T, index: number) => Promise<void>, onError: (error: unknown, index: number) => void) {
  for (let i = 0; i < items.length; i++) {
    try { await upload(items[i],i); } catch (error) { onError(error,i); }
  }
}
