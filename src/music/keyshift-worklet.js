// 流れている音のキーをその場で変える(AudioWorklet)。自分の音源を、好きなキー・速さで流すときに使う
// はじめのキーは processorOptions.semis、あとから port へ { semis } を送ると変わる(半音いくつぶん上げ下げするか。小数も可)
// { reset: 時刻 } を送ると、その時刻(音の時計)になったところで中に残っている音を捨てる(曲の別の場所へ飛ぶとき)
import { KeyShifter } from './keyshift.js';

class KeyShiftProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.ks = new KeyShifter(sampleRate);
    this.ks.setSemitones(options?.processorOptions?.semis || 0);
    this.spare = new Float32Array(128);
    this.resetAt = null;
    this.port.onmessage = (e) => {
      const d = e.data || {};
      if (typeof d.semis === 'number') this.ks.setSemitones(d.semis);
      if (typeof d.reset === 'number') this.resetAt = d.reset;
    };
  }

  process(inputs, outputs) {
    if (this.resetAt != null && currentTime >= this.resetAt) {
      this.resetAt = null;
      this.ks.reset();
    }
    const inp = inputs[0] || [];
    const out = outputs[0];
    if (!out?.[0]) return true;
    if (this.spare.length !== out[0].length) this.spare = new Float32Array(out[0].length);
    this.ks.process(inp[0] || null, inp[1] || null, out[0], out[1] || this.spare);
    return true;
  }
}

registerProcessor('keyshift', KeyShiftProcessor);
