import { useState, useEffect } from 'react';
import { voiceoverApi, type ChapterVoiceover } from '@/data/voiceover';
import { gemini, type DialogueLine } from '@/data/gemini';
import { storage } from '@/data/storage';
import type { Page } from '@/data/types';

export type VoiceoverStatus = 'idle' | 'analyzing' | 'editing' | 'generating' | 'ready' | 'error';

export function useVoiceover(chapterId: string, pages: Page[]) {
  const [voiceover, setVoiceover] = useState<ChapterVoiceover | null>(null);
  const [status, setStatus] = useState<VoiceoverStatus>('idle');
  const [progress, setProgress] = useState(0);
  const [lines, setLines] = useState<DialogueLine[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;

    async function load() {
      if (!chapterId) return;
      setStatus('idle');
      setVoiceover(null);
      setLines([]);
      setError(null);

      try {
        const existing = await voiceoverApi.getByChapter(chapterId);
        if (mounted && existing) {
          setVoiceover(existing);
          setLines(existing.lines || []);
          setStatus('ready');
        }
      } catch (err: any) {
        console.error('Error loading voiceover:', err);
      }
    }

    load();

    return () => {
      mounted = false;
    };
  }, [chapterId]);

  // Step 1: AI Page Analysis
  const analyzePages = async () => {
    if (pages.length === 0) {
      setError('В этой главе нет доступных страниц для анализа');
      return;
    }

    setStatus('analyzing');
    setProgress(0);
    setError(null);

    const allExtractedLines: DialogueLine[] = [];

    try {
      for (let i = 0; i < pages.length; i++) {
        const page = pages[i];
        const pageLines = await gemini.analyzeImage(page.image_url, i);
        allExtractedLines.push(...pageLines);
        setProgress(Math.round(((i + 1) / pages.length) * 100));
      }

      setLines(allExtractedLines);
      setStatus('editing');
    } catch (err: any) {
      setError(err.message || 'Ошибка анализа страниц через Gemini');
      setStatus('error');
    }
  };

  // Step 2: Generate Audio & Upload to Storage
  const generateVoiceover = async (customLines?: DialogueLine[]) => {
    const linesToUse = customLines || lines;
    if (linesToUse.length === 0) {
      setError('Нет реплик для озвучки');
      return;
    }

    setStatus('generating');
    setError(null);

    try {
      const { blob, durationMs } = await gemini.generateAudio(linesToUse);
      const audioUrl = await storage.uploadVoiceover(chapterId, blob);

      const saved = await voiceoverApi.saveVoiceover(
        chapterId,
        audioUrl,
        linesToUse,
        durationMs
      );

      setVoiceover(saved);
      setStatus('ready');
    } catch (err: any) {
      setError(err.message || 'Ошибка синтеза озвучки');
      setStatus('error');
    }
  };

  const updateLines = (newLines: DialogueLine[]) => {
    setLines(newLines);
  };

  const resetVoiceover = async () => {
    setError(null);
    try {
      await voiceoverApi.deleteVoiceover(chapterId, voiceover?.audio_url);
      setVoiceover(null);
      setLines([]);
      setStatus('idle');
    } catch (err: any) {
      setError(err.message || 'Ошибка удаления озвучки');
    }
  };

  return {
    voiceover,
    status,
    progress,
    lines,
    error,
    analyzePages,
    generateVoiceover,
    updateLines,
    resetVoiceover,
  };
}
