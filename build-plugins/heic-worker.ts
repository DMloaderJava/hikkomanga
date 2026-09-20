import type { Plugin } from 'vite';

/** heic2any's bundled decoder uses new Function. Isolate its CSP to a local
 * worker response rather than allowing unsafe-eval in the application page. */
export function localHeicWorker(): Plugin {
  return {
    name: 'local-heic-worker',
    enforce: 'pre',
    apply: 'build',
    transform(code, id) {
      if (!id.replace(/\\/g, '/').endsWith('/heic2any/dist/heic2any.js')) return;
      const match = code.match(/var workerString = ("(?:[^"\\]|\\.)*");/);
      if (!match) throw new Error('heic2any worker layout changed; review local worker extraction');
      const ref = this.emitFile({type:'asset',name:'heic-decoder-worker.js',source:JSON.parse(match[1])});
      return code.replace(match[0], '')
        .replace("var blob = new Blob([workerString], {type: 'application/javascript'});", '')
        .replace('new Worker(URL.createObjectURL(blob))', `new Worker(import.meta.ROLLUP_FILE_URL_${ref})`);
    },
  };
}
