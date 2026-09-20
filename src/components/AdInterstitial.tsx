import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { adsApi } from '@/data/ads';
import type { Ad } from '@/data/types';
import { ExternalLink, X } from 'lucide-react';

interface AdInterstitialProps {
  onDismiss: () => void;
  onNext: () => void;
}

export function AdInterstitial({ onDismiss, onNext }: AdInterstitialProps) {
  const [ad, setAd] = useState<Ad | null | 'loading'>('loading');

  useEffect(() => {
    let cancelled = false;
    adsApi.getActive().then((result) => {
      if (cancelled) return;
      if (!result) {
        // Race: hook мог решить showAd=true, а баннер уже inactive.
        onDismiss();
        return;
      }
      setAd(result);
    });
    return () => {
      cancelled = true;
    };
    // onDismiss стабилен (useCallback в Reader).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (ad === 'loading') {
    return (
      <div className="flex h-12 items-center justify-center" aria-hidden>
        <div className="h-4 w-4 animate-spin rounded-full border-2 border-rose-500 border-t-transparent" />
      </div>
    );
  }

  // Race: getActive()=null → onDismiss уже вызван; не рендерим spinner.
  if (!ad) return null;

  return (
    <div className="rounded-2xl border border-neutral-700 bg-neutral-900 overflow-hidden">
      <div className="flex items-center justify-between bg-neutral-800 px-4 py-1.5">
        <span className="text-xs uppercase tracking-widest text-neutral-500">
          Реклама
        </span>
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Закрыть рекламу"
          className="text-neutral-600 transition-colors hover:text-neutral-300"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {ad.image_url && (
        <img
          src={ad.image_url}
          alt={ad.title}
          className="w-full max-h-40 object-cover"
          loading="lazy"
          referrerPolicy="no-referrer"
          onError={(e) => {
            (e.currentTarget as HTMLImageElement).style.display = 'none';
          }}
        />
      )}

      <div className="space-y-3 p-4">
        <div>
          <p className="font-semibold text-white">{ad.title}</p>
          {ad.description && (
            <p className="mt-1 text-sm text-neutral-400">{ad.description}</p>
          )}
        </div>

        <div className="flex gap-2">
          <a
            href={ad.link_url}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex flex-1 items-center justify-center gap-2 rounded-lg bg-rose-600 px-4 py-2 text-sm font-medium text-white hover:bg-rose-700"
          >
            <ExternalLink className="h-4 w-4" />
            {ad.link_label}
          </a>
          <Button
            variant="outline"
            onClick={onNext}
            className="flex-1 border-neutral-700"
          >
            К следующей главе
          </Button>
        </div>
      </div>
    </div>
  );
}
