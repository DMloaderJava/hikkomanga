import { signature, validateFile } from './imageFormats';
import { compressToWebP } from './imageCompress';
export async function preparePageImage(file: File): Promise<Blob> {
  const validation = await validateFile(file);
  if (!validation.ok) throw new Error(validation.reason);
  if (validation.kind === 'pdf') throw new Error('PDF необходимо загрузить через разбивку на страницы.');
  if (validation.kind === 'animated-gif') return new Blob([file], {type:'image/gif'});
  try {
    const format = await signature(file);
    let source: Blob = file;
    if (format === 'heic') {
      const {default: heic2any} = await import('heic2any');
      const converted = await heic2any({blob:file, toType:'image/png'});
      source = Array.isArray(converted) ? converted[0] : converted;
    } else if (format === 'tiff') {
      const UTIF = await import('utif');
      const buffer = await file.arrayBuffer();
      const [image] = UTIF.decode(buffer);
      UTIF.decodeImage(buffer,image);
      const canvas = document.createElement('canvas');
      canvas.width = image.width; canvas.height = image.height;
      try {
        const rgba = new Uint8ClampedArray(UTIF.toRGBA8(image));
        canvas.getContext('2d')!.putImageData(new ImageData(rgba,image.width,image.height),0,0);
        source = await new Promise<Blob>((resolve,reject) => canvas.toBlob(b => b ? resolve(b) : reject(new Error('TIFF')), 'image/png'));
      } finally { canvas.width = canvas.height = 0; }
    }
    const output = await compressToWebP(source,1600);
    if (output.type !== 'image/webp') throw new Error('WebP encoding unavailable');
    return output;
  } catch { throw new Error(`Не удалось обработать \`${file.name}\`. Попробуйте другой файл.`); }
}
