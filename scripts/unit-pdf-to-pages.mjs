import assert from 'node:assert/strict';
import { createServer } from 'vite';
// Deterministic pdf.js mock: exercises orchestration, not native browser rendering.
const state = {count:3, error:null, destroyed:0, rendered:0, cleaned:0};
globalThis.__pdfTestState = state;
globalThis.document = {createElement() { return {width:0,height:0,getContext(){return {};},toBlob(cb){cb(new Blob(['webp'],{type:'image/webp'}));}}; }};
const server = await createServer({server:{middlewareMode:true},appType:'custom',ssr:{noExternal:['pdfjs-dist']},plugins:[{
  name:'mock-pdfjs',enforce:'pre',
  resolveId(id){if(id === 'pdfjs-dist') return '\0mock-pdfjs';},
  load(id){if(id === '\0mock-pdfjs') return `
    export const GlobalWorkerOptions = {};
    export function getDocument() {
      const s = globalThis.__pdfTestState;
      return {destroy:async()=>{s.destroyed++},promise: s.error ? Promise.reject(Object.assign(new Error('bad'),{name:s.error})) : Promise.resolve({
        numPages:s.count,
        getPage:async()=>({getViewport:({scale})=>({width:2000*scale,height:3000*scale}),
          render:()=>{s.rendered++;return {promise:Promise.resolve(),cancel(){}}},cleanup(){s.cleaned++}})
      })};
    }`;
  }
}]});
try {
  const {pdfToPages,MAX_PDF_PAGES} = await server.ssrLoadModule('/src/lib/pdfToPages.ts');
  const file = new File(['%PDF-1.7'],'test.pdf');
  const progress = [];
  const pages = await pdfToPages(file,{onProgress:(...args)=>progress.push(args)});
  assert.equal(pages.length,3);
  assert(pages.every(p=>p.blob.type === 'image/webp' && p.width === 1600 && p.height === 2400));
  assert.deepEqual(progress,[[1,3],[2,3],[3,3]]);
  assert.equal(state.cleaned,3);
  state.count = MAX_PDF_PAGES+1;state.rendered=0;
  await assert.rejects(pdfToPages(file),/лимит/);assert.equal(state.rendered,0);
  state.count = 3;
  const controller = new AbortController();
  await assert.rejects(pdfToPages(file,{signal:controller.signal,onProgress:()=>controller.abort()}),{name:'AbortError'});
  await assert.rejects(pdfToPages(file,{signal:AbortSignal.abort()}),{name:'AbortError'});
  for (const [name,pattern] of [['PasswordException',/паролем/],['InvalidPDFException',/повреждён/]]) {
    state.error=name;await assert.rejects(pdfToPages(file),pattern);
  }
  assert(state.destroyed>=5);
  console.log('PASS PDF orchestration (mock): 3 WebP blobs, progress, limit before render, abort, errors, cleanup');
} finally {await server.close();delete globalThis.document;delete globalThis.__pdfTestState;}
