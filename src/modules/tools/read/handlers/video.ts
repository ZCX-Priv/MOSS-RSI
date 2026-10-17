// read/handlers/video.ts
// 视频文件读取：不做解码/首帧，仅返回「基础文件信息 + 容器元数据」供 LLM 了解视频概况。
//
// 纯 JS、有界 IO（全程 openSync + readSync 偏移读取，绝不整读文件）：
//   - ISO BMFF（mp4/m4v/mov/3gp/3g2）：顶层 box 遍历找 moov，解析 mvhd（时长）、trak(hdlr 'vide')→
//     mdia/stbl/stsd（宽高 + 编码 fourcc）。
//   - Matroska/WebM（webm/mkv）：EBML 解析 Segment/Info（TimecodeScale/Duration）与 Tracks/Video
//     （PixelWidth/PixelHeight、CodecID）。
//   - 其它容器（avi/wmv/flv/mpeg…）：仅基础文件信息，标注「未解析容器元数据」。
// 任何解析异常均降级为基础信息，绝不抛错。

import { closeSync, openSync, readSync, statSync } from 'node:fs';
import { extname } from 'node:path';
import type { ToolResult } from '../../types';

/** 视频扩展名（与 shared/analysis-dir.ts 的 VIDEO_ASSET_EXTS 语义一致） */
const VIDEO_EXTS = new Set([
  'mp4', 'm4v', 'mov', 'qt', 'avi', 'wmv', 'asf', 'mkv', 'webm', 'flv',
  '3gp', '3g2', 'mpeg', 'mpg', 'ogv', 'rmvb',
]);

/** 扩展名 → MIME */
const MIME_BY_EXT: Record<string, string> = {
  mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime', qt: 'video/quicktime',
  avi: 'video/x-msvideo', wmv: 'video/x-ms-wmv', asf: 'video/x-ms-asf', mkv: 'video/x-matroska',
  webm: 'video/webm', flv: 'video/x-flv', '3gp': 'video/3gpp', '3g2': 'video/3gpp2',
  mpeg: 'video/mpeg', mpg: 'video/mpeg', ogv: 'video/ogg', rmvb: 'application/vnd.rn-realmedia-vbr',
};

/** moov / 单个 box 解析允许读取的最大字节数（防超大容器撑爆内存） */
const MAX_BOX_READ = 8 * 1024 * 1024;

/** EBML 头部解析允许读取的最大字节数 */
const EBML_HEAD_READ = 4 * 1024 * 1024;

/** 容器元数据 */
interface VideoMeta {
  /** 容器类型描述 */
  container: string;
  /** 品牌（ISO BMFF ftyp major brand） */
  brand?: string;
  /** 时长（秒） */
  durationSec?: number;
  width?: number;
  height?: number;
  /** 视频编码 fourcc / CodecID */
  codec?: string;
  /** 轨道统计 */
  tracks?: { video: number; audio: number; other: number };
}

/** 读取文件中 [offset, offset+length) 字节（fd 已打开；越界自动截断） */
function readRange(fd: number, offset: number, length: number, fileSize: number): Buffer {
  const len = Math.max(0, Math.min(length, fileSize - offset));
  if (len <= 0) return Buffer.alloc(0);
  const buf = Buffer.alloc(len);
  let read = 0;
  while (read < len) {
    const n = readSync(fd, buf, read, len - read, offset + read);
    if (n <= 0) break;
    read += n;
  }
  return read === len ? buf : buf.subarray(0, read);
}

/** 读取文件头部（≤ maxBytes） */
function readHead(fd: number, maxBytes: number, fileSize: number): Buffer {
  return readRange(fd, 0, Math.min(maxBytes, fileSize), fileSize);
}

// ─────────────────────────────── ISO BMFF（mp4/mov/…） ───────────────────────────────

interface IsoBox {
  type: string;
  /** box 数据区起点（box 头之后） */
  dataStart: number;
  /** box 数据区终点 */
  dataEnd: number;
}

/** 遍历 [start, end) 区间内的同级 box（基于 fd 偏移读取 box 头） */
function* iterIsoBoxes(fd: number, start: number, end: number, fileSize: number): Generator<IsoBox> {
  let off = start;
  while (off + 8 <= end) {
    const head = readRange(fd, off, 16, fileSize);
    if (head.length < 8) return;
    let size = head.readUInt32BE(0);
    const type = head.toString('latin1', 4, 8);
    let dataStart = off + 8;
    if (size === 1) {
      if (head.length < 16) return;
      size = Number(head.readBigUInt64BE(8));
      dataStart = off + 16;
    } else if (size === 0) {
      size = end - off;
    }
    if (size < 8) return;
    yield { type, dataStart, dataEnd: Math.min(off + size, end) };
    off += size;
  }
}

/** 在已读入内存的 buffer 内遍历同级 box（用于 moov 内部解析） */
function listIsoBoxes(buf: Buffer, start: number, end: number): IsoBox[] {
  const out: IsoBox[] = [];
  let off = start;
  while (off + 8 <= end) {
    const size = buf.readUInt32BE(off);
    const type = buf.toString('latin1', off + 4, off + 8);
    let dataStart = off + 8;
    let boxSize = size;
    if (size === 1) {
      if (off + 16 > end) break;
      boxSize = Number(buf.readBigUInt64BE(off + 8));
      dataStart = off + 16;
    } else if (size === 0) {
      boxSize = end - off;
    }
    if (boxSize < 8) break;
    out.push({ type, dataStart, dataEnd: Math.min(off + boxSize, end) });
    off += boxSize;
  }
  return out;
}

/** 取某个直接子 box（不存在返回 null） */
function findIsoBox(boxes: IsoBox[], type: string): IsoBox | null {
  return boxes.find((b) => b.type === type) ?? null;
}

/** 解析 mvhd（时长 / timescale） */
function parseMvhd(moov: Buffer, box: IsoBox): number | undefined {
  const p = box.dataStart;
  try {
    const version = moov[p];
    let timescale: number;
    let duration: number;
    if (version === 1) {
      timescale = moov.readUInt32BE(p + 4 + 16);
      duration = Number(moov.readBigUInt64BE(p + 4 + 20));
    } else {
      timescale = moov.readUInt32BE(p + 4 + 8);
      duration = moov.readUInt32BE(p + 4 + 12);
    }
    if (timescale > 0 && duration > 0) return duration / timescale;
  } catch {
    // 解析失败
  }
  return undefined;
}

/** 解析单个 trak：返回 handler 类型与（视频轨的）编码/宽高 */
function parseTrak(moov: Buffer, trak: IsoBox): {
  handler: string;
  codec?: string;
  width?: number;
  height?: number;
} | null {
  try {
    const mdia = findIsoBox(listIsoBoxes(moov, trak.dataStart, trak.dataEnd), 'mdia');
    if (!mdia) return null;
    const mdiaChildren = listIsoBoxes(moov, mdia.dataStart, mdia.dataEnd);

    // hdlr：handler_type（第 4..8 字节在 version/flags + pre_defined 之后）
    const hdlr = findIsoBox(mdiaChildren, 'hdlr');
    let handler = '';
    if (hdlr) {
      // version(1)+flags(3)+pre_defined(4) → handler_type(4)
      handler = moov.toString('latin1', hdlr.dataStart + 8, hdlr.dataStart + 12);
    }

    const result: { handler: string; codec?: string; width?: number; height?: number } = { handler };

    const minf = findIsoBox(mdiaChildren, 'minf');
    const stbl = minf ? findIsoBox(listIsoBoxes(moov, minf.dataStart, minf.dataEnd), 'stbl') : null;
    const stsd = stbl ? findIsoBox(listIsoBoxes(moov, stbl.dataStart, stbl.dataEnd), 'stsd') : null;
    if (stsd) {
      // version(1)+flags(3)+entry_count(4) → 首个 sample entry 的 size(4)+format(4)
      const entryStart = stsd.dataStart + 8;
      const entries = listIsoBoxes(moov, entryStart, stsd.dataEnd);
      const entry = entries[0];
      if (entry) {
        result.codec = entry.type;
        if (handler === 'vide') {
          // VisualSampleEntry：reserved(6)+data_ref_index(2)+pre_defined(2)+reserved(2)+pre_defined(12)
          // → width(2) + height(2)
          const base = entry.dataStart + 24;
          result.width = moov.readUInt16BE(base);
          result.height = moov.readUInt16BE(base + 2);
        }
      }
    }
    return result;
  } catch {
    return null;
  }
}

/** 解析 ISO BMFF：找 ftyp/moov 并解出元数据 */
function parseIsoBmff(fd: number, fileSize: number): VideoMeta | null {
  let brand: string | undefined;
  let moovBuffer: Buffer | null = null;

  for (const box of iterIsoBoxes(fd, 0, fileSize, fileSize)) {
    if (box.type === 'ftyp') {
      const head = readRange(fd, box.dataStart, 4, fileSize);
      if (head.length >= 4) brand = head.toString('latin1', 0, 4);
    } else if (box.type === 'moov') {
      const size = box.dataEnd - box.dataStart;
      moovBuffer = readRange(fd, box.dataStart, Math.min(size, MAX_BOX_READ), fileSize);
      break;
    }
  }
  if (!moovBuffer) {
    // 无 moov（流式/损坏）：仅返回品牌
    return brand ? { container: 'ISO BMFF', brand } : { container: 'ISO BMFF' };
  }

  const meta: VideoMeta = { container: 'ISO BMFF', brand };
  const children = listIsoBoxes(moovBuffer, 0, moovBuffer.length);

  const mvhd = findIsoBox(children, 'mvhd');
  if (mvhd) meta.durationSec = parseMvhd(moovBuffer, mvhd);

  let video = 0;
  let audio = 0;
  let other = 0;
  for (const child of children) {
    if (child.type !== 'trak') continue;
    const trak = parseTrak(moovBuffer, child);
    if (!trak) {
      other++;
      continue;
    }
    if (trak.handler === 'vide') {
      video++;
      if (meta.width === undefined && trak.width) meta.width = trak.width;
      if (meta.height === undefined && trak.height) meta.height = trak.height;
      if (!meta.codec && trak.codec) meta.codec = trak.codec;
    } else if (trak.handler === 'soun') {
      audio++;
    } else {
      other++;
    }
  }
  meta.tracks = { video, audio, other };
  return meta;
}

// ─────────────────────────────── Matroska / WebM（EBML） ───────────────────────────────

interface EbmlElement {
  id: number;
  dataStart: number;
  dataEnd: number;
}

/** 读 EBML 变量长整型长度（首字节前导 0 个数决定字节数） */
function vintLength(first: number): number {
  if (first === 0) return 0;
  let len = 1;
  for (let mask = 0x80; (first & mask) === 0 && len < 8; mask >>= 1) len++;
  return len;
}

/** 遍历 [start, end) 内的 EBML 元素 */
function* iterEbml(buf: Buffer, start: number, end: number): Generator<EbmlElement> {
  let pos = start;
  while (pos < end) {
    const idLen = vintLength(buf[pos]);
    if (idLen === 0 || pos + idLen > end) return;
    let id = 0;
    for (let i = 0; i < idLen; i++) id = id * 256 + buf[pos + i];
    const sizePos = pos + idLen;
    const sizeLen = vintLength(buf[sizePos]);
    if (sizeLen === 0 || sizePos + sizeLen > end) return;
    let size = buf[sizePos];
    for (let i = 1; i < sizeLen; i++) size = size * 256 + buf[sizePos + i];
    // 清除 size 的标记位（首字节最高有效位 = 2^(8*sizeLen-1)）；用减法避免 32 位按位运算溢出
    size -= 2 ** (8 * sizeLen - 1);
    const dataStart = sizePos + sizeLen;
    const dataEnd = Math.min(dataStart + size, end);
    yield { id, dataStart, dataEnd };
    pos = dataStart + size;
  }
}

/** 解析 EBML 无符号整数（≤8 字节） */
function ebmlUint(buf: Buffer, el: EbmlElement): number {
  let v = 0;
  for (let i = el.dataStart; i < el.dataEnd && i < el.dataStart + 8; i++) v = v * 256 + buf[i];
  return v;
}

/** 解析 EBML 浮点（4 或 8 字节） */
function ebmlFloat(buf: Buffer, el: EbmlElement): number {
  const len = el.dataEnd - el.dataStart;
  try {
    if (len === 4) return buf.readFloatBE(el.dataStart);
    if (len === 8) return buf.readDoubleBE(el.dataStart);
  } catch {
    // 忽略
  }
  return 0;
}

/** 解析 EBML 字符串 */
function ebmlString(buf: Buffer, el: EbmlElement): string {
  return buf.toString('utf8', el.dataStart, el.dataEnd).replace(/\0+$/, '');
}

const EBML_SEGMENT = 0x18538067;
const EBML_INFO = 0x1549a966;
const EBML_TIMECODE_SCALE = 0x2ad7b1;
const EBML_DURATION = 0x4489;
const EBML_TRACKS = 0x1654ae6b;
const EBML_TRACK_ENTRY = 0xae;
const EBML_TRACK_TYPE = 0x83;
const EBML_CODEC_ID = 0x86;
const EBML_VIDEO = 0xe0;
const EBML_PIXEL_WIDTH = 0xb0;
const EBML_PIXEL_HEIGHT = 0xba;

/** 解析 Matroska/WebM（头部有界读取） */
function parseMatroska(fd: number, fileSize: number): VideoMeta | null {
  const buf = readHead(fd, EBML_HEAD_READ, fileSize);
  const meta: VideoMeta = { container: 'Matroska/WebM' };

  const top = [...iterEbml(buf, 0, buf.length)];
  const segment = top.find((e) => e.id === EBML_SEGMENT);

  let timecodeScale = 1_000_000;
  let durationTicks = 0;
  let width: number | undefined;
  let height: number | undefined;
  let codec: string | undefined;
  let video = 0;
  let audio = 0;

  const segStart = segment ? segment.dataStart : 0;
  const segEnd = segment ? segment.dataEnd : buf.length;

  for (const el of iterEbml(buf, segStart, segEnd)) {
    if (el.id === EBML_INFO) {
      for (const info of iterEbml(buf, el.dataStart, el.dataEnd)) {
        if (info.id === EBML_TIMECODE_SCALE) timecodeScale = ebmlUint(buf, info) || timecodeScale;
        else if (info.id === EBML_DURATION) durationTicks = ebmlFloat(buf, info);
      }
    } else if (el.id === EBML_TRACKS) {
      for (const track of iterEbml(buf, el.dataStart, el.dataEnd)) {
        if (track.id !== EBML_TRACK_ENTRY) continue;
        let trackType = 0;
        let trackCodec: string | undefined;
        let w: number | undefined;
        let h: number | undefined;
        for (const t of iterEbml(buf, track.dataStart, track.dataEnd)) {
          if (t.id === EBML_TRACK_TYPE) trackType = ebmlUint(buf, t);
          else if (t.id === EBML_CODEC_ID) trackCodec = ebmlString(buf, t);
          else if (t.id === EBML_VIDEO) {
            for (const v of iterEbml(buf, t.dataStart, t.dataEnd)) {
              if (v.id === EBML_PIXEL_WIDTH) w = ebmlUint(buf, v);
              else if (v.id === EBML_PIXEL_HEIGHT) h = ebmlUint(buf, v);
            }
          }
        }
        if (trackType === 1) {
          video++;
          if (width === undefined && w) width = w;
          if (height === undefined && h) height = h;
          if (!codec && trackCodec) codec = trackCodec;
        } else if (trackType === 2) {
          audio++;
        }
      }
    }
  }

  if (durationTicks > 0 && timecodeScale > 0) meta.durationSec = (durationTicks * timecodeScale) / 1e9;
  meta.width = width;
  meta.height = height;
  meta.codec = codec;
  meta.tracks = { video, audio, other: 0 };
  const hasAny = durationTicks > 0 || width !== undefined || video > 0;
  return hasAny ? meta : { container: 'Matroska/WebM' };
}

// ─────────────────────────────── 对外入口 ───────────────────────────────

/** 人类可读时长（hh:mm:ss / mm:ss） */
function formatDuration(sec: number | undefined): string | undefined {
  if (sec === undefined || !isFinite(sec) || sec <= 0) return undefined;
  const total = Math.round(sec);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number): string => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/**
 * 读取视频文件，返回基础信息 + 容器元数据。
 * 有界 IO，解析失败降级为基础信息，绝不抛错。
 */
export function readVideo(path: string): ToolResult {
  const ext = extname(path).toLowerCase().replace('.', '');
  const mime = MIME_BY_EXT[ext] ?? 'application/octet-stream';

  let size = 0;
  let mtimeMs = 0;
  try {
    const st = statSync(path);
    size = st.size;
    mtimeMs = st.mtimeMs;
  } catch {
    return {
      content: [{ type: 'text', text: `Error: cannot stat video file: ${path}` }],
      isError: true,
    };
  }

  let meta: VideoMeta | null = null;
  if (VIDEO_EXTS.has(ext)) {
    let fd: number | null = null;
    try {
      fd = openSync(path, 'r');
      if (ext === 'mp4' || ext === 'm4v' || ext === 'mov' || ext === 'qt' || ext === '3gp' || ext === '3g2') {
        meta = parseIsoBmff(fd, size);
      } else if (ext === 'webm' || ext === 'mkv') {
        meta = parseMatroska(fd, size);
      }
    } catch {
      meta = null;
    } finally {
      if (fd !== null) {
        try {
          closeSync(fd);
        } catch {
          // 忽略关闭失败
        }
      }
    }
  }

  const lines: string[] = [
    `${path} (VIDEO)`,
    `- size: ${size} bytes`,
    `- mime: ${mime}`,
    `- modified: ${new Date(mtimeMs).toISOString()}`,
  ];
  if (meta) {
    lines.push(`- container: ${meta.container}${meta.brand ? ` (brand: ${meta.brand})` : ''}`);
    const dur = formatDuration(meta.durationSec);
    if (meta.durationSec !== undefined && meta.durationSec > 0) {
      lines.push(`- duration: ${meta.durationSec.toFixed(3)} s${dur ? ` (${dur})` : ''}`);
    }
    if (meta.width && meta.height) lines.push(`- resolution: ${meta.width}x${meta.height}`);
    if (meta.codec) lines.push(`- video codec: ${meta.codec}`);
    if (meta.tracks) {
      lines.push(`- tracks: video=${meta.tracks.video}, audio=${meta.tracks.audio}, other=${meta.tracks.other}`);
    }
  } else {
    lines.push('- note: container metadata not parsed (unsupported or unreadable container)');
  }

  return {
    content: [{ type: 'text', text: lines.join('\n') }],
    metadata: {
      type: 'video',
      mimeType: mime,
      sizeBytes: size,
      mtimeMs,
      ...(meta ?? {}),
    },
  };
}
