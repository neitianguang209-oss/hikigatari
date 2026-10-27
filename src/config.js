// Supabase Edge Function(コード譜の取り込み・同期・端末の鍵)
export const FN_URL = 'https://gzayrjlhruhvklsidraw.supabase.co/functions/v1/hikigatari';
// 原曲の YouTube の動画を探す(曲と合わせる)
export const YT_FN_URL = 'https://gzayrjlhruhvklsidraw.supabase.co/functions/v1/hikigatari-yt';
// 自分の音源ファイルを端末どうしで共有する(非公開の置き場への、期限つきの URL をもらう)
export const AUDIO_FN_URL = 'https://gzayrjlhruhvklsidraw.supabase.co/functions/v1/hikigatari-audio';
export const APP_VERSION = '1.23.0';
