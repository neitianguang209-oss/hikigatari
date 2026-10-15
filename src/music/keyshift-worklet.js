// 流れている音のキーをその場で変える(AudioWorklet)。パソコンで YouTube の原曲をそのキーで流すときに使う
// はじめのキーは processorOptions.semis、あとから port へ { semis } を送ると変わる(半音いくつぶん上げ下げするか)
// キーを変えた音は、音割れ止めのぶん元より少し小さくなる。原曲キーで流すとき(聴き比べ)は、そのぶん小さくして大きさをそろえる
import { KeyShifter } from './keyshift.js';

class KeyShiftProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.ks = new KeyShifter(sampleRate);
    this.ks.setSemitones(options?.processorOptions?.semis || 0);
    this.spare = new Float32Array(128);
    this.pIn = 0; // 入ってくる音・出ていく音の大きさ(約3秒でならした平均)
    this.pOut = 0;
    this.g = 1;
    this.a = 1 - Math.exp(-128 / (sampleRate * 3));
    this.port.onmessage = (e) => {
      const d = e.data || {};
      if (typeof d.semis === 'number') this.ks.setSemitones(d.semis);
    };
    this.port.postMessage({ latency: this.ks.latency / sampleRate });
  }

  process(inputs, outputs) {
    const inp = inputs[0] || [];
    const out = outputs[0];
    if (!out?.[0]) return true;
    const n = out[0].length;
    if (this.spare.length !== n) this.spare = new Float32Array(n);
    const oR = out[1] || this.spare;
    this.ks.process(inp[0] || null, inp[1] || null, out[0], oR);
    let pi = 0;
    let po = 0;
    if (inp[0]) for (let i = 0; i < n; i++) pi += inp[0][i] * inp[0][i];
    for (let i = 0; i < n; i++) po += out[0][i] * out[0][i];
    if (this.ks.semis !== 0) {
      if (pi > 1e-7 * n) {
        this.pIn += (pi / n - this.pIn) * this.a;
        this.pOut += (po / n - this.pOut) * this.a;
      }
    } else if (this.pIn > 0) {
      // 原曲キー: キーを変えていたときの大きさに合わせる(急に変わらないよう、少しずつ)
      const want = Math.max(0.5, Math.min(1, Math.sqrt(this.pOut / this.pIn)));
      this.g += (want - this.g) * 0.05;
      for (let i = 0; i < n; i++) {
        out[0][i] *= this.g;
        oR[i] *= this.g;
      }
    }
    return true;
  }
}

registerProcessor('keyshift', KeyShiftProcessor);
