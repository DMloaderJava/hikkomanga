import { useState, useRef } from 'react';
import type { Page } from '@/data/types';
import type { ChapterVoiceover } from '@/data/voiceover';
import { ScreenRecorder, type ScreenRecorderHandle } from './ScreenRecorder';
import { Button } from '@/components/ui/button';
import { Play, Pause, Square, Download, Video, Volume2 } from 'lucide-react';

interface VoiceoverPlayerProps {
  voiceover: ChapterVoiceover;
  pages: Page[];
}

export function VoiceoverPlayer({ voiceover, pages }: VoiceoverPlayerProps) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const recorderRef = useRef<ScreenRecorderHandle>(null);

  const [isPlaying, setIsPlaying] = useState(false);
  const [currentPageIndex, setCurrentPageIndex] = useState(0);
  const [recordedVideoUrl, setRecordedVideoUrl] = useState<string | null>(null);

  // Sync current page image with audio progress
  const handleTimeUpdate = () => {
    if (!audioRef.current || voiceover.duration_ms <= 0 || pages.length === 0) return;
    const progressRatio = audioRef.current.currentTime / (voiceover.duration_ms / 1000);
    const targetIndex = Math.min(
      pages.length - 1,
      Math.floor(progressRatio * pages.length)
    );
    if (targetIndex !== currentPageIndex) {
      setCurrentPageIndex(targetIndex);
    }
  };

  const handlePlay = () => {
    if (audioRef.current) {
      audioRef.current.play();
      setIsPlaying(true);
    }
  };

  const handlePause = () => {
    if (audioRef.current) {
      audioRef.current.pause();
      setIsPlaying(false);
    }
  };

  const handleStop = async () => {
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.currentTime = 0;
      setIsPlaying(false);
      setCurrentPageIndex(0);
    }
    if (recorderRef.current) {
      await recorderRef.current.stop();
    }
  };

  const handleAudioEnded = async () => {
    setIsPlaying(false);
    if (recorderRef.current) {
      await recorderRef.current.stop();
    }
  };

  const handleStartRecording = async () => {
    if (audioRef.current && recorderRef.current) {
      await recorderRef.current.start(audioRef.current);
      audioRef.current.onplay = () => {
        setIsPlaying(true);
        if (audioRef.current) audioRef.current.onplay = null;
      };
      await audioRef.current.play();
    }
  };

  return (
    <div className="space-y-6 rounded-2xl border border-neutral-800 bg-neutral-900/90 p-6 shadow-2xl backdrop-blur-xl">
      <ScreenRecorder
        ref={recorderRef}
        onDownloadReady={(url) => setRecordedVideoUrl(url)}
      />

      {/* Hidden Audio Element */}
      <audio
        ref={audioRef}
        src={voiceover.audio_url}
        onTimeUpdate={handleTimeUpdate}
        onEnded={handleAudioEnded}
      />

      {/* Controls Bar */}
      <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-4 border-b border-neutral-800 pb-4">
        <div className="flex items-center gap-3">
          {!isPlaying ? (
            <Button onClick={handlePlay} className="gap-2 bg-emerald-600 hover:bg-emerald-700 text-white">
              <Play className="h-4 w-4 fill-current" /> Воспроизвести
            </Button>
          ) : (
            <Button onClick={handlePause} variant="outline" className="gap-2 border-neutral-700">
              <Pause className="h-4 w-4" /> Пауза
            </Button>
          )}

          <Button onClick={handleStop} variant="ghost" size="sm" className="h-10 text-neutral-400 hover:text-white">
            <Square className="h-4 w-4" /> Стоп
          </Button>
        </div>

        <div className="flex items-center gap-3">
          <Button
            onClick={handleStartRecording}
            variant="outline"
            className="gap-2 border-rose-500/40 bg-rose-950/20 text-rose-400 hover:bg-rose-950/50"
          >
            <Video className="h-4 w-4" /> Запись экрана и озвучки
          </Button>

          {recordedVideoUrl && (
            <a href={recordedVideoUrl} download="manga-voiceover.webm">
              <Button size="sm" variant="default" className="gap-2">
                <Download className="h-4 w-4" /> Скачать .webm
              </Button>
            </a>
          )}
        </div>
      </div>

      {/* Slide Visual Preview */}
      <div className="flex flex-col items-center justify-center space-y-3 bg-neutral-950 rounded-xl p-4 border border-neutral-800">
        <div className="text-xs font-semibold text-rose-400 flex items-center gap-2">
          <Volume2 className="h-4 w-4" /> Страница {currentPageIndex + 1} из {pages.length}
        </div>

        {pages[currentPageIndex] ? (
          <div className="relative max-h-96 aspect-[3/4] overflow-hidden rounded-lg border border-neutral-800 shadow-2xl">
            <img
              src={pages[currentPageIndex].image_url}
              alt={`Слайд ${currentPageIndex + 1}`}
              className="h-full w-full object-contain"
              referrerPolicy="no-referrer"
            />
          </div>
        ) : (
          <div className="py-12 text-xs text-neutral-500">Нет страниц</div>
        )}
      </div>
    </div>
  );
}
