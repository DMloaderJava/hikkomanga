import { createServer } from 'vite';
import { performance } from 'perf_hooks';

const server = await createServer({
  server: { middlewareMode: true },
  appType: 'custom',
  logLevel: 'error',
});

try {
  const { titles } = await server.ssrLoadModule('/src/data/titles.ts');
  const { chapters } = await server.ssrLoadModule('/src/data/chapters.ts');
  const { pages } = await server.ssrLoadModule('/src/data/pages.ts');
  const { genres } = await server.ssrLoadModule('/src/data/genres.ts');
  const { queryClient, readerQueryKeys } = await server.ssrLoadModule('/src/lib/queryClient.ts');

  console.log('=== DATA & READER TIMING BENCHMARKS ===');

  // 1. Homepage data loader
  const t0 = performance.now();
  const [publishedTitles, allGenres] = await Promise.all([
    titles.listPublished(),
    genres.list(),
  ]);
  const t1 = performance.now();
  console.log(`- Homepage Catalog Fetch: ${(t1 - t0).toFixed(2)} ms (${publishedTitles.length} titles, ${allGenres.length} genres)`);

  // 2. Reader Cold Chapter Load
  const title = publishedTitles[0];
  const t2 = performance.now();
  const titleData = await titles.getBySlug(title.slug);
  const chapterList = await chapters.listByTitle(titleData.id, true);
  const chapter1 = chapterList[0];
  const [chapterPages, nav] = await Promise.all([
    pages.listByChapter(chapter1.id),
    chapters.getNextAndPrev(titleData.id, chapter1.number),
  ]);
  const t3 = performance.now();
  console.log(`- Reader Cold Load (Chapter ${chapter1.number}): ${(t3 - t2).toFixed(2)} ms (${chapterPages.length} pages)`);

  // 3. Reader Next Chapter Load (Uncached)
  let nextTiming = 0;
  if (nav.nextChapter) {
    const t4 = performance.now();
    const nextChapterData = await chapters.getByNumber(titleData.id, nav.nextChapter.number);
    const [nextPages] = await Promise.all([
      pages.listByChapter(nextChapterData.id),
      chapters.getNextAndPrev(titleData.id, nextChapterData.number),
    ]);
    const t5 = performance.now();
    nextTiming = t5 - t4;
    console.log(`- Reader Next Chapter Load (Chapter ${nav.nextChapter.number}): ${nextTiming.toFixed(2)} ms (${nextPages.length} pages)`);
  }

  // 4. Repeated Uncached Fetch Latency (50 iterations)
  const iterations = 50;
  const t6 = performance.now();
  for (let i = 0; i < iterations; i++) {
    const td = await titles.getBySlug(title.slug);
    const cd = await chapters.getByNumber(td.id, chapter1.number);
    await Promise.all([
      pages.listByChapter(cd.id),
      chapters.getNextAndPrev(td.id, cd.number),
    ]);
  }
  const t7 = performance.now();
  const avgUncached = (t7 - t6) / iterations;
  console.log(`- Reader Repeated Uncached Loader: ${avgUncached.toFixed(4)} ms / navigation (50 iterations avg)`);

  // 5. Repeated Cached Navigation via QueryClient (50 iterations)
  // Ensure cache is populated
  const td = await queryClient.ensureQueryData({
    queryKey: readerQueryKeys.title(title.slug),
    queryFn: () => titles.getBySlug(title.slug),
    staleTime: 1000 * 60 * 5,
  });
  const cd = await queryClient.ensureQueryData({
    queryKey: readerQueryKeys.chapter(td.id, chapter1.number),
    queryFn: () => chapters.getByNumber(td.id, chapter1.number),
    staleTime: Infinity,
  });
  await Promise.all([
    queryClient.ensureQueryData({
      queryKey: readerQueryKeys.pages(cd.id),
      queryFn: () => pages.listByChapter(cd.id),
      staleTime: Infinity,
    }),
    queryClient.ensureQueryData({
      queryKey: readerQueryKeys.nav(td.id, cd.number),
      queryFn: () => chapters.getNextAndPrev(td.id, cd.number),
      staleTime: Infinity,
    }),
  ]);

  const t8 = performance.now();
  for (let i = 0; i < iterations; i++) {
    const qTitle = await queryClient.ensureQueryData({
      queryKey: readerQueryKeys.title(title.slug),
      queryFn: () => titles.getBySlug(title.slug),
      staleTime: 1000 * 60 * 5,
    });
    const qChapter = await queryClient.ensureQueryData({
      queryKey: readerQueryKeys.chapter(qTitle.id, chapter1.number),
      queryFn: () => chapters.getByNumber(qTitle.id, chapter1.number),
      staleTime: Infinity,
    });
    await Promise.all([
      queryClient.ensureQueryData({
        queryKey: readerQueryKeys.pages(qChapter.id),
        queryFn: () => pages.listByChapter(qChapter.id),
        staleTime: Infinity,
      }),
      queryClient.ensureQueryData({
        queryKey: readerQueryKeys.nav(qTitle.id, qChapter.number),
        queryFn: () => chapters.getNextAndPrev(qTitle.id, qChapter.number),
        staleTime: Infinity,
      }),
    ]);
  }
  const t9 = performance.now();
  const avgCached = (t9 - t8) / iterations;
  console.log(`- Reader Cached Repeat Navigation (QueryClient): ${avgCached.toFixed(4)} ms / navigation (50 iterations avg)`);

} finally {
  await server.close();
  process.exit(0);
}
