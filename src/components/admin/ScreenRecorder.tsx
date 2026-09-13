import { forwardRef, useImperativeHandle, useRef, useState, useEffect } from 'react';

export interface ScreenRecorderHandle {
  start: (audioElement: HTMLAudioElement) => Promise<void>;
  pause: () => void;
  resume: () => void;
  stop: () => Promise<Blob | null>;
  isRecording: boolean;
}

export const ScreenRecorder = forwardRef<ScreenRecorderHandle, { onDownloadReady?: (url: string) => void }>(
  ({ onDownloadReady }, ref) => {
    const mediaRecorderRef = useRef<MediaRecorder | null>(null);
    const chunksRef = useRef<Blob[]>([]);
    const [isRecording, setIsRecording] = useState(false);
    const lastCreatedUrlRef = useRef<string | null>(null);

    // AudioContext and MediaElementSourceNode singleton references
    const audioCtxRef = useRef<AudioContext | null>(null);
    const sourceNodeRef = useRef<MediaElementAudioSourceNode | null>(null);
    const destNodeRef = useRef<MediaStreamAudioDestinationNode | null>(null);

    // Revoke object URL on unmount to avoid memory leaks
    useEffect(() => {
      return () => {
        if (lastCreatedUrlRef.current) {
          URL.revokeObjectURL(lastCreatedUrlRef.current);
          lastCreatedUrlRef.current = null;
        }
      };
    }, []);

    const start = async (audioElement: HTMLAudioElement) => {
      if (mediaRecorderRef.current) return;

      if (!navigator.mediaDevices?.getDisplayMedia) {
        alert('Запись экрана не поддерживается данным браузером');
        return;
      }

      try {
        // 1. Capture screen video
        const screenStream = await navigator.mediaDevices.getDisplayMedia({
          video: { frameRate: 30 },
          audio: false,
        });

        // 2. Setup AudioContext and connect HTMLAudioElement ONCE to prevent InvalidStateError
        if (!audioCtxRef.current) {
          const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
          audioCtxRef.current = new AudioContextClass();
          sourceNodeRef.current = audioCtxRef.current.createMediaElementSource(audioElement);
          destNodeRef.current = audioCtxRef.current.createMediaStreamDestination();

          sourceNodeRef.current.connect(destNodeRef.current);
          sourceNodeRef.current.connect(audioCtxRef.current.destination);
        }

        if (audioCtxRef.current.state === 'suspended') {
          await audioCtxRef.current.resume();
        }

        // 3. Combine video & mixed audio
        const combinedStream = new MediaStream([
          ...screenStream.getVideoTracks(),
          ...(destNodeRef.current ? destNodeRef.current.stream.getAudioTracks() : []),
        ]);

        // 4. Start MediaRecorder
        const mimeType = MediaRecorder.isTypeSupported('video/webm;codecs=vp9,opus')
          ? 'video/webm;codecs=vp9,opus'
          : 'video/webm';

        const recorder = new MediaRecorder(combinedStream, { mimeType });
        chunksRef.current = [];

        recorder.ondataavailable = (e) => {
          if (e.data && e.data.size > 0) {
            chunksRef.current.push(e.data);
          }
        };

        screenStream.getVideoTracks()[0].onended = () => {
          if (recorder.state !== 'inactive') {
            recorder.stop();
          }
        };

        recorder.start(1000);
        mediaRecorderRef.current = recorder;
        setIsRecording(true);
      } catch (err: any) {
        console.error('Screen recording start error:', err);
      }
    };

    const pause = () => {
      if (mediaRecorderRef.current && mediaRecorderRef.current.state === 'recording') {
        mediaRecorderRef.current.pause();
      }
    };

    const resume = () => {
      if (mediaRecorderRef.current && mediaRecorderRef.current.state === 'paused') {
        mediaRecorderRef.current.resume();
      }
    };

    const stop = (): Promise<Blob | null> => {
      return new Promise((resolve) => {
        const recorder = mediaRecorderRef.current;
        if (!recorder) {
          setIsRecording(false);
          resolve(null);
          return;
        }

        recorder.onstop = () => {
          const videoBlob = new Blob(chunksRef.current, { type: 'video/webm' });
          chunksRef.current = [];
          mediaRecorderRef.current = null;
          setIsRecording(false);

          if (onDownloadReady) {
            if (lastCreatedUrlRef.current) {
              URL.revokeObjectURL(lastCreatedUrlRef.current);
            }
            const videoUrl = URL.createObjectURL(videoBlob);
            lastCreatedUrlRef.current = videoUrl;
            onDownloadReady(videoUrl);
          }

          resolve(videoBlob);
        };

        recorder.stop();
      });
    };

    useImperativeHandle(
      ref,
      () => ({
        start,
        pause,
        resume,
        stop,
        get isRecording() {
          return isRecording;
        },
      }),
      [isRecording]
    );

    return null;
  }
);
ScreenRecorder.displayName = 'ScreenRecorder';
