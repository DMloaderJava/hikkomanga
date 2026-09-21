import assert from 'node:assert/strict';
import { createServer } from 'vite';
const server = await createServer({server:{middlewareMode:true},appType:'custom'});
try {
  const {detectFormat,validateFile,signature,ALLOWED_EXT,FILE_ACCEPT,formatAllowed,naturalCompare} = await server.ssrLoadModule('/src/lib/imageFormats.ts');
  const {prepareQueue,runQueue} = await server.ssrLoadModule('/src/lib/pageUploadQueue.ts');
  const gifHeader = [...Buffer.from('GIF89a'),1,0,1,0,0,0,0];
  const frame = [0x2c,0,0,0,0,1,0,1,0,0,2,2,0x44,1,0];
  const samples = {
    jpg:[255,216,255],jpeg:[255,216,255],png:[137,80,78,71,13,10,26,10],
    webp:Buffer.from('RIFF0000WEBP'),gif:[...gifHeader,...frame,0x3b],
    avif:Buffer.from('0000ftypavif'),bmp:Buffer.from('BM'),tif:Buffer.from('II*\0'),tiff:Buffer.from('MM\0*'),
    heic:Buffer.from('0000ftypheic'),heif:Buffer.from('0000ftypmif1'),pdf:Buffer.from('%PDF-1.7')
  };
  for (const ext of ALLOWED_EXT) {
    const file = new File([new Uint8Array(samples[ext])],`test.${ext}`);
    assert.equal(formatAllowed(ext),true);
    assert.equal(await detectFormat(file),ext === 'pdf' ? 'pdf' : 'image',ext);
    assert.equal((await validateFile(file)).ok,true,ext);
  }
  assert.equal(await detectFormat(new File([new Uint8Array([...gifHeader,...frame,...frame,0x3b])],'animated.gif')),'animated-gif');
  assert.equal(await detectFormat(new File([new Uint8Array([...gifHeader,0x21,0xfe,3,0x2c,0x2c,0x2c,0,...frame,0x3b])],'comment.gif')),'image');
  assert.equal(await detectFormat(new File(['GIF89a'],'broken.gif')),'animated-gif');
  assert.equal(await detectFormat(new File([],'empty.png')),'empty');
  for (const ext of ['txt','zip']) assert.equal(await detectFormat(new File(['hello'],`a.${ext}`)),'unsupported');
  for (const [ext,limit] of [['jpg',20],['pdf',200]]) {
    const file = new File([new Uint8Array(samples[ext])],`big.${ext}`);
    Object.defineProperty(file,'size',{value:limit*1024**2+1});
    assert.equal((await validateFile(file)).ok,false);
  }
  assert.equal((await validateFile(new File([new Uint8Array(samples.png)],'misnamed.jpg'))).ok,true);
  assert.deepEqual(['10.jpg','2.jpg','1.jpg'].sort(naturalCompare),['1.jpg','2.jpg','10.jpg']);
  const queue = await prepareQueue(['10.jpg','doc.pdf','2.jpg','1.jpg'].map(name => new File([new Uint8Array(samples[name.split('.').pop()])],name)));
  assert.deepEqual(queue.map(x => x.file.name),['1.jpg','2.jpg','10.jpg','doc.pdf']);
  await assert.rejects(prepareQueue(Array(101).fill(new File([],'empty'))),/100/);
  const uploads = [], errors = [];
  const uploadPageFromBlob = async file => {if(file === 'bad') throw Error('network');uploads.push(file);};
  await runQueue(['one','bad','three'],uploadPageFromBlob,(error,index) => errors.push(index));
  assert.deepEqual(uploads,['one','three']);assert.deepEqual(errors,[1]);
  // ── Magic bytes: расширение не определяет формат, только сигнатура ──────
  const magicCases = [
    ['jpg',[255,216,255]],['png',[137,80,78,71,13,10,26,10]],
    ['webp',Buffer.from('RIFF0000WEBP')],['gif',Buffer.from('GIF89a')],
    ['avif',Buffer.from('0000ftypavif')],['heic',Buffer.from('0000ftypheic')],
    ['heic',Buffer.from('0000ftypmif1')],['bmp',Buffer.from('BM')],
    ['tiff',Buffer.from('II*\0')],['tiff',Buffer.from('MM\0*')],['pdf',Buffer.from('%PDF-1.7')],
  ];
  for (const [expected,bytes] of magicCases) {
    assert.equal(await signature(new File([new Uint8Array(bytes)],'x.bin')),expected,String(bytes));
  }
  assert.equal(await signature(new File(['not an image'],'x.bin')),'');

  // PDF под картинковым именем остаётся pdf: разбивка на страницы обязательна.
  assert.equal(await detectFormat(new File([new Uint8Array(Buffer.from('%PDF-1.7'))],'page-1.jpg')),'pdf');
  assert.equal((await validateFile(new File([new Uint8Array(Buffer.from('%PDF-1.7'))],'page-1.jpg'))).ok,true);

  // Канонические имена из ChaptersEditor (ch-{n}-page-{m}.webp) проходят валидацию.
  const canonical = new File([new Uint8Array(Buffer.from('RIFF0000WEBP'))],'ch-3-page-12.webp');
  assert.equal((await validateFile(canonical)).ok,true);
  assert.equal(await detectFormat(canonical),'image');

  // Анимированный GIF не жмётся: kind='animated-gif', валидация пропускает.
  const animated = new File([new Uint8Array([...gifHeader,...frame,...frame,0x3b])],'ch-1-page-1.gif');
  assert.equal(await detectFormat(animated),'animated-gif');
  assert.equal((await validateFile(animated)).ok,true);

  // accept-атрибут дропзоны включает PDF и все расширения ТЗ.
  for (const ext of ALLOWED_EXT) assert.ok(FILE_ACCEPT.includes(`.${ext}`),ext);

  console.log('PASS page signatures, GIF blocks, limits, sorting, queue isolation');
} finally { await server.close(); }
