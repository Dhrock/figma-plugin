# XD2Figma インポート修正レポート

## 1. 概要

本レポートは、`220802_冬夏.xd`をXD2Figma Converterで`.xd2fig`へ変換し、Figma DesktopのXD2Figma Importerでインポートした際に発生していた「複数ページの生成」と「テキスト表示の破損」に対する調査、修正、再検証の結果をまとめたものである。

- 報告日: 2026年7月22日
- 対象XD: `220802_冬夏.xd`
- 対象Figma: `染松_テスト`
- Figma URL: https://www.figma.com/design/9jSKaqsoz8UnQ1c39WuApe/%E6%9F%93%E6%9D%BE_%E3%83%86%E3%82%B9%E3%83%88
- 修正後パッケージ: `output/20260721_220802_冬夏_test02/220802_冬夏.xd2fig`
- 検証対象ページ: `XD Screens` / Figma page ID `11:43580`

依頼の4段階の作業は、各段階を担当するサブエージェントを1回ずつ実行した。

1. XD→`.xd2fig`変換とFigmaへのインポート
2. オリジナルXDとFigmaインポート結果の比較・破損箇所の分析
3. 原因コードの特定と修正
4. 修正後パッケージの再変換・再インポート・検証

## 2. 結論

テキスト文字列自体は、Converterが生成した`texts.json`および`.xd2fig`から欠落していなかった。破損して見える主因は、Figma Importer側の次の3点だった。

1. XDのPOINTテキストに明示的な幅があっても、Figmaで幅を自動再計算していた。
2. XDの文字列に含まれる単独のCR改行を、Figmaで安定表示できるLF改行へ変換していなかった。
3. 日本語フォントが見つからない場合に、日本語グリフに適した`Noto Sans JP`より先に汎用の`Noto Sans`を選択する可能性があった。

修正後は、全3,585テキストで、ソース文字列をCR→LFの1対1正規化した期待値とFigma上の`TextNode.characters`がすべて一致した。文字列の欠落、余分なテキスト、GUIDの重複も検出されていない。

Figmaに新規生成されるページも、従来の4ページから`XD Screens` 1ページのみに変更した。

## 3. 修正前の状態

### 3.1 ページ生成

修正前のImporterは1回のインポートで次の4ページを生成していた。

- `XD Screens — 220802_冬夏`
- `XD Components — 220802_冬夏`
- `XD Pasteboard — 220802_冬夏`
- `XD Import Report — 220802_冬夏`

デザインデータの利用に必要なアートボードは`XD Screens`にあるため、その他の情報も同一ページに集約できる。

### 3.2 テキスト文字列

修正前インポートのPC TOPとSP TOPをGUIDで照合した結果、テキストノード数と文字列は一致していた。

| 対象 | XD側 | Figma側 | 欠落・余分・重複 |
| --- | ---: | ---: | ---: |
| `[PC] index (JP)` | 151 | 151 | 0 |
| `[SP] index (JP)` | 54 | 54 | 0 |

したがって、主問題は文字データの抽出漏れではなく、Figmaでの改行、テキスト枠、フォント代替による表示位置の差だと判定した。

### 3.3 POINTテキストの幅

POINTテキストに`WIDTH_AND_HEIGHT`を一律で設定していたため、XDから取得済みの明示幅がFigma側で捨てられていた。

代表例:

- source GUID: `9ce83313-71b3-4df1-8cbf-81f6866c097b`
- XDの明示幅: 245 px
- 修正前のFigma幅: 88 px

文字列が存在していても幅が短縮されるため、レイアウトがXDと大きく異なって見える状態だった。

## 4. 実装した修正

### 4.1 `XD Screens`の1ページ化

`apps/figma-importer/src/import-page-policy.ts`のページ定義を次の1件だけにした。

```ts
export const IMPORT_PAGES = [{ name: 'XD Screens', role: 'screens' }] as const;
```

`apps/figma-importer/src/code.ts`では、ステージングページ、ロールバック、復帰処理を1ページ前提に変更した。インポートレポートと監査メタデータは別ページにせず、アートボード右側の同一`XD Screens`ページに保持する。

インポート途中でエラーになった場合は、確定前のステージングページのみを削除できるため、従来のトランザクション性も維持している。

### 4.2 POINTテキストの明示幅を保持

`apps/figma-importer/src/text-import-policy.ts`に、XDの明示幅の有無でFigmaの自動リサイズ方式を切り替えるポリシーを追加した。

| XDデータ | Figma設定 | 動作 |
| --- | --- | --- |
| 正の有限数の`text.width`あり | `textAutoResize = "HEIGHT"` | XD幅を固定し、高さだけ自動調整 |
| 明示幅なし | `textAutoResize = "WIDTH_AND_HEIGHT"` | 従来のPOINTテキスト動作を維持 |

元の幅はFigma Shared Plugin Dataの`sourceTextWidth`にも保存し、後から監査できるようにした。

### 4.3 XD改行の1対1正規化

`packages/core/src/text-display.ts`に`normalizeCharactersForFigma()`を追加し、XD文字列の各CRを1文字のLFへ変換した。

- 変換前: `\r`
- Figma表示用: `\n`
- UTF-16コードユニット数: 変更なし

変換前後の文字数が同じなため、XDのstyle rangeオフセットを変更せずにFigmaへ適用できる。また、原文字列は破棄せず、Shared Plugin Dataの`sourceCharacters.*`に分割保存した。正規化を行ったノードには`charactersNormalization = CR_TO_LF_1_TO_1`を付与している。

### 4.4 Converterのテキスト幾何フォールバック

`tools/xd-direct-cli.ts`で、XDがテキスト枠の幅・高さを持たない場合の推定方法を修正した。

- 幅は文字列全体の長さではなく、最長行の文字数から推定する。
- CRとLFをそれぞれ改行として数える。
- XDが明示幅・高さを持つ場合は、推定値よりXDの値を優先する。

### 4.5 日本語フォントの代替順序

`apps/figma-importer/src/font-resolution.ts`で、ソースフォントの完全一致を常に第1候補としたうえで、日本語系フォントの代替順序を次のとおり変更した。

1. `Noto Sans JP`
2. `Noto Sans CJK JP`
3. `Noto Sans`
4. Inter、その他の有効なフォント

ウェイトとItalicの差も評価し、要求styleに最も近いフェイスを選ぶ。英数字系フォントの代替は、引き続き汎用の`Noto Sans`を優先する。

実データで確認した代替:

- `Noto Sans CJK JP Light` → `Noto Sans JP Light`
- `YuGothic Medium` → `Noto Sans JP Medium`
- `Rotis Semi Sans Std 45 Light` → `Noto Sans Light`
- `Roboto Light` はFigmaで利用可能なため完全一致で維持

## 5. 修正後の実データ検証

### 5.1 Converter出力

| 項目 | 結果 |
| --- | ---: |
| アートボード | 87 |
| ノード | 13,348 |
| 画像アセット | 43 |
| テキスト | 3,585 |
| ソースフォントフェイス | 4 |
| reference画像 | 0 |
| パッケージサイズ | 42,490,800 bytes |
| パッケージSHA-256 | `22978514412e7efd784ff300304466ed5ccb750b56912e5db8c06d81703aa938` |

reference画像は生成されていない。座標・テキスト・画像アセットの移行にreference PNG/JPEGは必須ではないため、パッケージ容量を増やすreferenceの自動生成は行っていない。

### 5.2 Figmaインポート

| 検証項目 | 修正後の結果 |
| --- | ---: |
| 新規生成ページ | 1 |
| ページ名 | `XD Screens` |
| ページ直下の要素 | 88 |
| source GUID付きアートボード | 87 |
| 同一ページ内のインポートレポート | 1 |
| インポート完了 | 87 |
| 除外 | 0 |
| 失敗 | 0 |
| source GUID付きテキスト | 3,585 |
| テキストGUIDの重複 | 0 |
| テキストGUIDの欠落・余分 | 0 |
| CR→LF正規化後の文字列不一致 | 0 / 3,585 |

照合用ハッシュ:

- ローカル/Figmaテキストレコード: `ce1e2898c939b30387cbc26fabf456a78d38e013837f41b9668e4dd9ad4b2141`
- テキストGUID集合: `88d31462732188647d1145024bc13e92fb71f399e509de6f7e7aaa871afef156`

POINTテキストの代表例`9ce83313-71b3-4df1-8cbf-81f6866c097b`は、修正後に次の状態を確認した。

- Figma幅: 245 px
- `textAutoResize`: `HEIGHT`
- Shared Plugin Data `sourceTextWidth`: `245`

また、CRを含む代表ノードでは、Figma表示文字列がLFを含みCRを含まないこと、元文字列が`sourceCharacters.*`に保持されていること、`CR_TO_LF_1_TO_1`マーカーが付与されていることを確認した。

### 5.3 自動テスト

2026年7月22日に`npm test`を再実行した。ビルド、Figma/XDプラグインの生成、アセットコピーを含むテストはすべて成功した。

- tests: 31
- pass: 31
- fail: 0
- skipped: 0

今回の回帰テストには、少なくとも次を含む。

- インポートが`XD Screens` 1ページだけを作成すること
- POINTテキストが明示幅を保持し、高さだけ自動調整すること
- CRを1対1でLFへ変換し、元文字列を変更しないこと
- テキスト枠のフォールバックが最長行と改行数を使うこと
- 日本語ソースフォントが汎用Noto Sansより`Noto Sans JP/CJK JP`を優先すること
- 置換先フォントが要求weight/italicに近いstyleを選ぶこと

## 6. 警告と既知の制約

修正後インポートで文字列の欠落やアートボードの失敗はなかったが、XDとFigmaの機能差による次の警告は残っている。

| 警告/フォールバック | 数 | 意味 |
| --- | ---: | --- |
| `COMPONENTS_FLATTENED` | 80アートボード | XDコンポーネントの意味を、編集可能な通常レイヤーとして移行 |
| `CLIPPING_APPROXIMATED` | 87アートボード | XD/Figmaのクリッピング仕様差を近似 |
| `XD_DIRECT_ADAPTER_USED` | 1件 | XDファイルの直接解析アダプターを使用 |
| フォント代替 | 3件 | 利用できないソースフォントをNoto Sans系へ代替 |
| `TEXT_BOX_EXPANDED_TO_PRESERVE_CONTENT` | 368件 | 文字を隠さないためテキスト枠の高さを拡張 |

`TEXT_BOX_EXPANDED_TO_PRESERVE_CONTENT`はテキスト欠落ではない。フォント代替後の必要高さがXDの元枠より大きい場合に、文字の視認性を優先して高さを広げた記録である。そのため、代替フォントの文字幅・行高が元フォントと異なる箇所には、小さなレイアウト差が残る可能性がある。

Figmaファイルには修正前のインポートで作成された旧4ページが残っている。これは既存データを無断で削除しないためであり、修正後Importerが新たに4ページを作成したものではない。今後の新規インポートで作成されるのは`XD Screens`のみである。

## 7. 動作確認中のクラッシュと実行方法

今回のConverter変換およびFigmaインポートで、XD2Figma ConverterまたはFigmaのクラッシュは発生しなかった。

macOSのUI Accessibility経由でConverterのGUI状態を取得しようとした際は、30秒以内に応答を取得できなかった。これは変換処理のクラッシュではなく、検証環境のアクセシビリティ取得タイムアウトだった。そのため、同じインストール済みアプリのCLIエントリを使って変換を完了した。

```sh
/Applications/XD2Figma\ Converter.app/Contents/MacOS/XD2FigmaConverter \
  --convert "/Users/daisuke_hiramoto/Desktop/figma-plugin/XD2Figma/220802_冬夏.xd" \
  --output "/Users/daisuke_hiramoto/Desktop/figma-plugin/XD2Figma/output/20260721_220802_冬夏_test02"
```

したがって、今回確認できたのは「インストール済みアプリと同じ変換実装を使用したCLI変換」と「Figma Desktop上のプラグインインポート」である。Converter GUI上のファイル選択操作そのものは、今回の最終検証の合格項目には含めない。

## 8. 修正ファイル

- `apps/figma-importer/src/import-page-policy.ts`: 1ページ生成ポリシー
- `apps/figma-importer/src/code.ts`: 1ページのステージング、テキスト復元、監査メタデータ保持
- `apps/figma-importer/src/text-import-policy.ts`: POINTテキストのサイズポリシー
- `apps/figma-importer/src/font-resolution.ts`: 日本語フォントのNoto Sans代替順序
- `packages/core/src/text-display.ts`: CR→LF正規化とテキスト枠推定
- `packages/core/src/index.ts`: テキスト表示ヘルパーのexport
- `tools/xd-direct-cli.ts`: ConverterのPOINTテキスト幾何フォールバック
- `tests/core.test.mjs`: 改行と幾何推定の回帰テスト
- `tests/figma-import-policy.test.mjs`: 1ページ化、POINTテキスト、フォント代替の回帰テスト

## 9. 最終判定

今回の要件に対する判定は次のとおり。

| 要件 | 判定 | 根拠 |
| --- | --- | --- |
| Figmaに`XD Screens`だけを新規生成 | 適合 | 新規ページ1、ページ名`XD Screens` |
| XDのテキストの欠落を防止 | 適合 | 3,585件の文字列不一致0、GUID欠落・重複0 |
| 元のテキストを監査用に保持 | 適合 | `sourceCharacters.*`に元文字列を保存 |
| POINTテキストのXD幅を保持 | 適合 | 代表例で245 pxを再現 |
| 未発見フォントをNoto Sans系で表示 | 適合 | 代替先3フェイスのFigmaロード成功 |
| 日本語に適したNoto Sansを優先 | 適合 | `Noto Sans JP`が日本語範囲に適用 |
| 修正後の自動テスト | 適合 | 31 / 31 pass |
| 実データインポートの完了 | 適合 | 87完了、0除外、0失敗 |

以上により、ページ生成数とテキストデータ欠落に関する今回の修正は完了と判定する。一方、元フォントとNoto Sans系のメトリクス差、XD/Figma間のコンポーネントおよびクリッピング仕様差は、完全な視覚一致に向けた継続課題である。
