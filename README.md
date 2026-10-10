# cc-mods-tts

Claude Code の mod（関数フックのプラグイン）。Claude の返答をストリーミング中に一文ずつ読み上げます。

- `turn.step` の text チャンクを文に分割し、合成と再生をパイプラインで流す（コードブロック・表・URL は読まない）
- エンジン: Irodori-TTS / VOICEVOX 互換（AivisSpeech 等）/ 任意コマンド

## セットアップ

Claude Code 2.1.275 以降。どちらか一方で読み込みます。

### A. GitHub からインストール（使うだけなら）

ターミナルの Claude Code のプロンプトで:

```
/plugin install tts --marketplace kajidog/cc-mods-tts
```

「Add marketplace?」に `y`、スコープは user（既定）のまま Enter。そのセッションからすぐ有効になり、以降のセッションでも読み込まれます。更新は `claude plugin update tts` のあと `/reload-plugins`。

デスクトップアプリの Code タブではこのコマンドは使えません。ターミナルから user スコープで入れれば、デスクトップアプリのローカルセッションでも読み込まれます。

### B. クローンして読み込む（手元で改造するなら）

```sh
git clone https://github.com/kajidog/cc-mods-tts.git ~/cc-mods-tts
claude --plugin-dir ~/cc-mods-tts
```

常に読み込むなら `~/.claude/settings.json` の `env` に `"CLAUDE_CODE_PLUGIN_DIRS": "~/cc-mods-tts"`。この方法ではクローンしたフォルダのコードがそのまま動き、編集するとセッション中に読み込み直されます。

### 読み込んだら

1. Irodori-TTS か VOICEVOX（互換エンジン）を起動しておく
2. `/tts engine` でエンジンが ● になっているか確認し、違うエンジンを使うなら `/tts engine voicevox`
3. `/tts voice` で声を選ぶ（Irodori は声を選ぶまで読み上げない）
4. `/tts test` で鳴るか確認

## 使い方

| コマンド | 内容 |
|---|---|
| `/tts` | 状態表示（on/off・モード・エンジン・速度・音量） |
| `/tts help` | コマンド一覧 |
| `/tts config` | 設定の一覧と今の値 |
| `/tts on` / `/tts off` | 有効・無効（`/config` の Enabled と同じ） |
| `/tts stop` | 読み上げ中の音声とキューを破棄 |
| `/tts test [text]` | テスト読み上げ |
| `/tts mode [stream\|final\|notify]` | 読み上げモード切替。引数なしでモードを選ぶペインを開く |
| `/tts engine [name]` | エンジン切替。引数なしで各エンジンが応答するか（ok / down / unset）を表示 |
| `/tts voice [id]` | 引数なしで声を選ぶペインを開く（↑↓で移動、Enter で決定、Esc で閉じる）。id 指定で直接設定 |
| `/tts speed [n]` / `/tts volume [n]` | 速度・音量（1 が等倍）。引数なしで候補を選ぶペインを開く |

### 読み上げモード

| モード | 読むもの |
|---|---|
| `stream`（既定） | 返答をストリーミング中に一文ずつ |
| `final` | ターン終了時に最終的な返答だけ（途中のツール前の文は読まない） |
| `notify` | 短い通知だけ：「完了しました」「エラーで止まりました」など |

どのモードでも、以下の操作待ちのダイアログが出たら読み上げを止めて一言知らせる:

| ダイアログ | 読む文（既定。`/config` の Notice で変えられる） |
|---|---|
| 質問（AskUserQuestion） | 1件: 質問があります。＋質問文 / 複数: 質問が3件あります。 |
| プランの承認（ExitPlanMode） | プランの確認をお願いします。 |
| Bash の許可 | コマンドの確認をお願いします。＋コマンドの説明（description） |
| その他のツールの許可 | ツールの許可をお願いします。 |

許可は `classic.PermissionRequest`（ダイアログを出すときに発火）で拾うので、ルールや auto モードで自動判定された呼び出しでは鳴らない。通知の音声は初回だけ合成し、以降は使い回す。

## 設定

設定はすべて `/config` の tts にまとめてます。

以下、一覧

| 項目（キー） | 内容 | 既定 |
|---|---|---|
| Enabled（`enabled`） | 読み上げる / 読み上げない | true |
| Read mode（`mode`） | `stream` / `final` / `notify`（上記） | stream |
| TTS engine（`engine`） | `irodori` / `voicevox` / `command` | irodori |
| Fallback engine（`fallback`） | メインのエンジンが失敗した文（サーバー停止・未設定など）を読むエンジン。切り替わったときはトーストで一度知らせる | none |
| Speed（`speed`） | 速度。エンジン側で合成時にかける（Irodori は 0.25〜4、VOICEVOX は speedScale）。command では無視 | 1 |
| Volume（`volume`） | 音量。再生時にかけるのでどのエンジンでも効く。ffplay / paplay / afplay は再生コマンドで、aplay / powershell は ffmpeg があれば再生前に変える | 1 |
| Player（`player`） | 再生コマンド。`auto` は ffplay → paplay → aplay → afplay → powershell.exe の順に最初に見つかったもの | auto |
| Max characters per response（`maxCharsPerTurn`） | 1回の応答で読む最大文字数。超えたら「以下、省略します。」と言って止める。0 で無制限 | 600 |
| Stop on new prompt（`interruptOnPrompt`） | プロンプト送信で読み上げを止める | true |
| Irodori URL（`irodoriUrl`） | Irodori-TTS の URL | `http://localhost:8088` |
| Irodori voice（`irodoriVoice`） | Irodori の声（`/tts voice` で選べる） | （未設定） |
| VOICEVOX URL（`voicevoxUrl`） | VOICEVOX 互換エンジンの URL（AivisSpeech は `http://localhost:10101`） | `http://localhost:50021` |
| VOICEVOX speaker（`voicevoxSpeaker`） | VOICEVOX のスタイル id（`/tts voice` で選べる） | 3 |
| Command（`command`） | engine=command のときのコマンド。空白区切り、`{out}` が書き出す wav のパスに置き換わり、本文は標準入力で渡る | （未設定） |
| Notice: done / error / refusal（`noticeDone` / `noticeError` / `noticeRefusal`） | notify モードでターン終了時に言う文 | 完了しました。/ エラーで止まりました。/ 応答できませんでした。 |
| Notice: question（`noticeQuestion`） | 質問が1件出たとき、質問文の前に言う文 | 質問があります。 |
| Notice: questions（`noticeQuestions`） | 質問が複数出たときに言う文。`{n}` が件数になる | 質問が{n}件あります。 |
| Notice: plan（`noticePlan`） | プランの承認待ちで言う文 | プランの確認をお願いします。 |
| Notice: command（`noticeCommand`） | Bash の許可ダイアログで、コマンドの説明の前に言う文 | コマンドの確認をお願いします。 |
| Notice: tool（`noticeTool`） | その他のツールの許可ダイアログで言う文 | ツールの許可をお願いします。 |
| Notice: cut（`noticeCut`） | 文字数の上限で読むのをやめたときに言う文 | 以下、省略します。 |

通知の文はどれも空にするとその通知は言わない（ダイアログで読み上げを止めること自体は変わらない）。

## 前提

- `curl`
- 再生: `ffplay` / `paplay` / `aplay` / `afplay` / `powershell.exe`（WSL）のいずれか（`player: auto` で自動選択）

## エンジンを追加する

エンジンは `hooks/engines/` に1ファイルずつある（`irodori.ts` / `voicevox.ts` / `command.ts`）。追加するには:

1. `hooks/engines/<name>.ts` に `Engine`（`engine.ts` の型）を書く。`load(options)` で自分の設定を読み、`synthesis(text, out)` で wav を `out` に書くコマンド列を返す。声の一覧があれば `voices` も
2. `hooks/engines/index.ts` の `ENGINES` に足す
3. `.claude-plugin/plugin.json` の `userConfig.engine.options` に名前を足し、そのエンジンの設定項目を追加する

## 開発

```sh
claude plugin validate .
claude plugin test .
tsc -p .   # 一度読み込まれて .claude-plugin/types/ が生成された後
```

API は early access のため、Claude Code の更新で変わることがある（作成時: 2.1.289）。
