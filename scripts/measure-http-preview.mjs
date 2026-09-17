import { spawn } from 'child_process';
import http from 'http';
import { performance } from 'perf_hooks';

async function fetchUrl(url) {
  const t0 = performance.now();
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        const t1 = performance.now();
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          duration: t1 - t0,
          size: Buffer.byteLength(data),
          body: data
        });
      });
    }).on('error', reject);
  });
}

async function main() {
  const preview = spawn('npx', ['vite', 'preview', '--port', '4173', '--host', '127.0.0.1'], {
    stdio: 'ignore'
  });

  // wait for server
  await new Promise(resolve => setTimeout(resolve, 1500));

  try {
    console.log('=== HTTP PREVIEW LATENCY & ASSET BENCHMARK ===');
    
    // 1. Home Page HTML
    const home = await fetchUrl('http://127.0.0.1:4173/');
    console.log(`- GET / (Homepage HTML): ${home.duration.toFixed(2)} ms (Status: ${home.statusCode}, Size: ${home.size} B)`);

    // 2. Reader Page HTML
    const reader = await fetchUrl('http://127.0.0.1:4173/title/manga-demon-slayer/chapter/1');
    console.log(`- GET /title/manga-demon-slayer/chapter/1: ${reader.duration.toFixed(2)} ms (Status: ${reader.statusCode}, Size: ${reader.size} B)`);

    // Parse preloaded assets
    const preloads = Array.from(home.body.matchAll(/href="(\/assets\/[^"]+)"/g)).map(m => m[1]);
    const scripts = Array.from(home.body.matchAll(/src="(\/assets\/[^"]+)"/g)).map(m => m[1]);
    const allInitialAssets = Array.from(new Set([...scripts, ...preloads]));

    let totalTransfer = 0;
    console.log(`\n- Initial Assets Count (Homepage): ${allInitialAssets.length}`);
    for (const asset of allInitialAssets) {
      const res = await fetchUrl(`http://127.0.0.1:4173${asset}`);
      totalTransfer += res.size;
    }
    console.log(`- Total Initial Transfer Size (Raw): ${(totalTransfer / 1024).toFixed(2)} kB`);

    // Network latency simulations (Transfer Time = RTT + Size / Bandwidth)
    // Fast 4G: 10 Mbps (1.25 MB/s), RTT 50ms
    // Slow 4G: 1.6 Mbps (200 KB/s), RTT 150ms
    // Mobile 3G: 750 Kbps (93.75 KB/s), RTT 300ms
    const gzipSizeKb = 185.42; // from gzip analysis
    console.log('\n=== ESTIMATED NETWORK DOWNLOAD TIMES (Initial JS: 185.42 kB Gzip) ===');
    console.log(`- Fast 4G (10 Mbps, 50ms RTT, 4 roundtrips): ~${(50 * 4 + (gzipSizeKb / 1250) * 1000).toFixed(0)} ms`);
    console.log(`- Slow 4G (1.6 Mbps, 150ms RTT, 6 roundtrips): ~${(150 * 6 + (gzipSizeKb / 200) * 1000).toFixed(0)} ms`);
    console.log(`- Mobile 3G (750 Kbps, 300ms RTT, 8 roundtrips): ~${(300 * 8 + (gzipSizeKb / 93.75) * 1000).toFixed(0)} ms`);

  } finally {
    preview.kill();
  }
}

main().catch(console.error);
