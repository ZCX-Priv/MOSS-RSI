// webui/public/voice-capture-worklet.js
// 语音采集 AudioWorklet 处理器（静态资源：供 ctx.audioWorklet.addModule 直接加载，
// 避免个别浏览器/受限环境下 blob: URL 不可用）。
//
// 职责：
//   1. 从输入通道取能量最大的通道，做 DC 阻断（去直流偏置）。
//   2. 采样率 != targetSampleRate（16000）时用「窗函数 sinc 多相 FIR」重采样到 16k，
//      带抗混叠，保证送往后端的 PCM 恒为 16k 单声道。
//   3. 按 1024 样本为一帧 postMessage 给主线程（transfer 零拷贝）。
//
// 关键：所有进入缓冲的样本都必须复制。AudioWorklet 的输入数组可能被音频线程复用，
// 直接保存引用会在下一个渲染量子被覆盖，表现为周期性噪声/识别乱码。
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
    this.ratio = ratio;
    this.identity = Math.abs(ratio - 1) < 1e-6;

    // 多相 FIR：32 相 × 24 taps，Hann 窗 sinc 低通（截止 0.45 × 目标奈奎斯特）
    this.phases = 32;
    this.taps = 24;
    this.half = this.taps / 2;
    const cutoff = 0.45 * Math.min(1, this.target / sampleRate);
    this.coeffs = new Array(this.phases);
    for (let ph = 0; ph < this.phases; ph++) {
      const frac = ph / this.phases;
      const h = new Float32Array(this.taps);
      let sum = 0;
      for (let k = 0; k < this.taps; k++) {
        const t = k - (this.taps / 2 - 1) - frac;
        const sinc = t === 0 ? 2 * cutoff : Math.sin(2 * Math.PI * cutoff * t) / (Math.PI * t);
        const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * (k + 0.5)) / this.taps);
        h[k] = sinc * w;
        sum += h[k];
      }
      if (Math.abs(sum) > 1e-9) {
        for (let k = 0; k < this.taps; k++) h[k] /= sum;
      }
      this.coeffs[ph] = h;
    }
    /** 跨块输入缓冲（Float32Array，按需重建） */
    this.pending = new Float32Array(0);
    /** 下一个输出样本在 pending 中的源位置（浮点） */
    this.nextPos = this.half;

    // DC 阻断器状态
    this.dcPrevIn = 0;
    this.dcPrevOut = 0;
  }

  /** 窗函数 sinc 多相 FIR 重采样一块输入（返回新数组；无输出返回 null） */
  _resample(input) {
    // 拼接跨块残留
    const buf = new Float32Array(this.pending.length + input.length);
    buf.set(this.pending);
    buf.set(input, this.pending.length);

    const out = [];
    const limit = buf.length - this.taps;
    let pos = this.nextPos;
    while (pos <= limit) {
      const base = Math.floor(pos);
      const frac = pos - base;
      const ph = Math.min(this.phases - 1, Math.round(frac * this.phases));
      const c = this.coeffs[ph];
      let acc = 0;
      for (let k = 0; k < this.taps; k++) acc += buf[base + k] * c[k];
      out.push(acc);
      pos += this.ratio;
    }

    // 丢弃已消费的前缀，保留一个窗口的历史
    const keepFrom = Math.max(0, Math.floor(pos) - this.taps);
    if (keepFrom > 0) {
      this.pending = buf.slice(keepFrom);
      this.nextPos = pos - keepFrom;
    } else {
      this.pending = buf;
      this.nextPos = pos;
    }
    return out.length ? Float32Array.from(out) : null;
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;

    // 多通道：取能量最大的通道。多麦阵列通道间存在相位差，平均混音会互相抵消。
    let ch;
    if (input.length === 1) {
      ch = input[0];
    } else {
      let best = 0;
      let bestEnergy = -1;
      for (let c = 0; c < input.length; c++) {
        const src = input[c];
        let energy = 0;
        for (let i = 0; i < src.length; i++) energy += src[i] * src[i];
        if (energy > bestEnergy) {
          bestEnergy = energy;
          best = c;
        }
      }
      ch = input[best];
    }

    // DC 阻断（一阶高通）：复制样本，避免持有工作线程的复用缓冲
    const filtered = new Float32Array(ch.length);
    for (let i = 0; i < ch.length; i++) {
      const x = ch[i];
      const y = x - this.dcPrevIn + 0.995 * this.dcPrevOut;
      this.dcPrevIn = x;
      this.dcPrevOut = y;
      filtered[i] = y;
    }

    let outChunk;
    if (this.identity) {
      outChunk = filtered;
    } else {
      outChunk = this._resample(filtered);
      if (!outChunk || outChunk.length === 0) return true;
    }

    this.chunks.push(outChunk);
    this.length += outChunk.length;
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
