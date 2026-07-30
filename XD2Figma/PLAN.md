# XD → Figma 高再現性・損失検知型移植システム

更新日: 2026-07-21  
実装版: 0.1.0（XD実機Exporter検証済み。Figma全件インポートモード）

## 1. 方針

変換不能な情報を黙って捨てない。ZIP破損、schema不一致、fingerprint不一致、payload hash不一致、サイズ上限超過はpackage fatalとして全体停止する。フォント・画像・未対応表現など、パッケージの安全性を損なわない互換性問題はwarningとしてGUID付きで集約し、アートボードを除外せずベストエフォートで全件生成する。代替表現、元データ、対象、操作、package identityを監査記録へ残す。

フォントファイルはパッケージへ含めない。有料・商用フォントという理由では停止しない。Figma Desktopでsource family/styleをロードできない場合は、weight/italicが最も近いNoto Sansへ置換する。Noto Sansが無い環境だけは利用可能なフォントを最終代替とし、それも不可能なら元テキスト情報を保持したFrameを生成する。vendor、license、version、file hash、source/resolved fontを監査記録として保持する。将来フォント本体を同梱するv2を設計する場合だけ、ライセンス判定をブロック条件へ戻す。

## 2. 構成とデータ優先順位

```text
Adobe XD UXP Exporter
  ├─ semantic.json（公開Scenegraph APIを正とする）
  ├─ coordinates.csv（アートボード相対座標）
  └─ export-complete.json（完了マーカー）
             │
             ▼
Local Package CLI
  ├─ .xd ZIP / assets-dir（画像原本バイトだけを補完）
  ├─ path normalization / SHA-256 / ICC・EXIF抽出
  └─ output.xd2fig（stored ZIP）
             │
             ▼
Figma Desktop Importer
  ├─ package/font/artboard preflight
  ├─ UI→sandbox 4MiB chunk transfer
  ├─ staging pages + node-level fallback
  └─ referenceなしで自動commit（旧packageのみ任意visual report）
```

型、プロパティ解釈、座標、サイズはXD公開API出力を正とする。各ノードの`globalBounds`からアートボード原点を引いた座標を`coordinates.csv`へ記録し、Local Package CLIが親ノードのアートボード相対座標を引いてFigmaの親Frame相対座標へ変換する。これにより、XDの論理GroupをFigma Frameへ変換したときの親座標の二重加算を防ぐ。`.xd`直接読取は画像原本など公開APIが返さない生データだけを正とする。重複値が許容差を超える場合、または画像候補が曖昧な場合は`SOURCE_MISMATCH`で停止する。内部`.xd`形式依存は将来のversion別adapterへ隔離する。

出力はプロジェクトの`output`直下に`YYYYMMDD_XDファイル名_testNN`の専用フォルダを作成して集約する。`NN`は同日・同XDファイル名の既存最大値に1を加える。Package CLIは`--out`省略時に`semantic.json`と同じフォルダへ`.xd2fig`を作成し、`output`直下へファイルを散在させない。

## 3. 中間パッケージ

必須entryは`manifest.json`、`document.json`、`coordinates.csv`、`fonts.json`、`assets/index.json`、`preflight.json`。任意entryは`assets/<sha256>.<ext>`。manifestは全payloadのSHA-256とbyte lengthを持ち、manifest自体のSHA-256をpackage identityとして承認記録へ結び付ける。`coordinates.csv`はJSONより小さく、GUID、親GUID、アートボードGUID、z-order、アートボード相対X/Yの6列に限定する。

ZIPは絶対パス、drive path、backslash、`.`／`..`segment、空segment、重複entryを拒否する。v1上限はarchive 1.5GiB、展開後2GiB、ユニーク画像1GiB、500 artboards、100,000 nodes、5,000 unique assets。UIは展開前にcentral directoryとmanifest宣言を照合する。

SVG pathはCLIで絶対`M/L/Q/C/Z`へ正規化する。`H/V→L`、`S→C`、`T→Q`、`A→Cubic Bézier`とし、最大偏差0.01pxを目標に分割する。正規化前文字列を`sourcePathData`、正規化後を`pathData`として両方保持し、windingは`EVENODD`／`NONZERO`を維持する。

画像は原本SHA-256、MIME、寸法、original filename、usage GUID、transform、ICC、EXIFを記録する。PNG `iCCP/eXIf`とJPEG `APP1 Exif/APP2 ICC`は生payloadをbase64とSHA-256で監査記録化する。Figmaでは`createImage()`直後に`getBytesAsync()`を行い、入力バイトと完全一致しない場合は停止する。4096px超はUIで縦横比を維持して自動縮小し、元SHA-256、変換後SHA-256、変換パラメーターをshared plugin dataへ残す。

## 4. 検証とトランザクション

GUID対応、node count、親子関係、z-order、文字列、座標・寸法・角度（0.01px／0.01度）、opacity、色（1/255）をアートボード単位で検査する。不一致はアートボード削除のハードゲートにせず、部分生成したFrameを保持してfallback codeと元source nodeをreport/shared plugin dataへ記録する。

reference画像はノード生成、座標変換、フォント解決、画像原本の取り込みのいずれにも使用しないため生成しない。これによりXDの`createRenditions`負荷、クラッシュ面積、パッケージ容量を減らす。必須ではないためJPGへの置き換えも行わない。旧packageにreferenceが含まれる場合だけ、互換性のため任意の視覚差分機能を残す。

作成先は`__XD_IMPORT_STAGING__`接頭辞の新規ページだけとし、既存ページは変更しない。build例外・cancel時はstagingを削除する。強制終了で残ったstagingは次回起動時に検出し、ユーザー確認後に削除する。同一source fingerprintの結果ページが現存する場合も、既存ページを維持したまま別ページへ再importできる。`documentAccess: dynamic-page`に対応し、ページ探索はasync load後に行う。

shared plugin dataは1entry 100kB制限を超えないよう20,000 UTF-16 code unitで分割し、fonts、assets、issues、approvals、visual reviewsを保存する。

## 5. 対応方針

| XD情報 | v0.1処理 |
|---|---|
| Artboard / Rectangle / Ellipse / Line / Polygon / Path / Text | semantic nodeとして生成し構造検証 |
| Group / ScrollableGroup | Frameへ変換しsource typeを記録 |
| SymbolInstance | active stateを通常Frame化 + warning |
| RepeatGrid | 通常Frameへdetach + warning |
| 4096px超画像 | 自動downscale + 変換監査記録 |
| Stack個別間隔 | absolute Frame fallback + warning |
| Gradient / Mask / effects /特殊blend | source情報を保持した代替表現 + warning |
| Lottie / Video | 通常Frame + warning（静止画adapter未実装） |
| 公開APIにないinteraction / component state | 検出可能範囲をreport。実機ゲート対象 |

## 6. 実現性ゲート

次を満たすまでproduction readyとはしない。

1. XD 57.x実機で全Scenegraph class、styleRanges、画像assetId、3D propertyの取得可否をfixture化する。
2. 非表示component state、hover/state transition、音声以外のinteractionが公開APIに現れないことを確認し、`.xd` adapterで検出できなければ対応保証外として明示する。
3. `.xd`内部形式を複数versionで検証し、version detectorとadapter contractを固定する。
4. Figma Desktopでfont一意性、`createImage→getBytesAsync`、dynamic-page、shared plugin data復元を実測する。
5. 500 artboards、100,000 nodes、1GB assetsでメモリ・4MiB chunk・クラッシュ回復を負荷試験する。
6. 日本語・欧文混植、可変font、P3 ICC、EXIF orientation、巨大画像、arc pathを含むgolden fixtureで構造検証と視覚reviewを完走する。

Adobe XD 61.0.12.1で87 artboards／13,874 nodes／13,874 coordinate rowsのreferenceなしExporter完走を確認済みである。実データの13,787親付きノードについて、パッケージ内の親Frame相対座標とCSVから再計算した値の不一致は0件であった。v0.1の未実装表現はwarningと代替表現で可視化し、package fatal以外ではアートボードを除外しない。Figma実機での大規模全件インポートは引き続き実現性ゲート4〜6の検証対象とする。

## 7. 公式仕様参照

- Figma Plugin Manifest / dynamic-page / network / permissions: https://developers.figma.com/docs/plugins/manifest/
- Figma VectorPath data: https://developers.figma.com/docs/plugins/api/properties/VectorPath-data/
- Figma createImage: https://developers.figma.com/docs/plugins/api/properties/figma-createimage/
- Figma loadFontAsync: https://developers.figma.com/docs/plugins/api/properties/figma-loadfontasync/
- Figma setSharedPluginData: https://developers.figma.com/docs/plugins/api/properties/nodes-setsharedplugindata/
- Adobe XD Scenegraph: https://developer.adobe.com/xd/uxp/develop/reference/scenegraph
- Adobe XD SceneNode interaction constraints: https://developer.adobe.com/xd/uxp/develop/reference/scene-node
