// webui/public/voice-capture-worklet.js
// 语音采集 AudioWorklet 处理器（静态资源：供 ctx.audioWorklet.addModule 直接加载，
// 避免个别浏览器/受限环境下 blob: URL 不可用）。
//
// 职责：
//   1. 从输入通道累积 PCM（Float32），按 1024 样本为一帧 postMessage 给主线程（transfer 零拷贝）。
//   2. 当 AudioContext 的采样率 != targetSampleRate（16000）时，在 worklet 内重采样到 16kHz，
//      保证送往后端的 PCM 恒为 16k 单声道（与后端识别口径一致）。
//
// targetSampleRate 经 AudioWorkletNode 的 processorOptions 传入。
// 本文件是纯 JS 静态资源（不参与打包/类型检查），仅供浏览器执行。

class VoiceCaptureProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const opts = (options && options.processorOptions) || {};
    this.target = opts.targetSampleRate || 16000;

    // 输出帧累积
    this.chunks = [];
    this.length = 0;

    // 重采样状态
    const ratio = sampleRate / this.target; // AudioWorkletGlobalScope 提供全局 sampleRate
    // 整数比（48k/16k=3、32k/16k=2）：盒式平均抽取（自带粗抗混叠）
    this.integerRatio = Math.abs(ratio - Math.round(ratio)) < 0.01 ? Math.round(ratio) : 0;
    this.ratio = ratio;
    // 盒式抽取累加器（跨块保留）
    this.sum = 0;
    this.count = 0;
    // 非整数比的线性插值状态（跨块保留）
    this.tail = null;
    this.pos = 0;
  }

  /** 重采样一个输入块 → 输出块；无输出返回 null */
  _resample(ch) {
    if (this.integerRatio === 1) return ch;
    if (this.integerRatio > 1) {
      const R = this.integerRatio;
      const out = [];
      let sum = this.sum;
      let count = this.count;
      for (let i = 0; i < ch.length; i++) {
        sum += ch[i];
        count++;
        if (count === R) {
          out.push(sum / R);
          sum = 0;
          count = 0;
        }
      }
      this.sum = sum;
      this.count = count;
      return out.length ? Float32Array.from(out) : null;
    }
    // 线性插值（跨块状态连续：保留尾部样本 + 分数相位）
    let buf;
    if (!this.tail || this.tail.length === 0) {
      buf = ch;
    } else {
      buf = new Float32Array(this.tail.length + ch.length);
      buf.set(this.tail, 0);
      buf.set(ch, this.tail.length);
    }
    const M = buf.length;
    const out = [];
    let pos = this.pos;
    for (;;) {
      const i = Math.floor(pos);
      if (i + 1 >= M) break; // 需要 i 与 i+1 两个样本
      const f = pos - i;
      out.push(buf[i] + (buf[i + 1] - buf[i]) * f);
      pos += this.ratio;
    }
    const keepFrom = Math.min(Math.floor(pos), Math.max(0, M - 1));
    this.tail = buf.slice(keepFrom);
    this.pos = pos - keepFrom;
    return out.length ? Float32Array.from(out) : null;
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || !input[0]) return true;
    let ch = input[0];
    if (this.target && sampleRate !== this.target) {
      ch = this._resample(ch);
      if (!ch || ch.length === 0) return true;
    }
    this.chunks.push(ch);
    this.length += ch.length;
    if (this.length >= 1024) {
      const out = new Float32Array(this.length);
      let off = 0;
      for (const c of this.chunks) {
        out.set(c, off);
        off += c.length;
      }
      this.port.postMessage(out, [out.buffer]);
      this.chunks = [];
      this.length = 0;
    }
    return true;
  }
}

registerProcessor('voice-capture', VoiceCaptureProcessor);
