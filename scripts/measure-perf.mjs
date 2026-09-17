import fs from 'fs';
import path from 'path';
import zlib from 'zlib';

function getFiles(dir) {
  let results = [];
  const list = fs.readdirSync(dir);
  list.forEach(file => {
    file = path.join(dir, file);
    const stat = fs.statSync(file);
    if (stat && stat.isDirectory()) {
      results = results.concat(getFiles(file));
    } else {
      results.push(file);
    }
  });
  return results;
}

const allFiles = getFiles('dist').filter(f => !f.endsWith('stats.html'));
const filesData = allFiles.map(f => {
  const buf = fs.readFileSync(f);
  const rel = path.relative('dist', f);
  return {
    file: rel,
    raw: buf.length,
    gz: zlib.gzipSync(buf).length,
    isJs: rel.endsWith('.js'),
    isCss: rel.endsWith('.css'),
    isMedia: rel.startsWith('media/'),
    isHtml: rel.endsWith('.html'),
  };
});

filesData.sort((a, b) => b.gz - a.gz);

console.log('=== ALL ASSETS SORTED BY GZIP ===');
filesData.forEach(x => {
  console.log(`${x.file.padEnd(55)} | Raw: ${(x.raw/1024).toFixed(2).padStart(7)} kB | Gzip: ${(x.gz/1024).toFixed(2).padStart(7)} kB`);
});

const indexHtml = fs.readFileSync('dist/index.html', 'utf8');
const scriptMatches = Array.from(indexHtml.matchAll(/<script[^>]+src=["']([^"']+)["']/g)).map(m => m[1].replace(/^\//, ''));
const preloadMatches = Array.from(indexHtml.matchAll(/<link[^>]+rel=["']modulepreload["'][^>]+href=["']([^"']+)["']/g)).map(m => m[1].replace(/^\//, ''));
const initialJsFiles = Array.from(new Set([...scriptMatches, ...preloadMatches]));

console.log('\n=== INITIAL JS (LOADED ON HOMEPAGE) ===');
let initialRaw = 0;
let initialGz = 0;
initialJsFiles.forEach(f => {
  const item = filesData.find(x => x.file === f);
  if (item) {
    initialRaw += item.raw;
    initialGz += item.gz;
    console.log(`${item.file.padEnd(55)} | Raw: ${(item.raw/1024).toFixed(2).padStart(7)} kB | Gzip: ${(item.gz/1024).toFixed(2).padStart(7)} kB`);
  } else {
    console.log(`NOT FOUND: ${f}`);
  }
});

console.log(`\nINITIAL JS TOTAL: Raw = ${(initialRaw/1024).toFixed(2)} kB (${initialRaw} B) | Gzip = ${(initialGz/1024).toFixed(2)} kB (${initialGz} B)`);

const totalDistRaw = filesData.reduce((acc, x) => acc + x.raw, 0);
const totalDistGz = filesData.reduce((acc, x) => acc + x.gz, 0);
const jsOnly = filesData.filter(x => x.isJs);
const totalJsRaw = jsOnly.reduce((acc, x) => acc + x.raw, 0);
const totalJsGz = jsOnly.reduce((acc, x) => acc + x.gz, 0);
const mediaOnly = filesData.filter(x => x.isMedia);
const totalMediaRaw = mediaOnly.reduce((acc, x) => acc + x.raw, 0);
const totalMediaGz = mediaOnly.reduce((acc, x) => acc + x.gz, 0);

console.log(`\nTOTAL DIST (excl stats.html): Raw = ${(totalDistRaw/1024).toFixed(2)} kB | Gzip = ${(totalDistGz/1024).toFixed(2)} kB`);
console.log(`TOTAL JS: Raw = ${(totalJsRaw/1024).toFixed(2)} kB | Gzip = ${(totalJsGz/1024).toFixed(2)} kB`);
console.log(`TOTAL MEDIA: Raw = ${(totalMediaRaw/1024).toFixed(2)} kB | Gzip = ${(totalMediaGz/1024).toFixed(2)} kB`);
