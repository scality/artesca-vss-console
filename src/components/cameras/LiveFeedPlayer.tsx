"use client";

import * as React from "react";
import Hls from "hls.js";

interface LiveFeedPlayerProps {
  eip: string;
  sensorId: string;
}

export function LiveFeedPlayer({ eip, sensorId }: LiveFeedPlayerProps) {
  const videoRef = React.useRef<HTMLVideoElement>(null);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    const video = videoRef.current;
    if (!video || !eip) return;

    const src = `http://${eip}:8888/${sensorId}-h264/index.m3u8`;

    if (video.canPlayType("application/vnd.apple.mpegurl")) {
      video.src = src;
      return;
    }

    if (!Hls.isSupported()) {
      // reason: environment capability check — not a cascading render; HLS support
      // is a one-time synchronous probe that has no React state equivalent.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setError("HLS not supported in this browser");
      return;
    }

    const hls = new Hls({ lowLatencyMode: true, liveSyncDurationCount: 1 });
    hls.loadSource(src);
    hls.attachMedia(video);
    hls.on(Hls.Events.ERROR, (_evt, data) => {
      if (data.fatal) {
        setError(`${data.type}: ${data.details}`);
      }
    });

    return () => hls.destroy();
  }, [eip, sensorId]);

  // The inline preview is an HLS re-stream published by the camera-sim host.
  // A real IP camera (Pyramid's camerabars) has no camera-sim behind it, which
  // is normal — the previous copy ("no camera-sim host") read as a missing
  // dependency and sent operators looking for a fault that wasn't there.
  if (!eip) {
    return (
      <div
        className="w-80 aspect-video bg-muted/30 rounded flex items-center justify-center text-center text-xs text-muted-foreground px-3"
        title="Inline preview is only available for camera-sim feeds. Recording and VLM analysis are unaffected."
      >
        preview unavailable for a direct RTSP camera
      </div>
    );
  }

  return (
    <div className="w-80 aspect-video bg-black rounded overflow-hidden relative">
      <video
        ref={videoRef}
        autoPlay
        muted
        playsInline
        className="w-full h-full object-contain"
      />
      {error && (
        <div className="absolute inset-0 flex items-center justify-center text-xs text-destructive bg-black/70 p-2 text-center">
          {error}
        </div>
      )}
    </div>
  );
}
