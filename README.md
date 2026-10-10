# cc-mods-tts

Claude Code の mod（関数フックのプラグイン）。Claude の返答をストリーミング中に一文ずつ読み上げます。

- 対応プラットフォーム: macOS / Linux / Windows（WSL）
- `turn.step` の text チャンクを文に分割し、合成と再生をパイプラインで流す（コードブロック・表・URL は読み上げから除外してます）
- エンジン: [VOICEVOX](https://voicevox.hiroshiba.jp/) 互換 / [Irodori-TTS](https://github.com/Aratako/Irodori-TTS-Server) / 任意コマンド

## セットアップ

Claude Code 2.1.275 以降。どちらか一方で使えるようにできます。

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

1. [VOICEVOX](https://voicevox.hiroshiba.jp/) を起動しておく（インストール時の既定エンジン）
2. `/tts engine` で voicevox が ● になっているか確認
3. 声を変えたい場合は `/tts voice` で選ぶ（既定は「ずんだもん・ノーマル」）
4. `/tts test` で鳴るか確認

### Irodori-TTS を使う場合

1. [Irodori-TTS-Server](https://github.com/Aratako/Irodori-TTS-Server) を起動する
2. 参照音声（例: `sample.wav`）をサーバー側の `voices/` に置く。拡張子を除いたファイル名（この例では `sample`）が声の ID になります
3. `/tts engine irodori` で切り替え、`/tts voice` で追加した声を選ぶ（`/tts voice sample` で直接指定もできます）
4. `/tts test` で鳴るか確認

`voices/` は Irodori-TTS-Server 側のフォルダです。`IRODORI_VOICES_DIR` を設定している場合は、そのフォルダに置いてください。Irodori は声を選ぶまで読み上げができません。

対応する音声形式やアップロード API など、詳しくは[公式の音声追加・管理手順（Voice Management）](https://github.com/Aratako/Irodori-TTS-Server#voice-management)を参照してください。

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
| `/tts on` / `/tts off` | 有効・無効（`/config` の Enabled と同じ） |
| `/tts stop` | 合成・再生中の処理とキューを止め、そのターンの残りの返答も読まない。次のターンから再開 |
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

どのモードでも、以下の操作待ちのダイアログが出たら読み上げを止めて通知します:

| ダイアログ | 読む文（既定。`/config` の Notice で変えられる） |
|---|---|
| 質問（AskUserQuestion） | 1件: 質問があります。＋質問文 / 複数: 質問が3件あります。 |
| プランの承認（ExitPlanMode） | プランの確認をお願いします。 |
| Bash の許可 | コマンドの確認をお願いします。＋コマンドの説明（description） |
| その他のツールの許可 | ツールの許可をお願いします。 |

許可は `classic.PermissionRequest`（ダイアログを出すときに発火）で拾うので、ルールや auto モードで自動判定された呼び出しでは鳴らない。通知の音声は初回だけ合成し、以降は使い回す。

停止すると Mod 側の合成リクエストも中断します。ただし、TTS サーバーが切断後も計算を続ける場合、その計算の終了までは次の合成が待たされることがあります。

## 設定

設定はすべて `/config` の tts にまとめてます。

以下、一覧

| 項目（キー） | 内容 | 既定 |
|---|---|---|
| Enabled（`enabled`） | 読み上げる / 読み上げない | true |
| Read mode（`mode`） | `stream` / `final` / `notify`（上記） | stream |
| TTS engine（`engine`） | `voicevox` / `irodori` / `command` | voicevox |
| Fallback engine（`fallback`） | メインのエンジンが失敗した文（サーバー停止・未設定など）を読むエンジン。メインが使えない間は、ステータス行に `⚠ tts: voicevox down` のように出る | none |
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

通知の文はどれも空にするとその通知の読み上げをスキップできます（注：スキップしても既存の再生は止まります）。  
質問やコマンドの通知を空にした場合は、質問文・コマンドの説明も読みません。

Irodori の速度の対応範囲は **0.25〜4** です。Mod ではこの下限による入力エラーは出しませんが、範囲外の値は Irodori サーバーが拒否する場合があります。文字数の上限に、省略を知らせる通知文は含みません。

音声ファイルは所有者だけがアクセスできる一時ディレクトリに保存し、再生後に削除します。通知キャッシュはセッション終了時・Mod の再読み込み時に削除します。プロセスの強制終了などで清掃が実行できなかった場合は、一時ディレクトリに残ることがあります。

## 前提

- `curl`
- `mktemp`（macOS / Linux / WSL の一時ディレクトリ作成に使用）
- 再生: `ffplay` / `paplay` / `aplay` / `afplay` / `powershell.exe`（WSL）のいずれか（`player: auto` で自動選択）

## エンジンを追加する

エンジンは `hooks/engines/` に1ファイルずつある（`irodori.ts` / `voicevox.ts` / `command.ts`）。追加するには:

1. `hooks/engines/<name>.ts` に `Engine`（`engine.ts` の型）を書く。`load(options)` で自分の設定を読み、`synthesis(text, out)` で wav を `out` に書くコマンド列を返す。声の一覧があれば `voices` も
2. `hooks/engines/index.ts` の `ENGINES` に足す
3. `.claude-plugin/plugin.json` の `userConfig.engine.options` に名前を足し、そのエンジンの設定項目を追加する

## 開発

```sh
npx -y @biomejs/biome@2.5.14 lint --error-on-warnings .
claude plugin validate --strict .
CLAUDE_CODE_PLUGIN_DIR_WATCH=1 claude --init-only --plugin-dir .
npx -y -p typescript@5.8.3 tsc -p .
claude plugin test .
```

CI（`.github/workflows/ci.yml`）は main への push と PR で lint・validate・型チェック・test を実行します。型チェックの前に、上記の初期化コマンドで `.claude-plugin/types/` を生成します。対話セッションや API キーは不要です。

API は early access のため、Claude Code の更新で変わることがある（CI で確認しているバージョン: 2.1.296）。

## ライセンス

[MIT License](LICENSE)
