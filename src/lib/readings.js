// 英語表記のアーティストを、カタカナ(ひらがな)でも探せるようにする読みの一覧。
// 1行 = [英語の表記, 読み, 読み…]。新しい人を足すときはここに1行書く
const LIST = [
  ['Justin Bieber', 'ジャスティンビーバー', 'ジャスティン', 'ビーバー'],
  ['Dan + Shay', 'ダンアンドシェイ', 'ダンシェイ'],
  ['Ed Sheeran', 'エドシーラン'],
  ['Taylor Swift', 'テイラースウィフト', 'テイラー'],
  ['Bruno Mars', 'ブルーノマーズ'],
  ['Ariana Grande', 'アリアナグランデ', 'アリアナ'],
  ['Billie Eilish', 'ビリーアイリッシュ'],
  ['Olivia Rodrigo', 'オリヴィアロドリゴ', 'オリビアロドリゴ'],
  ['Charlie Puth', 'チャーリープース'],
  ['Shawn Mendes', 'ショーンメンデス'],
  ['Harry Styles', 'ハリースタイルズ'],
  ['One Direction', 'ワンダイレクション'],
  ['Sam Smith', 'サムスミス'],
  ['Adele', 'アデル'],
  ['Lady Gaga', 'レディーガガ'],
  ['Katy Perry', 'ケイティペリー'],
  ['Avril Lavigne', 'アヴリルラヴィーン', 'アブリルラビーン'],
  ['Beyonce', 'ビヨンセ'],
  ['Rihanna', 'リアーナ'],
  ['Michael Jackson', 'マイケルジャクソン'],
  ['The Beatles', 'ビートルズ', 'ザビートルズ'],
  ['Queen', 'クイーン'],
  ['Oasis', 'オアシス'],
  ['Coldplay', 'コールドプレイ'],
  ['Maroon 5', 'マルーンファイブ', 'マルーン5'],
  ['Carpenters', 'カーペンターズ'],
  ['Eric Clapton', 'エリッククラプトン'],
  ['John Mayer', 'ジョンメイヤー'],
  ['Jason Mraz', 'ジェイソンムラーズ'],
  ['James Blunt', 'ジェイムスブラント', 'ジェームスブラント'],
  ['Stevie Wonder', 'スティーヴィーワンダー', 'スティービーワンダー'],
  ['John Lennon', 'ジョンレノン'],
  ['Bob Dylan', 'ボブディラン'],
  ['Norah Jones', 'ノラジョーンズ'],
  ['Post Malone', 'ポストマローン'],
  ['The Weeknd', 'ウィークエンド', 'ザウィークエンド'],
  ['Dua Lipa', 'デュアリパ'],
  ['Green Day', 'グリーンデイ'],
  ['Radiohead', 'レディオヘッド'],
  ['Nirvana', 'ニルヴァーナ', 'ニルバーナ'],
  ['Official髭男dism', 'オフィシャルヒゲダンディズム', 'ヒゲダン'],
  ['back number', 'バックナンバー'],
  ['BUMP OF CHICKEN', 'バンプオブチキン', 'バンプ'],
  ['RADWIMPS', 'ラッドウィンプス'],
  ['ONE OK ROCK', 'ワンオクロック', 'ワンオク'],
  ['Mr.Children', 'ミスターチルドレン', 'ミスチル'],
  ['Mrs. GREEN APPLE', 'ミセスグリーンアップル', 'ミセス'],
  ['Vaundy', 'バウンディ'],
  ['Saucy Dog', 'サウシードッグ'],
  ['YOASOBI', 'ヨアソビ'],
  ['Crystal Kay', 'クリスタルケイ'],
  ['Ayumu Imazu', 'アユムイマヅ', 'アユムイマズ'],
  ['Tani Yuuki', 'タニユウキ'],
  ['GLIM SPANKY', 'グリムスパンキー'],
  ['Little Glee Monster', 'リトルグリーモンスター', 'リトグリ'],
  ['Laughing Hick', 'ラフィングヒック'],
  ['SIX LOUNGE', 'シックスラウンジ'],
  ['SOPHIA', 'ソフィア'],
  ['TOMOO', 'トモオ'],
  ['FOMARE', 'フォマレ'],
  ['MONGOL800', 'モンゴルハッピャク', 'モンパチ'],
];

// ひらがな→カタカナ、空白・中黒・長音のゆれを落とす
const loose = (s) =>
  String(s || '')
    .normalize('NFKC')
    .replace(/[ぁ-ゖ]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0x60))
    .replace(/[\s・=+&\-ー]/g, '')
    .toLowerCase();

const TABLE = LIST.map(([en, ...yomi]) => ({ en, yomi: yomi.map(loose) }));

// 打った言葉(1語)が読みに当たる英語の表記。読みの頭から3文字以上、途中からは4文字以上で当たり
export function englishNamesFor(word) {
  const w = loose(word);
  if (w.length < 3 || !/[ァ-ヶ]/.test(w)) return [];
  return TABLE.filter((r) => r.yomi.some((y) => y.startsWith(w) || (w.length >= 4 && y.includes(w)))).map((r) => r.en);
}

// ネット検索に出す言葉: 読みがまるごと入っていれば英語の表記に置きかえる(例:「ジャスティン・ビーバー baby」→「Justin Bieber baby」)
export function toEnglishQuery(q) {
  const parts = String(q || '').trim().split(/[\s　]+/).filter(Boolean);
  const out = [];
  let hit = false;
  // 空白で分けて打った名前もつなげて照らす(長いほうから)
  for (let i = 0; i < parts.length; ) {
    let found = null;
    for (let j = parts.length; j > i && !found; j--) {
      const w = loose(parts.slice(i, j).join(''));
      const row = TABLE.find((r) => r.yomi.includes(w));
      if (row) found = { en: row.en, j };
    }
    if (found) {
      out.push(found.en);
      i = found.j;
      hit = true;
    } else out.push(parts[i++]);
  }
  return hit ? out.join(' ') : null;
}
