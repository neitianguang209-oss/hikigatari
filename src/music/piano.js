// ピアノ: 右手の和音(基本形と転回形)と左手のベース音、五線譜に書くための音名
import { parseChord, chordIntervals } from './chord.js';

const mod12 = (n) => ((n % 12) + 12) % 12;

const LETTERS = ['C', 'D', 'E', 'F', 'G', 'A', 'B'];
const NATURAL = [0, 2, 4, 5, 7, 9, 11];
const DEGREE = { R: 1, '2': 2, m3: 3, '3': 3, '4': 4, '5': 5, '♭5': 5, '♯5': 5, '6': 6, '♭7': 7, M7: 7, '°7': 7, '♭9': 9, '9': 9, '♯9': 9, '11': 11, '♯11': 11, '♭13': 13, '13': 13 };

// 五線譜用: 和音の各音を「何度の音か」から正しく書き分ける(A・C♯・E など)。
// step は C0 からの白鍵の段数(E4 = 30 が第1線)、acc は ♯(+1) ♭(-1)。
export function staffNotes(name) {
  const ch = parseChord(name);
  if (!ch || ch.special || ch.bassOnly) return null;
  const rootLetter = LETTERS.indexOf(ch.rootName[0]);
  const rootAcc = ch.rootName[1] === '#' ? 1 : ch.rootName[1] === 'b' ? -1 : 0;
  // 根音を D4〜C♯5 あたりに置くと、和音が五線の中に収まりやすい
  let oct = 4;
  let rootMidi = 12 * (oct + 1) + NATURAL[rootLetter] + rootAcc;
  while (rootMidi < 62) (oct++, (rootMidi += 12));
  while (rootMidi > 73) (oct--, (rootMidi -= 12));
  let ivs = chordIntervals(ch);
  if (ivs.length > 4) ivs = ivs.filter((x) => x.label !== '5');
  return ivs.map((iv) => {
    const idx = rootLetter + (DEGREE[iv.label] || 1) - 1;
    const midi = rootMidi + iv.semi;
    let step = (oct + Math.floor(idx / 7)) * 7 + (idx % 7);
    let acc = midi - naturalMidi(step);
    // ♭♭ や C♭・F♭・E♯・B♯ は読みにくいので、となりの音名に書き換える(F dim7 の C♭ → B など)
    const L = step % 7;
    if (acc <= -2 || (acc === -1 && (L === 0 || L === 3))) (step -= 1), (acc = midi - naturalMidi(step));
    else if (acc >= 2 || (acc === 1 && (L === 2 || L === 6))) (step += 1), (acc = midi - naturalMidi(step));
    return { step, acc, midi };
  });
}

const SOLF = { C: 'ド', D: 'レ', E: 'ミ', F: 'ファ', G: 'ソ', A: 'ラ', B: 'シ' };
const ACC_TXT = { 1: '♯', '-1': '♭', 0: '' };

// 五線譜と同じ書き分けで、鍵盤の音名も出す(ソ♯ と ラ♭ を取り違えない)。無ければ null
export function spelledNamer(name, noteStyle) {
  const notes = staffNotes(name);
  if (!notes) return null;
  const byPc = new Map(notes.map((n) => [mod12(n.midi), n]));
  return (midi) => {
    const n = byPc.get(mod12(midi));
    if (!n) return null;
    const letter = LETTERS[((n.step % 7) + 7) % 7];
    return (noteStyle === 'letter' ? letter : SOLF[letter]) + (ACC_TXT[n.acc] ?? '');
  };
}

function naturalMidi(step) {
  return 12 * (Math.floor(step / 7) + 1) + NATURAL[((step % 7) + 7) % 7];
}

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
