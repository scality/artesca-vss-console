"use client";

import { useEffect, useRef, useState } from "react";
import Hls from "hls.js";

interface ClipPlayerProps {
  src: string; // HLS playlist URL e.g. /api/clips/:sensor/:ts/index.m3u8
  seekOffset?: number; // seconds into clip to seek on load
}

export function ClipPlayer({ src, seekOffset }: ClipPlayerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const hlsRef = useRef<Hls | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    setError(null);
    setReady(false);

    if (Hls.isSupported()) {
      const hls = new Hls({
        lowLatencyMode: true,
        backBufferLength: 30,
      });
      hlsRef.current = hls;

      hls.loadSource(src);
      hls.attachMedia(video);

      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        setReady(true);
        if (seekOffset !== undefined && seekOffset > 0) {
          video.currentTime = seekOffset;
        }
        video.play().catch(() => { /* autoplay may be blocked */ });
      });

      hls.on(Hls.Events.ERROR, (_event, data) => {
        if (data.fatal) {
          setError(`HLS error: ${data.details}`);
        }
      });

      return () => {
        hls.destroy();
        hlsRef.current = null;
      };
    } else if (video.canPlayType("application/vnd.apple.mpegurl")) {
      // Safari native HLS
      video.src = src;
      video.addEventListener("loadedmetadata", () => {
        setReady(true);
        if (seekOffset !== undefined && seekOffset > 0) {
          video.currentTime = seekOffset;
        }
        video.play().catch(() => { /* autoplay may be blocked */ });
      });
    } else {
      setError("HLS not supported in this browser.");
    }
  }, [src, seekOffset]);

  // Keyboard shortcuts
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !ready) return;

    function onKey(e: KeyboardEvent) {
      if (!video) return;
      if (e.key === " " || e.code === "Space") {
        e.preventDefault();
        if (video.paused) {
          video.play();
        } else {
          video.pause();
        }
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        video.currentTime = Math.max(0, video.currentTime - 2);
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        video.currentTime = video.currentTime + 2;
      } else if (e.key === "f" || e.key === "F") {
        e.preventDefault();
        if (document.fullscreenElement) {
          document.exitFullscreen();
        } else {
          video.requestFullscreen?.();
        }
      }
    }

    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [ready]);

  if (error) {
    return (
      <div className="flex items-center justify-center rounded bg-muted p-4 text-sm text-red-400">
        {error}
      </div>
    );
  }

  return (
    <div className="relative aspect-video w-full overflow-hidden rounded bg-black">
      <video
        ref={videoRef}
        className="h-full w-full"
        controls
        playsInline
        muted
      />
      {!ready && (
        <div className="absolute inset-0 flex items-center justify-center">
          <span className="text-xs text-muted-foreground animate-pulse">
            Loading clip…
          </span>
        </div>
      )}
      <div className="absolute bottom-1 right-2 text-[10px] text-white/40 pointer-events-none">
        Space=play/pause · ←/→=seek 2s · F=fullscreen
      </div>
    </div>
  );
}
