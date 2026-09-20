import type { Plugin } from 'vite';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const root = path.dirname(require.resolve('pdfjs-dist/package.json'));
const folders = ['cmaps','standard_fonts','wasm','iccs'];
/** Keep fonts and scanned-PDF decoders local too; no CDN or missing CJK assets. */
export function localPdfAssets(): Plugin {
  let building = false;
  return {
    configResolved(config) { building = config.command === 'build'; },
    name: 'local-pdf-assets',
    buildStart() {
      if (!building) return;
      for (const folder of folders) for (const file of fs.readdirSync(path.join(root,folder))) {
        this.emitFile({type:'asset',fileName:`assets/pdfjs/${folder}/${file}`,source:fs.readFileSync(path.join(root,folder,file))});
      }
    },
    configureServer(server) {
      server.middlewares.use('/assets/pdfjs/', (req,res,next) => {
        const parts = (req.url || '').split('?')[0].split('/').filter(Boolean);
        if (parts.length !== 2 || !folders.includes(parts[0]) || !/^[\w.-]+$/.test(parts[1])) return next();
        const file = path.join(root,...parts);
        if (!fs.existsSync(file)) return next();
        res.setHeader('Content-Type',file.endsWith('.wasm') ? 'application/wasm' : file.endsWith('.js') ? 'text/javascript' : 'application/octet-stream');
        res.end(fs.readFileSync(file));
      });
    },
  };
}
