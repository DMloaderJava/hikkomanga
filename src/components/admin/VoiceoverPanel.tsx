import { useAuth } from '@/hooks/useAuth';
import { useVoiceover } from '@/hooks/useVoiceover';
import type { Page } from '@/data/types';
import { VoiceoverEditor } from './VoiceoverEditor';
import { VoiceoverPlayer } from './VoiceoverPlayer';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { Mic, Sparkles, AlertCircle, RefreshCw, Layers } from 'lucide-react';

interface VoiceoverPanelProps {
  chapterId: string;
  pages: Page[];
}

export function VoiceoverPanel({ chapterId, pages }: VoiceoverPanelProps) {
  const { isAdmin } = useAuth();
  const {
    voiceover,
    status,
    progress,
    lines,
    error,
    analyzePages,
    generateVoiceover,
    updateLines,
    resetVoiceover,
  } = useVoiceover(chapterId, pages);

  // Security layer 1: UI returns null for non-admins
  if (!isAdmin) return null;

  return (
    <div className="space-y-6 rounded-2xl border border-neutral-800 bg-neutral-900/60 p-6 shadow-2xl backdrop-blur-xl">
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 border-b border-neutral-800 pb-4">
        <div>
          <h3 className="text-lg font-extrabold text-white tracking-tight flex items-center gap-2">
            <Mic className="h-5 w-5 text-rose-500" /> ИИ-Озвучка и Запись экрана главы
          </h3>
          <p className="text-xs text-neutral-400 mt-0.5">
            Распознавание бабблов с репликами через Gemini AI, синтез голоса и запись видео
          </p>
        </div>

        {status === 'ready' && (
          <Button variant="ghost" size="sm" onClick={resetVoiceover} className="text-xs text-neutral-400 hover:text-red-400 gap-1.5">
            <RefreshCw className="h-3.5 w-3.5" /> Сбросить озвучку
          </Button>
        )}
      </div>

      {error && (
        <div className="flex items-center gap-2 rounded-xl border border-red-800/80 bg-red-950/40 p-4 text-xs text-red-400">
          <AlertCircle className="h-4 w-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {/* Workflow Controls */}
      {status === 'idle' && (
        <div className="flex flex-col items-center justify-center py-8 text-center space-y-4 rounded-xl border border-dashed border-neutral-800 bg-neutral-950/40 p-6">
          <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-rose-600/20 text-rose-400 border border-rose-500/30">
            <Sparkles className="h-6 w-6" />
          </div>
          <div>
            <h4 className="text-base font-bold text-white">Анализ реплик персонажей</h4>
            <p className="text-xs text-neutral-400 max-w-md mt-1">
              Gemini Vision проанализирует все страницы главы, распознает речи персонажей и сформирует сценарий.
            </p>
          </div>
          <Button onClick={analyzePages} size="lg" className="gap-2 shadow-lg shadow-rose-600/20">
            <Sparkles className="h-4 w-4" /> Начать анализ страниц
          </Button>
        </div>
      )}

      {status === 'analyzing' && (
        <div className="space-y-3 rounded-xl border border-neutral-800 bg-neutral-950/60 p-6 text-center">
          <div className="flex items-center justify-between text-xs font-semibold text-neutral-300">
            <span className="flex items-center gap-2">
              <Sparkles className="h-4 w-4 text-rose-500 animate-spin" /> Анализ страниц Gemini Vision...
            </span>
            <span>{progress}%</span>
          </div>
          <Progress value={progress} />
        </div>
      )}

      {(status === 'editing' || (lines.length > 0 && status !== 'ready')) && (
        <VoiceoverEditor
          lines={lines}
          onSaveLines={updateLines}
          onGenerate={() => generateVoiceover(lines)}
        />
      )}

      {status === 'generating' && (
        <div className="space-y-3 rounded-xl border border-neutral-800 bg-neutral-950/60 p-6 text-center">
          <div className="flex items-center justify-center gap-2 text-sm font-bold text-rose-400">
            <Mic className="h-5 w-5 animate-pulse" /> Синтезирование голосовой дорожки...
          </div>
        </div>
      )}

      {status === 'ready' && voiceover && (
        <VoiceoverPlayer voiceover={voiceover} pages={pages} />
      )}
    </div>
  );
}
