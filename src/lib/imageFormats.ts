export const IMAGE_EXT = ['jpg','jpeg','png','webp','gif','avif','bmp','tiff','tif','heic','heif'] as const;
export const DOC_EXT = ['pdf'] as const;
export const ALLOWED_EXT = [...IMAGE_EXT, ...DOC_EXT];
export const FILE_ACCEPT = ALLOWED_EXT.map(x => `.${x}`).join(',') + ',image/jpeg,image/png,image/webp,image/gif,image/avif,image/bmp,image/tiff,image/heic,image/heif,application/pdf';
export type FileKind = 'image' | 'pdf' | 'animated-gif';
export const formatAllowed = (ext: string): boolean => (ALLOWED_EXT as readonly string[]).includes(ext.toLowerCase().replace(/^\./, ''));
export const naturalCompare = new Intl.Collator('ru', { numeric: true, sensitivity: 'base' }).compare;

export async function signature(file: Blob): Promise<string> {
  const b = new Uint8Array(await file.slice(0, 64).arrayBuffer());
  const text = (start: number, end: number) => String.fromCharCode(...b.slice(start, end));
  if (b[0] === 255 && b[1] === 216 && b[2] === 255) return 'jpg';
  if ([137,80,78,71,13,10,26,10].every((n,i) => b[i] === n)) return 'png';
  if (text(0,4) === 'RIFF' && text(8,12) === 'WEBP') return 'webp';
  if (['GIF87a','GIF89a'].includes(text(0,6))) return 'gif';
  if (text(4,8) === 'ftyp') {
    const brands = [text(8,12)];
    for (let i = 16; i + 4 <= b.length; i += 4) brands.push(text(i,i+4));
    if (brands.some(x => ['avif','avis'].includes(x))) return 'avif';
    if (brands.some(x => ['heic','heix','hevc','hevx','mif1','msf1'].includes(x))) return 'heic';
  }
  if (text(0,2) === 'BM') return 'bmp';
  if (text(0,4) === 'II*\0' || text(0,4) === 'MM\0*') return 'tiff';
  if (text(0,5) === '%PDF-') return 'pdf';
  return '';
}

// Parse block boundaries, never count 0x2c inside palettes, comments or LZW data.
function animatedGif(b: Uint8Array): boolean {
  if (b.length < 13) return true;
  let p = 13 + ((b[10] & 128) ? 3 * (1 << ((b[10] & 7) + 1)) : 0), frames = 0;
  const skipBlocks = () => {
    while (p < b.length) { const size = b[p++]; if (!size) return true; p += size; }
    return false;
  };
  while (p < b.length) {
    const tag = b[p++];
    if (tag === 0x3b) return frames !== 1;
    if (tag === 0x21) { p++; if (!skipBlocks()) return true; }
    else if (tag === 0x2c) {
      if (++frames > 1) return true;
      if (p + 9 > b.length) return true;
      const packed = b[p + 8]; p += 9;
      if (packed & 128) p += 3 * (1 << ((packed & 7) + 1));
      p++; // LZW minimum code size
      if (!skipBlocks()) return true;
    } else return true;
  }
  return true; // truncated/ambiguous: preserve animation
}
export async function detectFormat(file: File): Promise<FileKind | 'unsupported' | 'empty'> {
  if (!file.size) return 'empty';
  const ext = await signature(file);
  if (!ext) return 'unsupported';
  if (ext === 'pdf') return 'pdf';
  if (ext === 'gif' && (file.size > 20 * 1024 ** 2 || animatedGif(new Uint8Array(await file.arrayBuffer())))) return 'animated-gif';
  return 'image';
}
export async function validateFile(file: File): Promise<{ok: true; kind: FileKind} | {ok: false; reason: string}> {
  const kind = await detectFormat(file);
  const ext = file.name.split('.').pop()?.toLowerCase() || '';
  if (kind === 'empty') return {ok: false, reason: `Файл \`${file.name}\` пуст.`};
  if (kind === 'unsupported') return {ok: false, reason: `Файл \`${file.name}\`: формат \`${ext}\` не поддерживается. Допустимо: JPG, PNG, WebP, GIF, AVIF, BMP, TIFF, HEIC, PDF.`};
  const actual = await signature(file);
  const normalized = ({jpeg:'jpg', tif:'tiff', heif:'heic'} as Record<string,string>)[ext] || ext;
  if (normalized !== actual) console.warn(`[pages] ${file.name}: расширение ${ext} не совпадает с сигнатурой ${actual}`);
  if (file.size > (kind === 'pdf' ? 200 : 20) * 1024 ** 2) return {ok:false, reason: kind === 'pdf' ? `PDF \`${file.name}\` больше 200 MB — лимит хранения.` : `Файл \`${file.name}\` больше 20 MB. Сожмите или загрузите по частям.`};
  return {ok:true, kind};
}
