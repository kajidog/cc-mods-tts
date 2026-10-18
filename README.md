# cc-mods-tts

[![Latest Claude Code](https://github.com/kajidog/cc-mods-tts/actions/workflows/latest-claude-code.yml/badge.svg)](https://github.com/kajidog/cc-mods-tts/actions/workflows/latest-claude-code.yml)

Claude Code の mod（関数フックのプラグイン）。Claude の返答をストリーミング中に一文ずつ読み上げます。

- 対応プラットフォーム: macOS / Linux / Windows（ネイティブ・WSL）
- `turn.step` の text チャンクを文に分割し、合成と再生をパイプラインで流す（コードブロック・表・URL は読み上げから除外してます）
- エンジン: [VOICEVOX](https://voicevox.hiroshiba.jp/) 互換 / [Irodori-TTS](https://github.com/Aratako/Irodori-TTS-Server) / 任意コマンド

コードブロック・表・URL は読まず、パスや識別子は聞き取りやすい形に直して読みます。

<details>
<summary>読み方の一覧</summary>

| 書かれ方 | 読み方 |
|---|---|
| コードブロック・表 | 飛ばして「コードは省略します。」「表は省略します。」と言う |
| 引用 | 最初の文に「引用、」を付けて読む。中のコードや表は飛ばす |
| URL・リンク | URL は読まない。リンクは表示される文字だけ読む |
| 箇条書きの印・括弧 | 印は読まない。括弧は外して中身を読む |
| ファイルパス | ファイル名と行番号だけ読む |
| `maxCharsPerTurn` などの識別子 | 単語に分けて読む（`SQLite`・`iPhone` などの名前は分けない） |
| 12文字以上のハッシュ・UUID | 先頭7文字・8文字だけ読む |
| `<kbd>` `<br>` などの HTML タグ・コメント | タグは読まず、中の文字だけ読む |
| 負数・小数・`C++`・`--help` | 記号を残して読む |
| 絵文字 | エンジンに任せる（VOICEVOX は読み飛ばす） |

読み方をさらに変えたい場合は、`engine=command` でスクリプトを挟めます。

</details>

## セットアップ

Claude Code 2.1.287 以降（Mods が既定で有効なバージョン）。どちらか一方で使えるようにできます。

### A. GitHub からインストール（使うだけなら）

ターミナルの Claude Code のプロンプトで:

```
/plugin install tts --marketplace kajidog/cc-mods-tts
```

「Add marketplace?」に `y`、スコープは user（既定）のまま Enter。そのセッションからすぐ有効になり、以降のセッションでも読み込まれます。更新は `claude plugin update tts` のあと `/reload-plugins`。

デスクトップアプリの Code タブではこのコマンドは使えません。  
設定→プラグインからマーケットプレイスの追加で`kajidog/cc-mods-tts`のリポジトリを追加してこのプラグイン（tts）をインストールしてください

### B. クローンして読み込む（手元で改造するなら）

```sh
git clone https://github.com/kajidog/cc-mods-tts.git ~/cc-mods-tts
claude --plugin-dir ~/cc-mods-tts
```

常に読み込むなら `~/.claude/settings.json` の `env` に `"CLAUDE_CODE_PLUGIN_DIRS": "~/cc-mods-tts"`。この方法ではクローンしたフォルダのコードがそのまま動き、編集するとセッション中に読み込み直されます。

### 読み込んだら

1. [VOICEVOX](https://voicevox.hiroshiba.jp/) を起動しておく（インストール時の既定エンジン）
2. `/tts engine` で voicevox が ● になっているか確認
3. 声を変えたい場合は `/tts voice` で選ぶ（既定は「ずんだもん・ノーマル」）
4. `/tts test` で鳴るか確認

### Irodori-TTS を使う場合

<details>
<summary>Irodori-TTS への切り替えと声の追加の手順</summary>

1. [Irodori-TTS-Server](https://github.com/Aratako/Irodori-TTS-Server) を起動する
2. 参照音声（例: `sample.wav`）をサーバー側の `voices/` に置く。拡張子を除いたファイル名（この例では `sample`）が声の ID になります
3. `/tts engine irodori` で切り替え、`/tts voice` で追加した声を選ぶ（`/tts voice sample` で直接指定もできます）
4. `/tts test` で鳴るか確認

`voices/` は Irodori-TTS-Server 側のフォルダです。`IRODORI_VOICES_DIR` を設定している場合は、そのフォルダに置いてください。Irodori は声を選ぶまで読み上げができません。

対応する音声形式やアップロード API など、詳しくは[公式の音声追加・管理手順（Voice Management）](https://github.com/Aratako/Irodori-TTS-Server#voice-management)を参照してください。

</details>

### OS 標準の音声を使う場合（engine=command）

VOICEVOX などを入れなくても、OS に入っている音声で読めます。エンジンは VOICEVOX のままにして、OS の音声を予備にもできます。`TTS: Command` を設定し、`/config` の `TTS: Fallback engine` を `command` にしておくと、VOICEVOX が起動していないときや落ちたときでも、その文を OS の音声で読みます。VOICEVOX が戻れば、次の文からまた VOICEVOX で読みます。VOICEVOX が使えない間は、ステータス行に `⚠ tts: voicevox down` と出ます。

<details>
<summary>macOS・Windows・Linux のコマンド例</summary>

`/config` の `TTS: Command` に次のどれかを入れて、`/tts engine command` で切り替えます。コマンドは空白で区切って引数にするので、引数（パスを含む）に空白は入れられません。`{out}` は書き出す wav のパスに置き換わり、読む文は標準入力で渡ります。

**macOS**（`say`。日本語の声 Kyoko がない場合は、システム設定 → アクセシビリティ → 読み上げコンテンツ で追加）

```
say -v Kyoko -f - --file-format=WAVE --data-format=LEI16@22050 -o {out}
```

**Windows**（標準の音声合成。日本語の声 Haruka は日本語版 Windows に入っています）

次の内容を `C:\tts\speak.ps1` などに保存します（空白を含まないパスに置いてください）。

```powershell
param([string]$Out)
Add-Type -AssemblyName System.Speech
[Console]::InputEncoding = [Text.Encoding]::UTF8
$text = [Console]::In.ReadToEnd()
$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
$synth.SetOutputToWaveFile($Out)
$synth.Speak($text)
$synth.Dispose()
```

```
powershell.exe -NoProfile -ExecutionPolicy Bypass -File C:\tts\speak.ps1 {out}
```

WSL から使う場合は、`{out}` が Linux のパスのまま渡るので、このままでは使えません。

**Linux**（[eSpeak NG](https://github.com/espeak-ng/espeak-ng)。日本語はかなり機械的な読み方です）

```
espeak-ng -v ja --stdin -w {out}
```

どれも `TTS: Speed` は効きません。速さは各コマンドのオプション（`say -r`、`espeak-ng -s` など）で変えてください。

</details>

### アンインストール

A で入れた場合:

```sh
claude plugin uninstall tts@cc-mods-tts
claude plugin marketplace remove cc-mods-tts   # マーケットプレイスも消すなら
```

起動中のセッションには `/reload-plugins` で反映されます。

B の場合は `--plugin-dir` を付けずに起動するか、`CLAUDE_CODE_PLUGIN_DIRS` を settings.json から消して、クローンしたフォルダを削除します。

どちらの場合も、`/config` で変えた設定は `~/.claude/settings.json` の `pluginConfigs` に残ります（A は `tts@cc-mods-tts`、B は `tts@inline` のキー）。不要なら手で消してください。

## 使い方

| コマンド | 内容 |
|---|---|
| `/tts` | 状態表示（on/off・モード・エンジン・速度・音量） |
| `/tts help` | コマンド一覧 |
| `/tts config` | 設定の一覧と今の値 |
| `/tts on` / `/tts off` | 有効・無効（`/config` の TTS: Enabled と同じ） |
| `/tts stop` | 合成・再生中の処理とキューを止め、そのターンの残りの返答も読まない。次のターンから再開 |
| `/tts test [text]` | 通常の返答と同じ整形を通してテスト読み上げ |
| `/tts replay` | 直前の最終回答を、文字数の上限なしで最初から読み直す |
| `/tts replay select` | 最近の発言ブロック（ツール呼び出しやユーザーの発言で区切ったもの）を新しい順に一覧し、冒頭の文で選んで最初から読み直す |
| `/tts mode [stream\|final\|notify]` | 読み上げモード切替。引数なしでモードを選ぶペインを開く |
| `/tts summary [on\|off]` | 長い回答の要約だけ読むかどうか（下記）。引数なしで今の値を表示 |
| `/tts engine [name]` | エンジン切替。引数なしで各エンジンが応答するか（ok / down / unset）を表示 |
| `/tts voice [id]` | 引数なしで声を選ぶペインを開く（↑↓で移動、Enter で決定、Esc で閉じる）。id 指定で直接設定 |
| `/tts speed [n]` / `/tts volume [n]` | 速度・音量（1 が等倍）。引数なしで候補を選ぶペインを開く |

声の候補が多い場合は64件ずつ表示します。`p` / `n`（Previous / Next）でページを切り替え、↑↓と Enter で選択できます。最初は現在の声があるページを開きます。

### 読み上げモード

| モード | 読むもの |
|---|---|
| `stream`（既定） | 返答をストリーミング中に一文ずつ。最終回答が届いた時点でツール前の文をまだ読んでいたら、それを止めて最終回答を頭から読む |
| `final` | ターン終了時に最終的な返答だけ（途中のツール前の文は読まない） |
| `notify` | 短い通知だけ：「完了しました」「エラーで止まりました」など |

### 要約だけ読む

`/tts summary on`（`/config` の TTS: Read the summary only）にすると、Claude に「長い回答は1行目に `**要約**: …` で要約を書く」よう頼みます（stream / final モードのときだけシステムプロンプトに足します）。既定はオフです。最終回答が要約の行で始まっていれば、その1行だけ読み、残りは読みません。要約がなければ、これまで通り回答を読みます。

- 要約は画面にもそのまま出ます。読み上げ専用の隠しテキストではないので、表示が崩れたり余計なトークンを使ったりしません。
- 判定するのは回答の1行目だけです。`**要約**:`・`**要約:**`・`Summary:`・`TL;DR:` を目印にします。
- stream モードでは、ツール前の発言はこれまで通り読み、最終回答だけ要約の行で止めます。
- `/tts replay` は要約ではなく回答全体を読み直します。
- `/tts summary off` で、頼むのも要約だけ読むのもやめます。

どのモードでも、以下の操作待ちのダイアログが出たら読み上げを止めて通知します:

| ダイアログ | 読む文（既定。`/config` の TTS notice で変えられる） |
|---|---|
| 質問（AskUserQuestion） | 1件: 質問があります。＋質問文 / 複数: 質問が3件あります。 |
| プランの承認（ExitPlanMode） | プランの確認をお願いします。 |
| Bash の許可 | コマンドの確認をお願いします。＋コマンドの説明（description） |
| その他のツールの許可 | ツールの許可をお願いします。 |

許可は `classic.PermissionRequest`（ダイアログを出すときに発火）で拾うので、ルールや auto モードで自動判定された呼び出しでは鳴らない。通知の音声は初回だけ合成し、以降は使い回す。

### 複数のセッション

同じマシンで複数のセッションが読み上げても、音声は重ならず順番に再生します。設定はいりません。`/config` の `TTS: Take turns with other sessions` をオフにすると、待たずにすぐ再生します。

<details>
<summary>順番の決まり方</summary>

- 優先度は 通知・ダイアログ・`/tts` コマンド ＞ 最終回答 ＞ ツール前の発言 の順です。読んでいるセッションは、文の切れ目でより優先度の高い待ち手に譲ります（読みかけの文は最後まで読みます）。
- 待ち時間の上限（`maxWaitSeconds`）を超えたら捨てるのは、ツール前の発言だけです。通知と最終回答は必ず読みます。
- ダイアログや `/tts stop` で止まるのは、そのセッションの読み上げだけです。
- WSL 内と Windows ネイティブのセッションは別々に順番を取ります（同時に動かすと重なることがあります）。

</details>

### 再生の補足

<details>
<summary>停止のタイミング・語尾の途切れ・WSL のノイズ</summary>

- **停止:** 合成のリクエストも中断します。ただし TTS サーバーが切断後も計算を続ける場合は、終わるまで次の合成が待たされることがあります。
- **語尾の途切れ:** `ffplay` / `powershell` では、無音を除いた WAV の後ろに0.2秒の無音を足します。`ffmpeg` が必要で、ない場合は元の音声をそのまま再生します。
- **WSL のノイズ:** `ffplay` は WSLg を経由するため、「ジリジリ」とノイズが混じることがあります。`/config` の `TTS: Player` を `powershell` にすると改善します（文と文の間は少し空きます）。

</details>

## 設定

設定はすべて `/config` の tts にまとめてます。項目名はどれも `TTS:` / `TTS notice:` で始まります。

<details>
<summary>設定一覧</summary>

| 項目（キー） | 内容 | 既定 |
|---|---|---|
| TTS: Enabled（`enabled`） | 読み上げる / 読み上げない | true |
| TTS: Read mode（`mode`） | `stream` / `final` / `notify`（上記） | stream |
| TTS: Engine（`engine`） | `voicevox` / `irodori` / `command` | voicevox |
| TTS: Fallback engine（`fallback`） | メインのエンジンが失敗した文（サーバー停止・未設定など）を読むエンジン。メインが使えない間は、ステータス行に `⚠ tts: voicevox down` のように出る | none |
| TTS: Speed（`speed`） | 速度。エンジン側で合成時にかける（Irodori は 0.25〜4、VOICEVOX は speedScale）。command では無視 | 1.1 |
| TTS: Volume（`volume`） | 音量。再生時にかけるのでどのエンジンでも効く。ffplay / paplay / afplay は再生コマンドで、aplay / powershell は ffmpeg があれば再生前に変える | 1 |
| TTS: Player（`player`） | 再生コマンド。`auto` は Windows ネイティブでは ffplay → powershell.exe、それ以外では ffplay → paplay → aplay → afplay → powershell.exe の順に最初に見つかったもの | auto |
| TTS: Max characters per response（`maxCharsPerTurn`） | 1回の応答で読む最大文字数。超えたら「途中を省略します。」と言って残りを飛ばし、応答の最後の1文だけ読む。0 で無制限 | 600 |
| TTS: Take turns with other sessions（`sharePlayback`） | 複数のセッションが読み上げるとき、1つずつ順番に再生する。オフにすると各セッションがすぐに再生する（音声が重なることがある） | オン |
| TTS: Max wait for other sessions（`maxWaitSeconds`） | ほかのセッションが読み上げている間、ツール前の発言を待たせる最大秒数。超えたら捨てる。通知と最終回答は常に待って読む。0 で無制限 | 60 |
| TTS: Stop on new prompt（`interruptOnPrompt`） | プロンプト送信で読み上げを止める | true |
| TTS: Prompt for the model（`modelPrompt`） | 読み上げ中（stream / final モード）に Claude のシステムプロンプトへ足す文。説明・進捗報告は原則日本語にし、コード・引用・ユーザーの言語指定は保持する。空にすると何も足さない | 応答は音声で読み上げられています。説明やツール呼び出しの合間の進捗報告は原則として日本語で書いてください。ただし、コード・識別子・引用はそのまま保持し、ユーザーが指定した言語を優先してください。 |
| TTS: Read the summary only（`summary`） | 長い回答の1行目に要約を書くよう Claude に頼み、要約があればそれだけ読む（stream / final モード）。`/tts summary on` / `off` と同じ | false |
| TTS: Irodori URL（`irodoriUrl`） | Irodori-TTS の URL | `http://localhost:8088` |
| TTS: Irodori voice（`irodoriVoice`） | Irodori の声（`/tts voice` で選べる） | （未設定） |
| TTS: VOICEVOX URL（`voicevoxUrl`） | VOICEVOX 互換エンジンの URL（AivisSpeech は `http://localhost:10101`） | `http://localhost:50021` |
| TTS: VOICEVOX speaker（`voicevoxSpeaker`） | VOICEVOX のスタイル id（`/tts voice` で選べる） | 3 |
| TTS: Command（`command`） | engine=command のときのコマンド。空白区切り、`{out}` が書き出す wav のパスに置き換わり、本文は標準入力で渡る | （未設定） |
| TTS notice: done / error / refusal（`noticeDone` / `noticeError` / `noticeRefusal`） | notify モードでターン終了時に言う文 | 完了しました。/ エラーで止まりました。/ 応答できませんでした。 |
| TTS notice: question（`noticeQuestion`） | 質問が1件出たとき、質問文の前に言う文 | 質問があります。 |
| TTS notice: questions（`noticeQuestions`） | 質問が複数出たときに言う文。`{n}` が件数になる | 質問が{n}件あります。 |
| TTS notice: plan（`noticePlan`） | プランの承認待ちで言う文 | プランの確認をお願いします。 |
| TTS notice: command（`noticeCommand`） | Bash の許可ダイアログで、コマンドの説明の前に言う文 | コマンドの確認をお願いします。 |
| TTS notice: tool（`noticeTool`） | その他のツールの許可ダイアログで言う文 | ツールの許可をお願いします。 |
| TTS notice: cut（`noticeCut`） | 文字数の上限で残りを飛ばすときに言う文。この後に応答の最後の1文を読む | 途中を省略します。 |
| TTS notice: code（`noticeCode`） | コードブロックを飛ばすところで言う文（stream / final モード） | コードは省略します。 |
| TTS notice: table（`noticeTable`） | 表を飛ばすところで言う文（stream / final モード） | 表は省略します。 |
| TTS notice: quote（`noticeQuote`） | 引用の最初の文の前につなげて言う文（stream / final モード） | 引用、 |

</details>

通知の文はどれも空にするとその通知の読み上げをスキップできます（注：スキップしても既存の再生は止まります）。  
質問やコマンドの通知を空にした場合は、質問文・コマンドの説明も読みません。

Irodori の速度の対応範囲は **0.25〜4** です。Mod ではこの下限による入力エラーは出しませんが、範囲外の値は Irodori サーバーが拒否する場合があります。文字数の上限に、省略やコードを知らせる通知文と、省略後に読む最後の1文は含みません。上限をまたぐ文は途中まで読まずに飛ばします。最後の1文が300文字を超える場合は読みません。

音声ファイルはセッション用の一時ディレクトリに保存し、再生後に削除します。macOS / Linux / WSL では所有者のみアクセスできる権限で作成し、Windows ネイティブではユーザーの一時フォルダ（`%TEMP%`）のアクセス権を引き継ぎます。通知キャッシュはセッション終了時・Mod の再読み込み時に削除します。プロセスの強制終了などで清掃が実行できなかった場合は、一時ディレクトリに残ることがあります。

## 前提

- `curl`（Windows では `curl.exe`）
- `mktemp`（macOS / Linux / WSL の一時ディレクトリ作成に使用）
- Windows ネイティブ: Windows PowerShell（`powershell.exe`、一時ファイルの管理と再生に使用）
- 再生: `ffplay` / `paplay` / `aplay` / `afplay` / `powershell.exe`（Windows・WSL）のいずれか（`player: auto` で自動選択）

## 開発

<details>
<summary>開発者向け: エンジンの追加・lint・テスト・リリースの手順</summary>

```sh
npm install
CLAUDE_CODE_PLUGIN_DIR_WATCH=1 claude --init-only --plugin-dir .  # .claude-plugin/types/ を生成（型チェックに必要）
npm run check  # lint・validate・型チェック・test をまとめて実行
```

個別には `npm run lint` / `npm run validate` / `npm run typecheck` / `npm test` で実行できます。Biome と TypeScript は devDependencies で固定し、`claude` は PATH にあるものを使います。

CI（`.github/workflows/ci.yml`）は main への push と PR で lint を実行し、Linux・Windows で validate・型チェック・test を実行します。型チェックの前に、上記の初期化コマンドで `.claude-plugin/types/` を生成します。対話セッションや API キーは不要です。

API は early access のため、Claude Code の更新で変わることがある（CI で確認しているバージョン: 2.1.296）。


### エンジンを追加する

エンジンは `hooks/engines/` に1ファイルずつある（`irodori.ts` / `voicevox.ts` / `command.ts`）。追加するには:

1. `hooks/engines/<name>.ts` に `Engine`（`engine.ts` の型）を書く。`load(options, isWindows)` で自分の設定を読み、`synthesis(text, out)` で wav を `out` に書くコマンド列を返す。声の一覧があれば `voices` も
2. `hooks/engines/index.ts` の `ENGINES` に足す
3. `.claude-plugin/plugin.json` の `userConfig.engine.options` に名前を足し、そのエンジンの設定項目を追加する


### 状態を別の Mod で表示する

この Mod は画面に UI を出しません（エンジンが落ちたときのステータス行だけ出します）。読んでいる文やエンジンの状態は `$.state` に公開しているので、表示は別の Mod で作れます。型は `types/index.d.ts` の `SpeechState` / `EngineState` です。

| キー | 中身 |
|---|---|
| `{ plugin: "tts", key: "speech" }` | `state`（`idle` / `preparing` / `waiting` / `playing`）と、待っている・読んでいる文の `text` |
| `{ plugin: "tts", key: "engine" }` | 使っているエンジンの `name`・`voice` と `status`（`checking` / `ok` / `down` / `unset` / `off`） |

`ui.render` の中で `$.state.get` すると、値が変わるたびに描き直されます。書けるのはこの Mod だけです。

### 別の Mod から読み上げる

`$.tts` を公開しているので、別の Mod からこのセッションに読み上げさせられます。型は `types/index.d.ts` の `Tts` です。呼ぶ側の `plugin.json` の `dependencies` に `"tts"` を足すと、`$.tts` に型が付きます。

```ts
const result = await $.tts.speak({ text: "ビルドが終わりました。" })
// { isQueued: true }、または { isQueued: false, reason: "off" | "empty" }
await $.tts.stop()
```

| メソッド | 内容 |
|---|---|
| `speak({ text, interrupt? })` | `text` を `/tts test` と同じ整形で読む（コードブロック・表・URL は読まない）。キューに入った時点で返り、読み終わりは待たない（`speech` の状態で分かる）。`interrupt: true` で、読んでいるものとキューを止めてすぐ読む |
| `stop()` | 読んでいるものとキューを止める。ストリーミング中の返答の残りも読まない（`/tts stop` と違い、次の応答からはまた読む） |

`speak` は読み上げモードに関係なく読み、1回の応答の文字数の上限もかかりません。複数のセッションの間では通知と同じく最優先です。`/tts off` の間は読まずに `reason: "off"` を返します。

### 変更履歴とリリース

変更履歴は [CHANGELOG.md](CHANGELOG.md) にまとめています。[Changesets](https://changesets.dev/) で変更メモを集め、GitHub Actions がリリース用 PR を作成・更新します。

開発時は Node.js 22.11 以降の 22 系、24 系、または 26 以降と、npm 10.9 以降を使います。

```sh
npm ci
npm run changeset
```

`patch`（修正）・`minor`（機能追加）・`major`（互換性のない変更）を選び、変更内容を日本語で入力します。生成された `.changeset/*.md` をコードと一緒にコミットしてください。ドキュメントや CI だけの変更ではメモは不要です。

1. 変更メモを含む PR を main にマージする。
2. Actions が `chore: release tts` という PR を作成・更新する。CHANGELOG への追記と、`package.json`・`package-lock.json`・`.claude-plugin/plugin.json` のバージョン更新がまとまります。
3. 内容を確認してリリース用 PR をマージする。利用者は `claude plugin update tts` と `/reload-plugins` で更新できます。

最初に GitHub リポジトリの **Settings → Actions → General → Workflow permissions** で **Allow GitHub Actions to create and approve pull requests** を有効にしてください（[Changesets の設定手順](https://github.com/changesets/action/tree/v2#requirements)）。標準の `GITHUB_TOKEN` を使うため、追加のトークンは不要です。自動作成された PR の CI が承認待ちになった場合は、PR 画面の **Approve workflows to run** で実行を承認してください（[GitHub の仕様](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow#triggering-a-workflow-from-a-workflow)）。

手元でリリース差分を生成する場合は `npm run release:version`、バージョンの整合性確認は `npm run check:version` を使います。履歴の生成時はプラグイン側も同期するため、`changeset version` 単体では実行しません。バージョン管理用の `package.json` は `private: true` で、npm 公開や GitHub Release の作成は行いません。

</details>

## ライセンス

[MIT License](LICENSE)
