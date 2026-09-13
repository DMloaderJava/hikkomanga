export type TitleStatus = 'ongoing' | 'completed';

export interface Genre {
  id: string;
  name: string;
}

export interface Title {
  id: string;
  slug: string;
  title: string;
  author: string | null;
  description: string | null;
  cover_url: string | null;
  status: TitleStatus;
  published: boolean;
  created_at: string;
  genres: Genre[];
}

export interface Chapter {
  id: string;
  title_id: string;
  number: number;
  name: string | null;
  published: boolean;
  created_at: string;
}

export interface Page {
  id: string;
  chapter_id: string;
  image_url: string;
  original_url: string | null;
  page_order: number;
}

export interface TitleInput {
  slug: string;
  title: string;
  author?: string | null;
  description?: string | null;
  cover_url?: string | null;
  status?: TitleStatus;
  published?: boolean;
  genre_ids?: string[];
}

export interface ChapterInput {
  title_id: string;
  number: number;
  name?: string | null;
  published?: boolean;
}

export interface PageInput {
  chapter_id: string;
  image_url: string;
  original_url?: string | null;
  page_order: number;
}

export interface DialogueLine {
  id?: string;
  speaker: string;
  text: string;
  pageIndex?: number;
}

export interface ChapterVoiceover {
  id: string;
  chapter_id: string;
  audio_url: string;
  lines: DialogueLine[];
  duration_ms: number;
  created_at: string;
}

export class SlugConflictError extends Error {
  constructor(slug: string) {
    super(`Тайтл с таким URL-алиасом (slug: "${slug}") уже существует.`);
    this.name = 'SlugConflictError';
  }
}

