// ピアノ: 右手の和音(基本形と転回形)と左手のベース音
import { parseChord, chordIntervals } from './chord.js';

const mod12 = (n) => ((n % 12) + 12) % 12;

// inversion: 0=基本形, 1=第1転回形, 2=第2転回形 …
export function pianoVoicing(name, inversion = 0) {
  const ch = parseChord(name);
  if (!ch || ch.special) return null;
  const ivs = chordIntervals(ch);
  const bassPc = ch.bass != null ? ch.bass : ch.root;
  // 左手: C3(48)〜B3(59) の範囲のベース音
  const left = 48 + mod12(bassPc);
  if (ch.bassOnly) return { left, right: [], labels: [], inversions: 1 };
  // 右手: ルートを F#3〜F4 あたりに置いて上に積む
  let rootMidi = 60 + mod12(ch.root);
  if (rootMidi > 65) rootMidi -= 12;
  let notes = ivs.map((x) => ({ midi: rootMidi + x.semi, label: x.label }));
  // テンションが多いときは5度を省く(4音まで)
  if (notes.length > 4) notes = notes.filter((n) => n.label !== '5');
  const count = notes.length;
  const inv = ((inversion % count) + count) % count;
  for (let i = 0; i < inv; i++) {
    const n = notes.shift();
    notes.push({ ...n, midi: n.midi + 12 });
  }
  // 転回して高くなりすぎたら全体を1オクターブ下げる
  while (notes[0].midi > 64 && notes[0].midi - 12 > left) notes = notes.map((n) => ({ ...n, midi: n.midi - 12 }));
  return { left, right: notes.map((n) => n.midi), labels: notes.map((n) => n.label), inversions: count };
}
