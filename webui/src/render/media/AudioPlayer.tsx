// render/media/AudioPlayer.tsx
// 音频播放（wavesurfer.js）：专业波形 + 播放/暂停/时间/音量/倍速。
// 浏览器无法解码的编码（wma/amr/ac3 等）→ 回退原生 <audio controls>（部分浏览器可播）→ 仍失败则提示 + 下载。
// 内存源（压缩包内层）用 objectURL。本组件经 React.lazy 懒加载（FilePreviewPane 分发）。

import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Download, Gauge, Music, Pause, Play, TriangleAlert, Volume2 } from 'lucide-react';
import { buildMediaUrl } from '../file/fetcher';
import type WaveSurfer from 'wavesurfer.js';

export interface AudioPlayerProps {
  /** 磁盘路径（走 media 直链）；内存源时为 undefined */
  path?: string;
  /** 内存源 objectURL（优先于 path） */
  objectUrl?: string;
  ext: string;
}

const RATES = [0.5, 0.75, 1, 1.25, 1.5, 2] as const;

function fmtTime(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return '0:00';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

export function AudioPlayer({ path, objectUrl }: AudioPlayerProps) {
  const { t } = useTranslation();
  const containerRef = useRef<HTMLDivElement>(null);
  const wsRef = useRef<WaveSurfer | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [playing, setPlaying] = useState(false);
  const [current, setCurrent] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(1);
  const [rate, setRate] = useState(1);
  const src = objectUrl ?? (path ? buildMediaUrl(path) : '');

  useEffect(() => {
    const container = containerRef.current;
    if (!container || !src) return;
    let cancelled = false;
    let ws: WaveSurfer | null = null;

    void (async () => {
      try {
        const mod = await import('wavesurfer.js');
        if (cancelled) return;
        const WaveSurferCtor = mod.default;
        ws = WaveSurferCtor.create({
          container,
          height: 88,
          waveColor: 'rgba(148,163,184,0.55)',
          progressColor: 'var(--primary)',
          cursorColor: 'var(--foreground, #111)',
          barWidth: 2,
          barGap: 1,
          normalize: true,
        });
        wsRef.current = ws;
        ws.on('ready', () => {
          if (!cancelled) {
            setStatus('ready');
            setDuration(ws?.getDuration() ?? 0);
          }
        });
        ws.on('timeupdate', (time: number) => {
          if (!cancelled) setCurrent(time);
        });
        ws.on('play', () => {
          if (!cancelled) setPlaying(true);
        });
        ws.on('pause', () => {
          if (!cancelled) setPlaying(false);
        });
        ws.on('error', () => {
          if (!cancelled) setStatus('error');
        });
        await ws.load(src);
      } catch {
        if (!cancelled) setStatus('error');
      }
    })();

    return () => {
      cancelled = true;
      try {
        ws?.destroy();
      } catch {
        // 忽略销毁异常
      }
      ws = null;
      wsRef.current = null;
      if (container) container.innerHTML = '';
    };
  }, [src]);

  // ── 解码失败：回退原生 <audio>（部分浏览器对 wma 等仍可播）→ 再失败显示提示 ──
  if (status === 'error') {
    return (
      <NativeAudioFallback src={src} label={path ?? objectUrl ?? ''} />
    );
  }

  const toggle = () => wsRef.current?.playPause();
  const onVolume = (v: number) => {
    setVolume(v);
    wsRef.current?.setVolume(v);
  };
  const onRate = (r: number) => {
    setRate(r);
    wsRef.current?.setPlaybackRate(r);
  };

  return (
    <div className="flex h-full min-h-0 flex-col items-center justify-center gap-4 rounded border border-border bg-muted/20 p-6">
      <div className="flex w-full max-w-2xl flex-col gap-3">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Music className="size-3.5 shrink-0" />
          <span className="truncate font-mono">{path ?? 'audio'}</span>
        </div>

        <div ref={containerRef} className="audio-waveform w-full rounded border border-border/60 bg-background/40 px-1" />

        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={toggle}
            disabled={status !== 'ready'}
            className="inline-flex size-9 items-center justify-center rounded-full bg-primary-strong text-primary-foreground disabled:opacity-50"
            aria-label={playing ? 'pause' : 'play'}
          >
            {playing ? <Pause className="size-4" /> : <Play className="size-4" />}
          </button>
          <span className="font-mono text-xs tabular-nums text-muted-foreground">
            {fmtTime(current)} / {fmtTime(duration)}
          </span>

          <div className="flex items-center gap-1.5">
            <Volume2 className="size-3.5 text-muted-foreground" />
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={volume}
              onChange={(e) => onVolume(Number(e.target.value))}
              className="w-24 accent-primary-strong"
              aria-label="volume"
            />
          </div>

          <div className="flex items-center gap-1.5">
            <Gauge className="size-3.5 text-muted-foreground" />
            <select
              value={rate}
              onChange={(e) => onRate(Number(e.target.value))}
              className="h-7 rounded border border-border bg-background px-1 text-xs text-foreground"
              aria-label="playback rate"
            >
              {RATES.map((r) => (
                <option key={r} value={r}>
                  {r}×
                </option>
              ))}
            </select>
          </div>
        </div>
      </div>
    </div>
  );
}

/** 原生 <audio> 回退（wavesurfer 无法解码时的第二级） */
function NativeAudioFallback({ src, label }: { src: string; label: string }) {
  const { t } = useTranslation();
  const [failed, setFailed] = useState(false);

  if (failed || !src) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-muted-foreground">
        <TriangleAlert className="size-6" />
        <div className="max-w-md text-center text-sm">{t('preview.mediaUnsupported')}</div>
        <div className="text-xs">{t('preview.mediaUnsupportedHint')}</div>
        {src && (
          <a
            href={src}
            download
            className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-xs text-foreground hover:bg-muted"
          >
            <Download className="size-3.5" />
            {t('preview.download')}
          </a>
        )}
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 rounded border border-border bg-muted/20 p-6">
      <Music className="size-10 text-primary-strong" />
      <div className="w-full max-w-lg truncate text-center font-mono text-xs text-muted-foreground">{label}</div>
      <audio src={src} controls preload="metadata" onError={() => setFailed(true)} className="w-full max-w-lg" />
    </div>
  );
}