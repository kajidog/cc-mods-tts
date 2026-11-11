---
"cc-mods-tts": minor
---

回答の下に「▶ 読み上げ」ボタンの行を置くようにしました。押すとその回答を文字数の上限なしで読み直し、読んでいる間は「■ 止める」で止められます。`/config` の `TTS: Replay button under answers`（`replayButton`）でオフにできます。

`TTS: Player` に `claude` を足しました。再生コマンドを使わず、Claude Code の音声再生（`$.audio.play`）で鳴らします。Linux・Windows のターミナルでは何も鳴りません。

回答の下の行に使う `$.ui.place` が入った Claude Code 2.1.314 以降が必要になりました。
