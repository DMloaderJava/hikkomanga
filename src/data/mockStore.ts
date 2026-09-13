import type { Title, Chapter, Page, Genre, TitleInput, ChapterInput, PageInput } from './types';

const INITIAL_GENRES: Genre[] = [
  { id: 'g-1', name: 'Экшен' },
  { id: 'g-2', name: 'Приключения' },
  { id: 'g-3', name: 'Комедия' },
  { id: 'g-4', name: 'Драма' },
  { id: 'g-5', name: 'Фэнтези' },
  { id: 'g-6', name: 'Мистика' },
  { id: 'g-7', name: 'Романтика' },
  { id: 'g-8', name: 'Сёнен' },
  { id: 'g-9', name: 'Исекай' },
];

const INITIAL_TITLES: Title[] = [
  {
    id: 't-1',
    slug: 'podnyatie-urovnya-v-odinochku',
    title: 'Поднятие уровня в одиночку',
    author: 'Chugong',
    description: '10 лет назад открылись Врата, соединившие наш мир с миром монстров. С тех пор некоторые люди обрели сверхспособности. Их называют Охотниками.',
    cover_url: 'https://images.unsplash.com/photo-1578632767115-351597cf2477?w=600&auto=format&fit=crop&q=80',
    status: 'completed',
    published: true,
    created_at: new Date(Date.now() - 86400000 * 10).toISOString(),
    genres: [INITIAL_GENRES[0], INITIAL_GENRES[1], INITIAL_GENRES[4]],
  },
  {
    id: 't-2',
    slug: 'magicheskaya-bitva',
    title: 'Магическая битва',
    author: 'Гэгэ Акутами',
    description: 'Старшеклассник Юдзи Итадори обладает выдающейся физической силой. Однажды в руки членов оккультного клуба попадает проклятый предмет высокой опасности...',
    cover_url: 'https://images.unsplash.com/photo-1607604276583-eef5d076aa5f?w=600&auto=format&fit=crop&q=80',
    status: 'ongoing',
    published: true,
    created_at: new Date(Date.now() - 86400000 * 5).toISOString(),
    genres: [INITIAL_GENRES[0], INITIAL_GENRES[5], INITIAL_GENRES[7]],
  },
  {
    id: 't-3',
    slug: 'klinok-rassekayushchiy-demonov',
    title: 'Клинок, рассекающий демонов',
    author: 'Коёхару Готогэ',
    description: 'Эпоха Тайсё. Тандзиро Камадо отправляется в путь, чтобы вернуть человеческий облик своей сестре Нэдзуко и уничтожить демона, погубившего их семью.',
    cover_url: 'https://images.unsplash.com/photo-1618005182384-a83a8bd57fbe?w=600&auto=format&fit=crop&q=80',
    status: 'completed',
    published: true,
    created_at: new Date(Date.now() - 86400000 * 2).toISOString(),
    genres: [INITIAL_GENRES[0], INITIAL_GENRES[1], INITIAL_GENRES[3], INITIAL_GENRES[7]],
  },
];

const INITIAL_CHAPTERS: Chapter[] = [
  {
    id: 'c-1',
    title_id: 't-1',
    number: 1,
    name: 'Пролог и Врата',
    published: true,
    created_at: new Date(Date.now() - 86400000 * 9).toISOString(),
  },
  {
    id: 'c-2',
    title_id: 't-1',
    number: 2,
    name: 'Скрытый квест',
    published: true,
    created_at: new Date(Date.now() - 86400000 * 8).toISOString(),
  },
  {
    id: 'c-3',
    title_id: 't-1',
    number: 3,
    name: 'Двойное подземелье',
    published: true,
    created_at: new Date(Date.now() - 86400000 * 7).toISOString(),
  },
  {
    id: 'c-4',
    title_id: 't-2',
    number: 1,
    name: 'Двуликий призрак',
    published: true,
    created_at: new Date(Date.now() - 86400000 * 4).toISOString(),
  },
  {
    id: 'c-5',
    title_id: 't-2',
    number: 2,
    name: 'Смертный приговор',
    published: true,
    created_at: new Date(Date.now() - 86400000 * 3).toISOString(),
  },
  {
    id: 'c-6',
    title_id: 't-3',
    number: 1,
    name: 'Жестокость',
    published: true,
    created_at: new Date(Date.now() - 86400000 * 1).toISOString(),
  },
];

const INITIAL_PAGES: Page[] = [
  {
    id: 'p-1-1',
    chapter_id: 'c-1',
    image_url: 'https://images.unsplash.com/photo-1534447677768-be436bb09401?w=1200&auto=format&fit=crop&q=80',
    original_url: 'https://images.unsplash.com/photo-1534447677768-be436bb09401?w=1200&auto=format&fit=crop&q=80',
    page_order: 1,
  },
  {
    id: 'p-1-2',
    chapter_id: 'c-1',
    image_url: 'https://images.unsplash.com/photo-1563089145-599997674d42?w=1200&auto=format&fit=crop&q=80',
    original_url: 'https://images.unsplash.com/photo-1563089145-599997674d42?w=1200&auto=format&fit=crop&q=80',
    page_order: 2,
  },
  {
    id: 'p-1-3',
    chapter_id: 'c-1',
    image_url: 'https://images.unsplash.com/photo-1579783902614-a3fb3927b675?w=1200&auto=format&fit=crop&q=80',
    original_url: 'https://images.unsplash.com/photo-1579783902614-a3fb3927b675?w=1200&auto=format&fit=crop&q=80',
    page_order: 3,
  },
  {
    id: 'p-2-1',
    chapter_id: 'c-2',
    image_url: 'https://images.unsplash.com/photo-1518709268805-4e9042af9f23?w=1200&auto=format&fit=crop&q=80',
    original_url: 'https://images.unsplash.com/photo-1518709268805-4e9042af9f23?w=1200&auto=format&fit=crop&q=80',
    page_order: 1,
  },
  {
    id: 'p-2-2',
    chapter_id: 'c-2',
    image_url: 'https://images.unsplash.com/photo-1541701494587-cb58502866ab?w=1200&auto=format&fit=crop&q=80',
    original_url: 'https://images.unsplash.com/photo-1541701494587-cb58502866ab?w=1200&auto=format&fit=crop&q=80',
    page_order: 2,
  },
  {
    id: 'p-3-1',
    chapter_id: 'c-3',
    image_url: 'https://images.unsplash.com/photo-1518709268805-4e9042af9f23?w=1200&auto=format&fit=crop&q=80',
    original_url: 'https://images.unsplash.com/photo-1518709268805-4e9042af9f23?w=1200&auto=format&fit=crop&q=80',
    page_order: 1,
  },
  {
    id: 'p-4-1',
    chapter_id: 'c-4',
    image_url: 'https://images.unsplash.com/photo-1607604276583-eef5d076aa5f?w=1200&auto=format&fit=crop&q=80',
    original_url: 'https://images.unsplash.com/photo-1607604276583-eef5d076aa5f?w=1200&auto=format&fit=crop&q=80',
    page_order: 1,
  },
  {
    id: 'p-4-2',
    chapter_id: 'c-4',
    image_url: 'https://images.unsplash.com/photo-1578632767115-351597cf2477?w=1200&auto=format&fit=crop&q=80',
    original_url: 'https://images.unsplash.com/photo-1578632767115-351597cf2477?w=1200&auto=format&fit=crop&q=80',
    page_order: 2,
  },
  {
    id: 'p-5-1',
    chapter_id: 'c-5',
    image_url: 'https://images.unsplash.com/photo-1618005182384-a83a8bd57fbe?w=1200&auto=format&fit=crop&q=80',
    original_url: 'https://images.unsplash.com/photo-1618005182384-a83a8bd57fbe?w=1200&auto=format&fit=crop&q=80',
    page_order: 1,
  },
  {
    id: 'p-6-1',
    chapter_id: 'c-6',
    image_url: 'https://images.unsplash.com/photo-1534447677768-be436bb09401?w=1200&auto=format&fit=crop&q=80',
    original_url: 'https://images.unsplash.com/photo-1534447677768-be436bb09401?w=1200&auto=format&fit=crop&q=80',
    page_order: 1,
  },
];

class LocalStore {
  private genres: Genre[];
  private titles: Title[];
  private chapters: Chapter[];
  private pages: Page[];
  private adminSession: any = null;

  constructor() {
    this.genres = this.load('manga_genres', INITIAL_GENRES);
    this.titles = this.load('manga_titles', INITIAL_TITLES);
    this.chapters = this.load('manga_chapters', INITIAL_CHAPTERS);
    this.pages = this.load('manga_pages', INITIAL_PAGES);
    this.adminSession = this.load('manga_admin_session', null);
  }

  private load<T>(key: string, defaultVal: T): T {
    if (typeof window === 'undefined') return defaultVal;
    try {
      const saved = localStorage.getItem(key);
      return saved ? JSON.parse(saved) : defaultVal;
    } catch {
      return defaultVal;
    }
  }

  private save(key: string, val: any) {
    if (typeof window === 'undefined') return;
    try {
      localStorage.setItem(key, JSON.stringify(val));
    } catch (e) {
      console.warn('LocalStorage save limit reached, state retained in memory', e);
    }
  }

  // Admin Auth
  getAdminSession() {
    return this.adminSession;
  }

  setAdminSession(session: any) {
    this.adminSession = session;
    this.save('manga_admin_session', session);
  }

  // Genres
  getGenres() {
    return [...this.genres];
  }

  createGenre(name: string): Genre {
    const newGenre: Genre = {
      id: 'g-' + Date.now(),
      name: name.trim(),
    };
    this.genres.push(newGenre);
    this.save('manga_genres', this.genres);
    return newGenre;
  }

  updateGenre(id: string, name: string): Genre {
    const genre = this.genres.find((g) => g.id === id);
    if (!genre) throw new Error('Genre not found');
    genre.name = name.trim();
    this.save('manga_genres', this.genres);
    return genre;
  }

  deleteGenre(id: string) {
    this.genres = this.genres.filter((g) => g.id !== id);
    this.titles.forEach((t) => {
      t.genres = t.genres.filter((g) => g.id !== id);
    });
    this.save('manga_genres', this.genres);
    this.save('manga_titles', this.titles);
  }

  getGenreUsageCount(id: string): number {
    return this.titles.filter((t) => t.genres.some((g) => g.id === id)).length;
  }

  // Titles
  getTitles(publishedOnly = false): Title[] {
    let list = this.titles;
    if (publishedOnly) {
      list = list.filter((t) => t.published);
    }
    return [...list].sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
  }

  getTitleBySlug(slug: string): Title | null {
    return this.titles.find((t) => t.slug === slug) || null;
  }

  getTitleById(id: string): Title | null {
    return this.titles.find((t) => t.id === id) || null;
  }

  createTitle(input: TitleInput): Title {
    const genreObjects = (input.genre_ids || [])
      .map((gid) => this.genres.find((g) => g.id === gid))
      .filter(Boolean) as Genre[];

    const newTitle: Title = {
      id: 't-' + Date.now(),
      slug: input.slug,
      title: input.title,
      author: input.author || null,
      description: input.description || null,
      cover_url: input.cover_url || null,
      status: input.status || 'ongoing',
      published: input.published ?? false,
      created_at: new Date().toISOString(),
      genres: genreObjects,
    };

    this.titles.unshift(newTitle);
    this.save('manga_titles', this.titles);
    return newTitle;
  }

  updateTitle(id: string, input: Partial<TitleInput>): Title {
    const index = this.titles.findIndex((t) => t.id === id);
    if (index === -1) throw new Error('Title not found');

    const current = this.titles[index];
    const genreObjects = input.genre_ids
      ? (input.genre_ids.map((gid) => this.genres.find((g) => g.id === gid)).filter(Boolean) as Genre[])
      : current.genres;

    const updated: Title = {
      ...current,
      slug: input.slug !== undefined ? input.slug : current.slug,
      title: input.title !== undefined ? input.title : current.title,
      author: input.author !== undefined ? input.author : current.author,
      description: input.description !== undefined ? input.description : current.description,
      cover_url: input.cover_url !== undefined ? input.cover_url : current.cover_url,
      status: input.status !== undefined ? input.status : current.status,
      published: input.published !== undefined ? input.published : current.published,
      genres: genreObjects,
    };

    this.titles[index] = updated;
    this.save('manga_titles', this.titles);
    return updated;
  }

  deleteTitle(id: string) {
    this.titles = this.titles.filter((t) => t.id !== id);
    const chapterIds = this.chapters.filter((c) => c.title_id === id).map((c) => c.id);
    this.chapters = this.chapters.filter((c) => c.title_id !== id);
    this.pages = this.pages.filter((p) => !chapterIds.includes(p.chapter_id));

    this.save('manga_titles', this.titles);
    this.save('manga_chapters', this.chapters);
    this.save('manga_pages', this.pages);
  }

  toggleTitlePublish(id: string): Title {
    const title = this.getTitleById(id);
    if (!title) throw new Error('Title not found');
    return this.updateTitle(id, { published: !title.published });
  }

  // Chapters
  getChaptersByTitle(titleId: string, includeDrafts = false): Chapter[] {
    let list = this.chapters.filter((c) => c.title_id === titleId);
    if (!includeDrafts) {
      list = list.filter((c) => c.published);
    }
    return list.sort((a, b) => a.number - b.number);
  }

  getChapterByNumber(titleId: string, number: number): Chapter | null {
    return this.chapters.find((c) => c.title_id === titleId && Number(c.number) === Number(number)) || null;
  }

  getChapterById(id: string): Chapter | null {
    return this.chapters.find((c) => c.id === id) || null;
  }

  createChapter(input: ChapterInput): Chapter {
    const newChapter: Chapter = {
      id: 'c-' + Date.now() + '-' + Math.floor(Math.random() * 1000),
      title_id: input.title_id,
      number: Number(input.number),
      name: input.name || null,
      published: input.published ?? false,
      created_at: new Date().toISOString(),
    };

    this.chapters.push(newChapter);
    this.save('manga_chapters', this.chapters);
    return newChapter;
  }

  updateChapter(id: string, input: Partial<ChapterInput>): Chapter {
    const index = this.chapters.findIndex((c) => c.id === id);
    if (index === -1) throw new Error('Chapter not found');

    const current = this.chapters[index];
    const updated: Chapter = {
      ...current,
      number: input.number !== undefined ? Number(input.number) : current.number,
      name: input.name !== undefined ? input.name : current.name,
      published: input.published !== undefined ? input.published : current.published,
    };

    this.chapters[index] = updated;
    this.save('manga_chapters', this.chapters);
    return updated;
  }

  deleteChapter(id: string) {
    this.chapters = this.chapters.filter((c) => c.id !== id);
    this.pages = this.pages.filter((p) => p.chapter_id !== id);
    this.save('manga_chapters', this.chapters);
    this.save('manga_pages', this.pages);
  }

  // Pages
  getPagesByChapter(chapterId: string): Page[] {
    return this.pages
      .filter((p) => p.chapter_id === chapterId)
      .sort((a, b) => a.page_order - b.page_order);
  }

  getPageById(id: string): Page | null {
    return this.pages.find((p) => p.id === id) || null;
  }

  createPage(input: PageInput): Page {
    const newPage: Page = {
      id: 'p-' + Date.now() + '-' + Math.floor(Math.random() * 1000),
      chapter_id: input.chapter_id,
      image_url: input.image_url,
      original_url: input.original_url || null,
      page_order: input.page_order,
    };
    this.pages.push(newPage);
    this.save('manga_pages', this.pages);
    return newPage;
  }

  updatePageOrders(chapterId: string, pageOrders: { id: string; page_order: number }[]) {
    const orderMap = new Map(pageOrders.map((o) => [o.id, o.page_order]));
    this.pages.forEach((p) => {
      if (p.chapter_id === chapterId && orderMap.has(p.id)) {
        p.page_order = orderMap.get(p.id)!;
      }
    });
    this.save('manga_pages', this.pages);
  }

  deletePage(id: string) {
    this.pages = this.pages.filter((p) => p.id !== id);
    this.save('manga_pages', this.pages);
  }
}

export const mockStore = new LocalStore();
