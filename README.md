# ひきがたり

好きな曲のコード譜を、広告なしで見ながら弾き語りするための自分専用アプリ（PWA）。

- 曲名・アーティスト名で **U-FRET / ChordWiki / 歌ネット** をまとめて検索し、開いた曲だけを1曲ずつ取り込んで表示する
- **ギター**: 原曲の響きのまま、いちばん押さえやすいカポ位置を自動で選ぶ。「かんたんコード」で押さえにくい形を置き換え、押さえ方の図を歌詞の上に出す
- **ピアノ**: 原曲キーのまま表示し、コードをタップすると鍵盤図（右手の和音・左手のベース音）が出る
- **キー変更**（声に合わせる）、**BPMどおりの自動スクロール**（カウントイン・クリック音・タップテンポ・フットペダル対応）
  - 小節線の無い譜面は、行ごとの長さを「コードの数と歌詞の音数」から見積もる（ChordWiki の小節線つき譜面 10曲・333行で当てはめた式。`src/ui/autoscroll.js` の `estimateBars`）
  - 曲の長さ（Apple Music の再生時間）が分かる曲は、譜面がちょうど曲の長さで終わるよう進む速さを補正する（クリック音は元のBPMのまま）
- 1行は折り返さずに1行で見せる（はみ出す行だけ少し縮める。コードだけの長い行は段の数をそろえて折る）
- 検索は曲名・アーティスト名をまとめて入れても、ひらがな・カタカナでもOK。同じ曲名の曲は歌ネットの人気順で並ぶ
- **お気に入り**・最近ひらいた曲・曲ごとの設定（カポ/キー/テンポ/楽器）を、iPhone・iPad・PCで同期
- **Apple Music** で聴いている曲を、iPhoneの「ショートカット」からワンタップで開ける
- 自分で入力・貼り付けした譜面も使える（`[C]歌詞` 形式でも、コード行＋歌詞行の形式でもOK）
- オフラインでも保存済みの曲は開ける

公開先: https://neitianguang209-oss.github.io/hikigatari/

## iPhone・iPadでの使い方

1. 公開URLを **Safari** で開く → 共有ボタン → **ホーム画面に追加**
2. 最初の端末で「はじめる」を押す（この端末が自分専用の鍵になる）
3. ほかの端末は、使っている端末の **設定 → ほかの端末を追加** に出る6桁の数字でつなぐ
4. Apple Music との連携はアプリ内の **設定 → Apple Music** の手順どおり（ショートカットは Safari で開くので、Safari でも一度つないでおく）

## 構成

| 場所 | 中身 |
|---|---|
| `index.html` / `styles.css` | React 18 + htm（CDN・ビルドなし） |
| `src/music/` | コード解析・移調・キー判定（chord.js）、譜面の解析と貼り付け変換（sheet.js）、ギターの押さえ方探索・難しさ・カポ最適化・かんたんコード（guitar.js）、ピアノのボイシング（piano.js） |
| `src/ui/` | 画面（home / song / editor / settings / welcome / apple）と自動スクロール（autoscroll.js） |
| `src/lib/store.js` | 端末内の保存（IndexedDB）と同期。クラウドが空でも端末のデータは消さない |
| `supabase/functions/hikigatari/index.ts` | Edge Function。サイト検索・譜面取り込み・端末の鍵・同期 |
| `sw.js` | オフライン用。**更新して公開するたびに `CACHE_NAME` の番号を上げる** |

### Supabase（プロジェクト `gzayrjlhruhvklsidraw` に相乗り）

- テーブル: `hikigatari_songs`（曲とお気に入り・設定）、`hikigatari_devices`（端末の鍵のハッシュ）、`hikigatari_pair_codes`（6桁コード）、`hikigatari_sheet_cache`（取り込みキャッシュ）
- どれも RLS 有効・ポリシーなし＝公開キーでは読めない。Edge Function（service role）だけが読み書きする
- 変更があると `app_backups`（app=`hikigatari`）へ控えを送る。取り込んだ歌詞は控えに入れない（自分で入力した譜面だけ入れる）
- Edge Function の更新: Supabase の MCP / ダッシュボードから `hikigatari` を再デプロイ（`verify_jwt: false`、認証は関数内の端末キーで行う）

### 端末をすべて失くしたとき

設定 → バックアップ用キー を控えていれば、「すでに別の端末で使っている → バックアップ用キーで復元する」で戻せる。
キーも無いときは、SQLで `delete from hikigatari_devices;` を実行すると、次に開いた端末で「はじめる」からやり直せる（曲のデータは残る）。

## ローカルで動かす

```
powershell -ExecutionPolicy Bypass -File serve.ps1
```

http://localhost:5507/ を開く（localhost では Service Worker は登録しない）。

## 注意

譜面・歌詞の権利は各サイトと権利者にあります。このアプリは自分が見るためだけに1曲ずつ取り込む作りです。譜面を人に配ったり公開したりしないでください。
