ものぐさな私には、天下一キーボードわいわい会で設置するDisplay Cardを用意するのがお苦しみでした。

でも手書きじゃないものがいいし、統一感のあるものが手軽に用意できたらいいなと思ったgeneratorです。

レイアウトがズレたり不具合もあるかと思いますが、私が気にならない範囲で修正しています。

https://razilyis.github.io/DisplayCard-Generator/

2026年2月8日開催の天下一キーボードわいわい会 Vol.10に向けて作成し、2026年10月3日開催の Vol.12 に向けてマルチサイズ対応・新テーマ拡張（全22種類）を行いました。

## テーマ（25種類）

| ファイル | テーマ | 特徴 |
| --- | --- | --- |
| `light.html` | Swiss Style | 白ベースのミニマル |
| `dark.html` | Industrial | 黒×ネオンのサイバー系 |
| `mac_code.html` | Developer | macOSエディタ風 |
| `blueprint.html` | Blueprint | 青焼き設計図 |
| `sketch.html` | Product Sketch | 線画・レンダ画像を配置（画像対応） |
| `dq_pixel.html` | RPG Pixel | ボウケンノショ風（画像対応） |
| `neobrutal.html` | Neo-Brutalism | 極太の黒枠と原色ブロック |
| `washi.html` | 和風ラベル | 縦書きの銘と朱印、和紙の質感 |
| `boarding.html` | Boarding Pass | 航空券風。ミシン目・半券・バーコード |
| `tcg.html` | Trading Card | カードゲーム風。箔押しフチとステータス欄（画像対応） |
| `crt.html` | CRT Terminal | 蛍光管の緑と走査線 |
| `cassette.html` | Cassette Tape | 80sのカセットラベル風 |
| `datasheet.html` | Datasheet | ICの仕様書風 |
| `oshinagaki.html` | お品書き | 即売会向け。頒布物と価格、スペース番号 |
| `ekimeisho.html` | 駅名標 | JR風サインボード |
| `cartridge.html` | Cartridge | レトロゲームカセット風ラベル |
| `museum.html` | Museum | 美術館・博物館キャプション解説版 |
| `cyber_hud.html` | Cyber HUD | SF HUD・攻殻風ターゲット画面 |
| `keycap_box.html` | Keycap Box | 高級キーキャップ箱パッケージ |
| `space.html` | Space | 宇宙・星空・星雲グラデーション |
| `ocean.html` | Ocean | 海・深海・コバルト〜ターコイズ水光 |
| `sky.html` | Sky | 空・黄昏・サンセットグラデーション |
| `nordic.html` | Nordic | 北欧ナチュラル・スカンジナビアデザイン |
| `chicago.html` | Chicago | 90年代レトロ GUI・System 7 風ウィンドウ |
| `newyork.html` | New York | NYC 地下鉄サイン・路線アイコン |

## 印刷とサイズ選択について

すべてのテーマで、編集パネルの **「📐 印刷サイズ」** から用途に応じたサイズを自由に選択できます。

- **名刺サイズ (91 × 55mm)** - 展示卓の省スペースカード
- **写真 L判 (127 × 89mm)** - 写真立てやアクリルスタンド用
- **KGサイズ / はがき (152 × 102mm)** - L判より少し大きめのポストカードサイズ
- **写真 2L判 (178 × 127mm)** - 大きめのフォトフレーム用
- **A5サイズ (210 × 148mm)** - **A4の半分サイズ**（POPやスタンド看板向け）
- **A4サイズ (297 × 210mm)** - 全面POP・ポスター用

書き出されるPNGには実寸物理解像度（`pHYs` チャンク）が自動で付与されるため、Word / Illustrator / プレビュー.app などに貼り付けるだけで、**拡大縮小せず選択した実寸ミリメートルで正確に配置・印刷** されます。

## 長い名前への対応

スイッチ名やキーキャップ名は `Gateron Pro Yellow 2.0 (lubed, 67g)` のように
長くなりがちなので、枠に入りきらない項目は自動で調整されます。

- 見出し（ブランド名・駅名など）は **1行を保ったまま縮小**し、
  それでも入らないときだけ2行に折り返します
- スイッチ名などの狭い欄は **2〜3行に折り返してから縮小**します
  （1行のまま縮め続けると印刷で読めない大きさになるため）

40文字程度までは全テーマで枠内に収まることを確認しています。

## 使い方

1. `index.html` を開いてテーマを選ぶ
2. 右側のパネルで文字・色・画像を編集する
3. 「高画質PNGで保存」で書き出す
4. 「JSONで保存」しておくと、次回そのまま復元できます（画像も含めて保存されます）

## 構成

```
index.html          ポータル（テーマ選択）
*.html              テーマごとのジェネレータ
assets/cardkit.js   共通エンジン（入力同期 / JSON / 配色 / PNG書き出し）
assets/cardkit.css  共通スタイル（カード寸法・編集UI）
```

テーマを追加する場合は、既存のHTMLをコピーしてカード部分のマークアップとCSSを差し替え、
末尾の `CardKit({ ... })` に項目を宣言すれば動きます。
