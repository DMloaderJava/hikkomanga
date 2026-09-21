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
  /** Необязательное описание главы (миграция 15): заявки на главы и CSV-импорт. */
  description?: string | null;
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
  description?: string | null;
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

export class DuplicateChapterError extends Error {
  constructor(number: number) {
    super(`Глава с номером ${number} у этого тайтла уже существует.`);
    this.name = 'DuplicateChapterError';
  }
}

// ── Заявки администраторов ──────────────────────────────────────────────────

export type RequestType =
  | 'delete_title'
  | 'delete_chapter'
  | 'new_chapter'
  | 'ad_request'
  // Анонимная заявка на тайтл (edge submit-title); остальные типы модели БД —
  // итерациями (см. миграцию 00000000000010).
  | 'new_title'
  // Анонимная заявка на главы (edge submit-chapters, миграция 15).
  | 'new_chapters';

export type RequestStatus = 'pending' | 'approved' | 'rejected' | 'spam';

export interface AdminRequest {
  id: string;
  type: RequestType;
  requester_id?: string | null;
  target_id?: string;
  target_name?: string;
  payload: Record<string, unknown>;
  status: RequestStatus;
  resolved_by?: string;
  resolved_at?: string;
  reject_reason?: string;
  note?: string;
  created_at: string;
  // ── Анонимные заявки (new_title) ──
  /** sha256(ip + RATE_LIMIT_SALT) — сырой IP нигде не хранится. */
  ip_hash?: string | null;
  user_agent?: string | null;
  /** Капча пройдена (edge ставит true после verify). */
  turnstile_ok?: boolean;
  /** Токен заявителя для страницы /s/{token}. */
  public_token?: string | null;
  /** Опциональный email для уведомления о решении. */
  submitter_email?: string | null;
  /** true = slug занят при approve; черновик не создан. */
  conflict?: boolean;
  // ── Заявки с главами (new_chapters, new_title + главы) ──
  /** Импорт глав завершён (edge finalize-chapter-submission). */
  finalized_at?: string | null;
  /** Текст последней ошибки импорта; в инбоксе даёт кнопку «Завершить импорт». */
  finalized_error?: string | null;
}

// ── Реклама ─────────────────────────────────────────────────────────────────

export interface Ad {
  id: string;
  title: string;
  description?: string;
  image_url?: string;
  link_url: string;
  link_label: string;
  placement: string;
  /** false = выключен owner'ом; undefined в старых demo-записях = active */
  active?: boolean;
  advertiser_name?: string;
  expires_at?: string;
  created_at?: string;
}

// ── Ошибки ──────────────────────────────────────────────────────────────────

export class RateLimitError extends Error {
  /** Опциональный hint из Postgres RAISE ... USING HINT. */
  hint?: string;

  constructor(hintOrMessage?: string) {
    super(
      hintOrMessage?.trim() ||
        'Слишком много заявок. Попробуйте позже.'
    );
    this.name = 'RateLimitError';
    if (hintOrMessage) this.hint = hintOrMessage;
  }
}

