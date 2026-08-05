"use client";

import * as React from "react";
import Hls from "hls.js";

interface LiveFeedPlayerProps {
  eip: string;
  sensorId: string;
}

/** Latest still frame from a direct RTSP camera, taken from its recording.
 *  Lags real time by ~60 s deliberately: a window at the still-recording edge
 *  404s until that segment finalizes. */
const FRAME_LAG_MS = 60_000;
const FRAME_REFRESH_MS = 30_000;

function RecordedFramePreview({ sensorId }: { sensorId: string }) {
  const [ts, setTs] = React.useState<string | null>(null);
  const [failed, setFailed] = React.useState(false);

  React.useEffect(() => {
    const tick = () => setTs(new Date(Date.now() - FRAME_LAG_MS).toISOString());
    tick();
    const id = setInterval(tick, FRAME_REFRESH_MS);
    return () => clearInterval(id);
  }, []);

  if (failed || !ts) {
    return (
      <div
        className="w-80 aspect-video bg-muted/30 rounded flex items-center justify-center text-center text-xs text-muted-foreground px-3"
        title="A still is taken from this camera's recording. Nothing to show yet — either recording has just started, or it is not recording (see Diagnosis)."
      >
        {failed ? "no recorded frame yet — see Diagnosis" : "loading frame…"}
      </div>
    );
  }

  return (
    <div className="w-80 aspect-video bg-black rounded overflow-hidden relative">
      {/* eslint-disable-next-line @next/next/no-img-element -- frame bytes are
          proxied per-request from VST; next/image would cache a stale still. */}
      <img
        src={`/api/clips/${encodeURIComponent(sensorId)}/${encodeURIComponent(ts)}/thumb`}
        alt={`Latest recorded frame from ${sensorId}`}
        className="w-full h-full object-contain"
        onError={() => setFailed(true)}
      />
      <span className="absolute bottom-1 right-1 rounded bg-black/60 px-1 text-[10px] text-white">
        from recording
      </span>
    </div>
  );
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

  // The HLS preview above is an re-stream published by the camera-sim host, so
  // a direct IP camera (Pyramid's camerabars) has nothing to play. Rather than
  // an apology, show a real frame: /api/clips/<sensor>/<ts>/thumb pulls a still
  // out of the camera's own recording. Only mounts when a row is expanded, and
  // refreshes on a slow cadence because each fetch costs a clip extraction.
  if (!eip) {
    return <RecordedFramePreview sensorId={sensorId} />;
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
