# XD2Figma

Adobe XDの公開Scenegraph出力とローカル`.xd`アセットを、監査可能な`.xd2fig`パッケージを介してFigmaへ移植するローカル完結型ツール群です。通信・外部アップロード・テレメトリーは行いません。

## 構成

- `apps/xd-local-converter-macos`: XDを起動せず`.xd`を直接変換するmacOSアプリ
- `apps/xd-exporter`: Adobe XD UXP用の旧セマンティックエクスポーター
- `tools/package-cli.ts`: セマンティック出力と原本アセットから`.xd2fig`を作るローカルCLI
- `apps/figma-importer`: Figma Desktopで使うインポータープラグイン
- `packages/core`: IR、パス正規化、整合性・SHA-256検証
- `PLAN.md`: 改訂指示を反映した設計と実装・実現性ゲート

## 開発

```sh
npm install
npm test
npm run build:mac-app
```

`npm run package -- --help`でパッケージ作成CLIの使用方法を表示します。Figmaプラグインはビルド後、`dist/apps/figma-importer/manifest.json`をDevelopment pluginとして読み込みます。

## 移植手順

1. `/Applications/XD2Figma Converter.app`を起動して`.xd`を選択します。Adobe XDは起動しません。アプリは`YYYYMMDD_XDファイル名_testNN`フォルダを自動作成し、その中へ`semantic.json`、文字列だけを分離した`texts.json`、`coordinates.csv`、画像原本、完成した`.xd2fig`を出力します。詳しい操作は`LOCAL_CONVERTER_GUIDE.md`を参照してください。

旧方式が必要な場合はAdobe XDでExporterを実行できます。開発用manifestは`dist/apps/xd-exporter/manifest.json`です。

`NN`は同じ日付・XDファイル名の既存フォルダを確認して`01`から自動連番にします。`texts.json`はTEXTノードの`guid`と`characters`だけをUTF-8 JSONで保持し、フォント・サイズ・色・座標は含めません。従来のフォント・書式メタデータは`semantic.json`とpackage内の`document.json`・`fonts.json`へ保持します。`coordinates.csv`は`guid,parentGuid,artboardGuid,zOrder,artboardX,artboardY`の6列です。ノード生成に不要なreference画像は生成しません。`export-complete.json`がない出力は未完了データなので使用しないでください。
2. Local Converterでは画像結合とpackage作成も自動実行されるため、通常はコマンド操作不要です。CLIで再作成する場合は次を使用します。

```sh
npm run package -- \
  --semantic output/20260721_220802_冬夏_test01/semantic.json \
  --texts output/20260721_220802_冬夏_test01/texts.json \
  --source-xd /path/to/source.xd
```

`--coordinates`は省略でき、その場合は`semantic.json`と同じフォルダの`coordinates.csv`を自動使用します。`--out`も省略でき、パッケージは`semantic.json`と同じ命名済みフォルダに作成されます。CLIはアートボード相対座標をFigmaの親Frame相対座標へ変換し、GUID・親GUID・アートボードGUID・z-orderが`semantic.json`と一致しない場合は停止します。`.xd`から画像を解決できない場合は、`--assets /path/to/assets`を併用できます。公開APIのセマンティクスを正とし、`.xd`側は公開APIが返さない原本バイトだけに利用します。曖昧な同名画像は誤結合せず`SOURCE_MISMATCH`で停止します。

直接解析CLIは`--out-dir output`を指定すると、同じ命名規則の新規フォルダを自動作成します。

3. Figma DesktopでImporterを開き、`.xd2fig`を選択します。新パッケージでは`texts.json`を文字列の正本としてTEXTノードへ割り当て、フォント・書式は既存メタデータから適用します。スキーマ不一致やパッケージ改ざんなどのpackage fatalだけを停止条件とし、未対応機能・フォント・表現差は警告として集約記録しながら全アートボードを移植します。
4. referenceを含まない新パッケージは、構造生成後に視覚差分ステップを自動スキップして確定します。旧パッケージにreferenceがある場合だけ、互換性のため任意の視覚差分を表示します。

## Figma全件インポートポリシー

- Figmaでsource family/styleをロードできる場合は元フォントを維持します。
- source fontをロードできない場合は、weight/italicが最も近い`Noto Sans`（`Noto Sans JP`などの地域familyを含む）へ自動置換します。
- Noto Sans自体がFigma環境にない場合だけ、テキストを欠落させないため`Inter`または利用可能なローカルフォントを最終代替にします。いずれのフォントもロードできなければ、元テキスト情報をShared Plugin Dataへ保持したFrameを生成します。
- blocker/approvableだった互換性問題はwarningへ変更し、同じcodeをノードGUID・アートボードGUID付きで集約します。アートボード除外は0件です。
- 未対応ノード、パス欠損、LinkedGraphicなどは通常Frameへ変換し、元のsource node JSONとfallback codeをShared Plugin Dataへ保存します。
- 4096pxを超える画像は縦横比を維持して自動縮小し、元SHA-256、変換後SHA-256、縮小寸法を監査記録へ残します。

## 保全される監査情報

- source GUID、親子関係、z-order、source fingerprint
- アートボード相対座標とFigma親Frame相対座標への変換結果
- family/style単位のフォント監査記録。フォント本体は転送しません
- 画像原本SHA-256、PNG/JPEG内の生ICC/EXIF、利用ノード、変換記録
- 4096px超画像の元SHA-256、縮小寸法・比率・出力形式
- blocker、approvable action、承認者、日時、視覚差分結果

フォントはFigma Desktopの`listAvailableFontsAsync()`と`loadFontAsync()`で解決し、見つからないsource fontはNoto Sansへ置換します。source family/style、解決後family/style、置換理由、対象ノードを監査情報へ保存します。有料かどうかは警告・監査情報に留め、ライセンス種別だけを理由に停止しません。

## テキスト・背景・maskの再現

- XDの最後の`styleRange`が末尾まで継続する仕様をFigmaの明示的なrangeへ展開し、未設定文字が12 pxへ戻ることを防ぎます。
- AREAテキストは正しい書式適用後に必要高さを測り、XDが意図的にクリップしていない文字を隠しません。
- XDの背景レイヤー、mask shape、対応可能なblend modeをFigmaのレイヤー順とプロパティへ変換します。旧パッケージでもmask情報と安全な背景推定を用いて復元します。
- 詳細な原因・TOPページの件数・検証結果は`TOP_PAGE_IMPORT_ANALYSIS_20260721.md`に記録しています。

## 現在の制約

v0.1ではgradient、shadow/blur、静止画化できないLottie/Video、Figmaに対応値がないblend modeなどをネイティブFigma表現へ完全再現できません。現在の全件インポートポリシーでは対象を警告付きのFrame等へフォールバックし、元データと変換理由を監査情報として残します。見た目の完全一致ではなく、全アートボードと復元可能な情報の取り込みを優先する設定です。

Adobe XD本体を必要とするエクスポーターの実行検証は、XD 57以降を利用できる端末で行ってください。実機確認済みの構成はAdobe XD 61.0.12.1です。
