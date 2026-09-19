import type { LoginChallengeStatus } from '@/data/notify';

/**
 * Фазы экрана `/admin/login`.
 *  - form          — ввод email/пароля;
 *  - waiting       — ждём подтверждение из письма (polling + события localStorage);
 *  - denied        — владелец отклонил вход;
 *  - expired       — срок ссылки истёк (15 минут);
 *  - service_error — не удалось проверить статус при загрузке страницы.
 */
export type LoginPhase = 'form' | 'waiting' | 'denied' | 'expired' | 'service_error';

export const WAIT_HINT = 'Ожидаем подтверждение из письма…';
export const APPROVED_HINT = 'Подтверждено! Открываем админку…';
export const STATUS_ERROR_HINT = 'Сервис статуса временно недоступен, повторяем…';

/** Решение UI по статусу challenge — применяется в одном месте (applyChallengeStatus). */
export interface LoginChallengeUx {
  /** Куда перейти; undefined — оставить текущую фазу. */
  phase?: LoginPhase;
  /** Что показать в плашке ожидания (актуально только на экране waiting). */
  hint?: string;
  /** Сессию нужно сбросить: вход отклонён / истёк. */
  signOut?: boolean;
  /** Challenge подтверждён — пробуем открыть админку (hasRole проверит сервер). */
  openAdmin?: boolean;
  /** Статус не получен из-за сбоя RPC/сети: экран ошибки уместен только на входе. */
  serviceError?: boolean;
}

/**
 * Единственное место, где статус challenge превращается в решение UI.
 *
 * Раньше маппинг статуса был продублирован в трёх ветках (первичная проверка,
 * polling, события localStorage из соседней вкладки) — ветки расходились, и
 * экран ожидания мог «залипнуть» на waiting, даже когда статус в localStorage
 * уже стал approved/denied/expired.
 */
export function loginChallengeUx(status: LoginChallengeStatus): LoginChallengeUx {
  switch (status) {
    case 'pending':
      return { phase: 'waiting', hint: WAIT_HINT };
    case 'approved':
      // Локальный/серверный approved ≠ доступ: hasRole ещё раз спросит
      // серверный статус challenge (RPC latest_login_challenge_status).
      return { hint: APPROVED_HINT, openAdmin: true };
    case 'denied':
      return { phase: 'denied', signOut: true };
    case 'expired':
      return { phase: 'expired', signOut: true };
    case 'error':
      return { phase: 'service_error', hint: STATUS_ERROR_HINT, serviceError: true };
    default:
      // none / unauthenticated / неизвестное — состояние не меняем
      // (на форме остаёмся на форме, на экране ожидания продолжаем ждать).
      return {};
  }
}
