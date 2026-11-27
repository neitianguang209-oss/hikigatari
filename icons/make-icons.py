# アプリのアイコンを作る(ギターを弾くかえる)。元の絵は source-kaeru.png(白いカード+黒いふちのスクショ)。
# 黒いふちと白い背景を、読書記録のアイコンと同じベージュに塗り替える。
# 使い方: C:\ProgramData\anaconda3\python.exe -I icons\make-icons.py
import os
import numpy as np
from PIL import Image
from scipy import ndimage

HERE = os.path.dirname(os.path.abspath(__file__))
BEIGE = np.array([0xF5, 0xF1, 0xE4], float)

src = np.array(Image.open(os.path.join(HERE, 'source-kaeru.png')).convert('RGB'), float)
light = src.min(axis=2) > 232
labels, _ = ndimage.label(light)
card = labels == labels[100, 100]                    # 白いカードの地
inner = ndimage.binary_erosion(ndimage.binary_fill_holes(card), iterations=6)
outside = ~inner                                     # 黒いふちと、カードの角のにじみ
bg = card | outside                                  # 目やもようの白は地とつながらないので残る

# 輪郭の薄い白にじみは、白の混ざり具合に合わせてベージュへ寄せる
ring = ndimage.binary_dilation(card, iterations=2) & ~bg
w = np.clip((src.min(axis=2) - 150) / 90, 0, 1) * ring
out = src + w[..., None] * (BEIGE - 255)
out[bg] = BEIGE
art = Image.fromarray(np.clip(out + 0.5, 0, 255).astype(np.uint8))

# 絵のある範囲(薄いノイズは数えない)
fg = ndimage.binary_opening(~bg & (np.abs(out - BEIGE).max(axis=2) > 24))
ys, xs = np.where(fg)
box = (xs.min() - 2, ys.min() - 2, xs.max() + 3, ys.max() + 3)
crop = art.crop(box)
cw, ch = crop.size


def icon(size, side, name):
    side = int(round(side))
    canvas = Image.new('RGB', (side, side), tuple(int(v) for v in BEIGE))
    canvas.paste(crop, ((side - cw) // 2, (side - ch) // 2))
    canvas.resize((size, size), Image.LANCZOS).save(os.path.join(HERE, name), optimize=True)


# 丸く切られても欠けないように、絵のいちばん遠い点を半径40%の中に入れる
yy, xx = np.where(fg)
far = np.hypot(xx - (box[0] + box[2]) / 2, yy - (box[1] + box[3]) / 2).max()

normal = max(cw, ch) / 0.84
icon(512, normal, 'icon-512.png')
icon(192, normal, 'icon-192.png')
icon(180, normal, 'icon-180.png')
icon(32, max(cw, ch) / 0.96, 'favicon-32.png')
icon(512, far / 0.40, 'icon-maskable-512.png')
print('ok', box, far)
