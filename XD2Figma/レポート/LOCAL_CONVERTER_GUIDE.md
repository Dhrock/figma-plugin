# XD2Figma Local Converter 利用手順

## 起動

Finderで`アプリケーション`を開き、`XD2Figma Converter.app`を起動する。

インストール先:

`/Applications/XD2Figma Converter.app`

## 変換

1. `XDを選択…`から変換元の`.xd`を選ぶ。
2. 必要なら`出力先`を変更する。初期値はこのプロジェクトの`output`。
3. `変換を開始`を押す。
4. 完了後、`Finderで表示`を押すと生成された`.xd2fig`を確認できる。

Adobe XDアプリは起動せず、`.xd`内部のmanifest v6・AGC・画像resourcesをローカルで直接解析する。ネットワーク送信は行わない。

## 出力

出力先の直下に`YYYYMMDD_XDファイル名_testNN`形式の新しいフォルダを作り、次を保存する。

- `semantic.json`: ノード、フォント、書式、位置、画像参照などの従来メタデータ
- `texts.json`: `{ guid, characters }`だけを持つ独立テキストデータ。フォント・サイズ・色・座標を含まない
- `coordinates.csv`: アートボード相対座標
- `assets/`: XDに格納された画像原本
- `export-complete.json`: 完了記録と生成パッケージのパス
- `XDファイル名.xd2fig`: Figma Importerへ渡す完成パッケージ

Figma Importerは新パッケージの`texts.json`を文字列の正本として読み、GUIDでTEXTノードへ割り当てる。フォントや文字サイズなどは従来どおり`document.json`・`fonts.json`・style rangesから適用する。

## Figmaへインポート

1. Figma DesktopでDevelopment pluginを再読み込みする。manifestは`dist/apps/figma-importer/manifest.json`。
2. `XD2Figma Importer`を起動する。
3. Local Converterが生成した`.xd2fig`を選択する。
4. Preflight後にインポートを開始する。

旧パッケージには`texts.json`がないため、互換処理で`document.json`内の文字列を使用する。独立テキストを利用するにはLocal Converterで作り直したパッケージを使用する。

## 実データ検証（2026-07-21）

変換元: `染松2025.xd`

出力: `output/20260721_染松2025_test01`

- アートボード: 10
- 全ノード: 2,988
- テキスト: 933
- 合計文字数: 16,530
- 空のテキスト: 0
- `texts.json`の重複GUID: 0
- `texts.json`とpackage内TEXTノードの不一致: 0
- 画像アセット: 23
- 座標行: 2,988（CSVヘッダーを含めたファイル行数は2,989）
- テスト: 26 pass / 0 fail

## 制約

- 現在の直接解析エンジンはXD `manifest-format-version: 6`を対象とする。別バージョンは誤変換せずエラーで停止する。
- アプリは内蔵の変換JavaScriptをNode.jsで実行する。この端末では`/usr/local/bin/node`を検出済み。
- XD公開Scenegraph APIではなくXDファイル内AGCを解析するため、Adobeによる内部形式変更があった場合は解析アダプターの更新が必要になる。
