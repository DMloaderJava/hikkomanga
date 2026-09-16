import { useState, useCallback, useRef } from 'react';
import { adsApi } from '@/data/ads';

const STORAGE_KEY = 'hk_chapters_read';
const AD_EVERY_N = 5;
/** Кэш «есть ли хоть один активный баннер» — чтобы не мигать spinner на пустой базе. */
let adsAvailableCache: boolean | null = null;
let adsAvailableFetchedAt = 0;
const ADS_CACHE_TTL_MS = 60_000;

async function hasActiveAds(): Promise<boolean> {
  const now = Date.now();
  if (adsAvailableCache !== null && now - adsAvailableFetchedAt < ADS_CACHE_TTL_MS) {
    return adsAvailableCache;
  }
  try {
    const ad = await adsApi.getActive();
    adsAvailableCache = ad !== null;
    adsAvailableFetchedAt = now;
    return adsAvailableCache;
  } catch {
    // При ошибке не показываем interstitial (лучше пропустить, чем мигать).
    return false;
  }
}

interface Progress {
  count: number;
  nextAdAt: number;
  /**
   * Последняя глава, уже учтённая в count.
   * Гасит StrictMode double-effect / remount в той же сессии.
   * При намеренном повторном открытии той же главы (навигация туда-обратно)
   * счётчик тоже не растёт — «главы прочитано» = уникальные id за сессию.
   * sessionStorage: сброс при закрытии вкладки (осознанно, не lifetime-монетизация).
   */
  lastChapterId?: string | null;
  /** Набор id глав, уже учтённых (чтобы re-read после других глав тоже не крутил ads). */
  seenIds?: string[];
}

function loadProgress(): Progress {
  try {
    if (typeof sessionStorage === 'undefined') {
      return { count: 0, nextAdAt: AD_EVERY_N, lastChapterId: null, seenIds: [] };
    }
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (raw) {
      const p = JSON.parse(raw) as Progress;
      return {
        count: p.count || 0,
        nextAdAt: p.nextAdAt || AD_EVERY_N,
        lastChapterId: p.lastChapterId ?? null,
        seenIds: Array.isArray(p.seenIds) ? p.seenIds : [],
      };
    }
  } catch {
    // приватный режим или SSR
  }
  return { count: 0, nextAdAt: AD_EVERY_N, lastChapterId: null, seenIds: [] };
}

function saveProgress(p: Progress): void {
  try {
    if (typeof sessionStorage === 'undefined') return;
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(p));
  } catch {
    // ignore
  }
}

export function useChapterProgress() {
  const [progress, setProgress] = useState<Progress>(loadProgress);
  const [showAd, setShowAd] = useState(false);
  // Ref-guard: даже если setProgress вызовется дважды синхронно до commit —
  // не покажем ad дважды из одного mark.
  const pendingAdRef = useRef(false);

  /**
   * @param chapterId — id главы. Повторный вызов с тем же id (StrictMode
   * double-effect, remount) или повторное открытие уже учтённой главы
   * не увеличивает счётчик.
   */
  const markChapterRead = useCallback((chapterId?: string) => {
    setProgress((prev) => {
      if (chapterId) {
        const seen = prev.seenIds || [];
        if (seen.includes(chapterId) || prev.lastChapterId === chapterId) {
          return prev;
        }
      }
      const seenIds = chapterId
        ? [...(prev.seenIds || []), chapterId].slice(-200)
        : prev.seenIds || [];
      const next: Progress = {
        ...prev,
        count: prev.count + 1,
        lastChapterId: chapterId ?? prev.lastChapterId,
        seenIds,
      };
      if (next.count >= prev.nextAdAt) {
        next.nextAdAt = next.count + AD_EVERY_N;
        if (!pendingAdRef.current) {
          pendingAdRef.current = true;
          // Сначала проверяем, есть ли баннеры — иначе не ставим showAd
          // (нет spinner-мигания на пустой базе).
          void hasActiveAds().then((ok) => {
            pendingAdRef.current = false;
            if (ok) setShowAd(true);
          });
        }
      }
      saveProgress(next);
      return next;
    });
  }, []);

  const dismissAd = useCallback(() => {
    setShowAd(false);
  }, []);

  return { markChapterRead, showAd, dismissAd, progress };
}
