// render/structured/GeoPreview.tsx
// 结构化文本预览：地理数据（geojson / kml / gpx）。
// 按扩展名分派解析为点数组 → 外接矩形 + canvas 散点图。
// 解析/绘制异常仅降级为提示态，绝不抛错影响父组件。
// 本组件经 React.lazy 懒加载（FilePreviewPane 分发）。

import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { MapPin } from 'lucide-react';

/** 超大文本截断阈值 */
const MAX_TEXT_LENGTH = 8 * 1024 * 1024;
/** 画布绘制点数上限，避免超大数据卡顿 */
const MAX_POINTS = 20000;

interface GeoPoint {
  lat: number;
  lon: number;
}

interface GeoBounds {
  minLat: number;
  maxLat: number;
  minLon: number;
  maxLon: number;
}

export interface GeoPreviewProps {
  text: string;
  ext: string;
}

/** 将坐标对 [lon, lat]（GeoJSON 顺序）转为点 */
function coordPairToPoint(value: unknown): GeoPoint | null {
  if (!Array.isArray(value) || value.length < 2) return null;
  const lon = value[0];
  const lat = value[1];
  if (typeof lon !== 'number' || typeof lat !== 'number') return null;
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null;
  return { lat, lon };
}

/** 递归收集 GeoJSON 坐标（支持 LineString/Polygon 等嵌套数组） */
function collectCoords(value: unknown, out: GeoPoint[]): void {
  if (out.length >= MAX_POINTS) return;
  if (!Array.isArray(value)) return;
  const pair = coordPairToPoint(value);
  if (pair !== null) {
    out.push(pair);
    return;
  }
  for (const item of value) collectCoords(item, out);
}

/** 递归遍历 GeoJSON 节点，收集所有几何坐标 */
function collectGeoJson(value: unknown, out: GeoPoint[]): void {
  if (out.length >= MAX_POINTS) return;
  if (value === null || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const item of value) collectGeoJson(item, out);
    return;
  }
  const obj = value as Record<string, unknown>;
  const type = obj.type;
  if (typeof type === 'string') {
    if (type === 'Point' || type === 'LineString' || type === 'MultiLineString' || type === 'Polygon' || type === 'MultiPolygon') {
      collectCoords(obj.coordinates, out);
      return;
    }
    // Feature / FeatureCollection / GeometryCollection
    if (obj.geometry !== undefined) collectGeoJson(obj.geometry, out);
    if (obj.geometries !== undefined) collectGeoJson(obj.geometries, out);
    if (obj.features !== undefined) collectGeoJson(obj.features, out);
  }
}

/** KML：提取 <coordinates> 文本（lon,lat[,alt] 以空白分隔） */
function parseKml(doc: Document): GeoPoint[] {
  const out: GeoPoint[] = [];
  const nodes = doc.getElementsByTagName('coordinates');
  for (let i = 0; i < nodes.length; i++) {
    const raw = nodes[i].textContent ?? '';
    const tokens = raw.trim().split(/\s+/);
    for (const token of tokens) {
      const nums = token.split(',');
      if (nums.length < 2) continue;
      const lon = Number(nums[0]);
      const lat = Number(nums[1]);
      if (Number.isFinite(lon) && Number.isFinite(lat)) out.push({ lat, lon });
      if (out.length >= MAX_POINTS) return out;
    }
  }
  return out;
}

/** GPX：提取 trkpt / rtept / wpt 的 lat / lon 属性 */
function parseGpx(doc: Document): GeoPoint[] {
  const out: GeoPoint[] = [];
  const tags = ['trkpt', 'rtept', 'wpt'];
  for (const tag of tags) {
    const nodes = doc.getElementsByTagName(tag);
    for (let i = 0; i < nodes.length; i++) {
      const latAttr = nodes[i].getAttribute('lat');
      const lonAttr = nodes[i].getAttribute('lon');
      if (latAttr === null || lonAttr === null) continue;
      const lat = Number(latAttr);
      const lon = Number(lonAttr);
      if (Number.isFinite(lat) && Number.isFinite(lon)) out.push({ lat, lon });
      if (out.length >= MAX_POINTS) return out;
    }
  }
  return out;
}

/** 用 DOMParser 解析 XML（失败返回 null） */
function parseXml(text: string): Document | null {
  try {
    const doc = new DOMParser().parseFromString(text, 'application/xml');
    if (doc.getElementsByTagName('parsererror').length > 0) return null;
    return doc;
  } catch {
    return null;
  }
}

function parseGeo(text: string, ext: string): GeoPoint[] {
  const e = ext.toLowerCase().replace(/^\./, '');
  if (e === 'geojson' || e === 'json') {
    const parsed: unknown = JSON.parse(text);
    const out: GeoPoint[] = [];
    collectGeoJson(parsed, out);
    return out;
  }
  const doc = parseXml(text);
  if (doc === null) return [];
  if (e === 'kml') return parseKml(doc);
  if (e === 'gpx') return parseGpx(doc);
  // 未知扩展名：尝试 kml/gpx 顺序
  const kml = parseKml(doc);
  return kml.length > 0 ? kml : parseGpx(doc);
}

function boundsOf(points: GeoPoint[]): GeoBounds | null {
  if (points.length === 0) return null;
  let minLat = Infinity;
  let maxLat = -Infinity;
  let minLon = Infinity;
  let maxLon = -Infinity;
  for (const p of points) {
    if (p.lat < minLat) minLat = p.lat;
    if (p.lat > maxLat) maxLat = p.lat;
    if (p.lon < minLon) minLon = p.lon;
    if (p.lon > maxLon) maxLon = p.lon;
  }
  return { minLat, maxLat, minLon, maxLon };
}

export function GeoPreview({ text, ext }: GeoPreviewProps) {
  const { t } = useTranslation();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [drawFailed, setDrawFailed] = useState(false);

  const points = useMemo<GeoPoint[]>(() => {
    try {
      const src = text.length > MAX_TEXT_LENGTH ? text.slice(0, MAX_TEXT_LENGTH) : text;
      return parseGeo(src, ext);
    } catch {
      return [];
    }
  }, [text, ext]);

  const bounds = useMemo<GeoBounds | null>(() => boundsOf(points), [points]);

  useEffect(() => {
    const container = containerRef.current;
    const canvas = canvasRef.current;
    if (container === null || canvas === null || bounds === null || points.length < 2) return;

    const draw = (): void => {
      const width = container.clientWidth;
      const height = container.clientHeight;
      if (width <= 0 || height <= 0) return;
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      const ctx = canvas.getContext('2d');
      if (ctx === null) {
        setDrawFailed(true);
        return;
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, width, height);
      const margin = 12;
      const spanLon = bounds.maxLon - bounds.minLon;
      const spanLat = bounds.maxLat - bounds.minLat;
      const color = getComputedStyle(canvas).color || getComputedStyle(document.documentElement).getPropertyValue('--palette-primary').trim();
      ctx.fillStyle = color;
      for (const p of points) {
        const x =
          spanLon === 0 ? width / 2 : margin + ((p.lon - bounds.minLon) / spanLon) * (width - 2 * margin);
        const y =
          spanLat === 0 ? height / 2 : height - margin - ((p.lat - bounds.minLat) / spanLat) * (height - 2 * margin);
        ctx.beginPath();
        ctx.arc(x, y, 2, 0, Math.PI * 2);
        ctx.fill();
      }
    };

    try {
      draw();
    } catch {
      setDrawFailed(true);
      return;
    }

    let observer: ResizeObserver | null = null;
    try {
      observer = new ResizeObserver(() => {
        try {
          draw();
        } catch {
          setDrawFailed(true);
        }
      });
      observer.observe(container);
    } catch {
      observer = null;
    }
    return () => {
      if (observer !== null) observer.disconnect();
    };
  }, [points, bounds]);

  return (
    <div className="flex h-full min-h-0 flex-col gap-2">
      <div className="flex shrink-0 flex-wrap items-center gap-1.5 px-1 text-xs text-muted-foreground">
        <MapPin className="size-3.5" />
        <span className="text-foreground">{t('preview.geoTitle')}</span>
        <span className="tabular-nums">{t('preview.geoPoints', { count: points.length })}</span>
        {bounds !== null && (
          <span className="tabular-nums">
            {t('preview.geoBounds')}: {bounds.minLat.toFixed(5)}, {bounds.minLon.toFixed(5)} ~{' '}
            {bounds.maxLat.toFixed(5)}, {bounds.maxLon.toFixed(5)}
          </span>
        )}
      </div>

      {points.length === 0 ? (
        <div className="flex min-h-0 flex-1 items-center justify-center rounded border border-border bg-muted/20 px-4 text-sm text-muted-foreground">
          {t('preview.geoEmpty')}
        </div>
      ) : points.length < 2 || drawFailed ? (
        <div className="flex min-h-0 flex-1 items-center justify-center rounded border border-border bg-muted/20 px-4 text-sm text-muted-foreground">
          {t('preview.geoDrawFailed')}
        </div>
      ) : (
        <div ref={containerRef} className="relative min-h-0 flex-1 overflow-hidden rounded border border-border bg-muted/20">
          <canvas ref={canvasRef} className="block h-full w-full text-primary-strong" />
        </div>
      )}
    </div>
  );
}