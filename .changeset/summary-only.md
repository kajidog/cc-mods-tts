---
"cc-mods-tts": minor
---

長い回答は要約だけ読むようにしました（既定でオン）。

- stream / final モードでは、長い回答の1行目に `**要約**: …` を書くよう Claude に頼みます。最終回答が要約の行で始まっていれば、その行だけ読みます。要約がなければ、これまで通り読みます。
- 要約は画面にもそのまま出ます。stream モードでは、ツール前の発言はこれまで通り読みます。
- `/tts summary on|off`（`/config` の TTS: Read the summary only）で切り替えられます。`/tts replay` は回答全体を読み直します。

また、読んでいる文とエンジンの状態を `$.state`（`tts` の `speech` と `engine`）に公開しました。画面への表示は別の Mod で作れます。
