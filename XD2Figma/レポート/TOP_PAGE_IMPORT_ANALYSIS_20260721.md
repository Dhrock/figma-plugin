# TOPページ インポート差分分析・修正レポート

## 対象

- Figma: `染松_テスト` / node `3:6` / `[PC] index (JP)`（1366 × 6183）
- Figma URL: https://www.figma.com/design/9jSKaqsoz8UnQ1c39WuApe/%E6%9F%93%E6%9D%BE_%E3%83%86%E3%82%B9%E3%83%88?node-id=3-6&m=dev
- XDエクスポート: `output/20260721_toka_test02/semantic.json`
- 座標: `output/20260721_toka_test02/coordinates.csv`
- 既存パッケージ: `output/20260721_toka_test02/xd-global-coordinate-verification-20260721/220802-xd-global-coordinate-fixed.xd2fig`
- XD見本画像: `output/20260716_test01/references/[PC] index (JP)-dc173f20-7cc1-4964-88c2-d6ae94954fdf.png`

分析範囲は依頼どおりTOPページだけとし、Figma上の他のアートボードは評価していない。

## 結論

TOPページの主要な不一致は、`.xd2fig`からデータが欠落したことではなく、XDとFigmaで異なるテキスト範囲・レイヤー順・マスクの意味をImporterが変換し切れていなかったことが原因だった。

| 項目 | XD側 | 旧Figmaインポート | 判定 |
| --- | ---: | ---: | --- |
| 全ノード | 2,062 | 2,062 | 欠落なし |
| テキスト | 152 | 152 | ノード欠落なし、書式適用に問題 |
| 画像利用ノード | 22 | 22 | 画像データ欠落なし、重なり順に問題 |
| 末尾書式が不足するテキスト | 91 | 91 | Importerの範囲解釈不備 |
| 書式未適用になった末尾文字 | 775 | 775 | Figma既定値へフォールバック |
| 非通常ブレンド | 4 | 未反映 | Importerのプロパティ未実装 |
| マスクグループ | 17 | Figmaマスク未設定 | XD/Figmaの並び順差を未変換 |

## 正しく再現できていなかった情報と原因

### 1. テキスト末尾が12 pxになる、または見えなくなる

XDの`styleRanges`は、最後のrangeが短くても、その後の文字に最後の書式が継続する仕様になっている。旧Importerは各rangeに記録された`length`の範囲だけをFigmaへ設定し、残りを未設定にしていた。Figmaでは未設定部分が作成直後の既定書式（主に12 px）を保持したため、見出し・日本語本文・グラフラベルなどが小さくなった。

例:

- `ABOUT`: 5文字に対してXD rangeは1文字分。旧Importerでは先頭だけ18 px、残り4文字が12 px。
- `tearoom toka`: 12文字に対してXD rangeは1文字分。残り11文字が12 px。
- 日本語本文の一例: 215文字に対してrange合計78文字。残り137文字が12 px・自動行高になった。

AREAテキストは元の固定高さも同時に復元していたため、12 pxへ変わった末尾が不自然に改行され、固定枠の外へはみ出した文字が非表示になった。これは文字列欠損ではなく、書式と高さ計算の組み合わせによる表示欠損である。

修正:

- XDの最後のstyle rangeを文字列末尾まで明示的に展開してから、Figmaの`setRange*` APIへ適用する。
- AREAテキストは正しい書式を適用した後に必要高さを測る。
- XDが明示的にクリップしていない旧パッケージでは、文字を隠すよりも枠を必要高さへ拡張する。元高さと拡張後高さはShared Plugin Dataへ保存する。
- 新しいXD Exporterは`clippedByArea`も出力し、意図的なクリップの場合だけ元の固定高さを維持する。

Adobe XDのText APIにあるstyle range継承規則に合わせた修正である:
https://developer.adobe.com/xd/uxp/develop/reference/text

### 2. 画像がグレーや単色に見える

画像バイトは22件すべてFigmaへ存在しており、missing assetは0件だった。代表例の先頭Instagram画像は、画像ノードの上に同寸の白背景と半透明黒レイヤーが作られていた。XDの背景レイヤー役割と`multiply`が未変換だったため、画像が白・グレーの矩形で覆われて見えていた。

修正:

- 新しいXD Exporterは`layout.padding.background`を`isBackground`として保存する。
- 既存パッケージにはこのメタ情報がないため、親と同寸・原点配置・不透明な白矩形を安全な条件で背景として推定し、Figmaでは他の内容より下へ移す。
- XDのブレンドモード表記をFigmaの列挙値へ正規化し、TOPにある4件を適用する。
- sourceにfill/strokeがないノードでは、Figmaが新規作成時に持つ既定のグレーfill/strokeを明示的に空にする。

XDの背景役割・content childrenの仕様:
https://developer.adobe.com/xd/uxp/develop/reference/scene-node

### 3. マスクとその内側の表示が崩れる

XDの子リストは下から上のz-orderで、mask shapeはグループの最上位に置かれる。一方Figmaは、mask nodeの後に続く兄弟をマスクする。この順序差を変換せず、さらに`isMask`を設定していなかった。

修正:

- 新しいXD Exporterは`maskGroup`と`isMask`を保存する。
- Figmaではmask nodeを先頭へ移し、`isMask = true`と`maskType = VECTOR`を設定する。
- 既存パッケージは`unsupported: ["MASK"]`とXDの最終子を用いて後方互換で復元する。

XDのz-order仕様:
https://developer.adobe.com/xd/uxp/develop/reference/SceneNodeList/

## 実装箇所

- `packages/core/src/text-ranges.ts`: XD style range継承を明示範囲へ変換
- `packages/core/src/blend-mode.ts`: XD/Figmaブレンドモードの正規化
- `packages/core/src/types.ts`: 背景・マスク・テキストクリップのIRメタ情報
- `apps/xd-exporter/src/code.ts`: 上記メタ情報のエクスポート
- `apps/figma-importer/src/code.ts`: テキスト、AREA高さ、背景、mask、blend、既定fill/strokeの復元
- `tools/xd-direct-cli.ts`: 直接解析で取得できる背景・mask・blend情報を保持
- `tests/core.test.mjs`: style range継承とblend正規化の回帰テスト

## 検証結果

`npm test`:

- 25 tests
- 25 pass
- 0 fail

実際のTOPページ`semantic.json`を使った変換前検証:

- TOPノード: 2,062
- テキスト: 152
- 全文字を書式範囲で覆えたテキスト: 152 / 152
- 未解決テキスト: 0
- AREAテキスト: 13
- 対応できた非通常blend: 4 / 4
- 旧形式から復元できるmask group: 17

## 再インポート

この修正は既に生成済みのFigmaノードを自動更新しない。Figma DesktopでDevelopment pluginを再読み込みし、次を選び直して新しいページへ再インポートする。

`output/20260721_toka_test02/xd-global-coordinate-verification-20260721/220802-xd-global-coordinate-fixed.xd2fig`

Importer側に後方互換処理を入れたため、今回の主要修正を確認するだけならXDからの再エクスポートは不要。`clippedByArea`・背景・maskの明示メタ情報まで新形式で保存する場合は、更新済みXD Exporterで再エクスポートしてパッケージを作り直す。
