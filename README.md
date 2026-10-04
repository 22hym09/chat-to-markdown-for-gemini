# Chat to Markdown for Gemini

Gemini の会話を、画像も含めて Markdown ファイルに書き出す Chrome 拡張機能です。書き出したファイルを ChatGPT や Claude に渡して、会話の続きをするために作りました。

> 非公式の拡張機能です。Google とは関係ありません。Gemini は Google LLC の商標です。

## できること

- 開いている Gemini の会話を、ボタン1つで Markdown ファイルに保存する
  - 自分の会話のページ（`gemini.google.com/app/…`）でも、共有リンクのページ（`gemini.google.com/share/…`）でも使える。会話を公開しなくても書き出せる
- 長い会話も最初から最後まで書き出す（画面に表示されていない部分も含む）
- 画像を原寸で保存する。画像がある会話は、Markdown と `images/` をまとめた zip になる
  - あなたが添付した画像
  - Gemini が生成した画像
- 次の内容も書き出す
  - 表、コード、数式（`$…$`、`$$…$$`）
  - Canvas の最終版
  - Deep Research の調査計画と報告書（出典の一覧つき）
  - Google マップの地図と地名のリンク、Gemini が作った曲の名前、Gem の名前

## 使い方

1. Gemini の会話を開く
2. ツールバーの拡張機能のアイコンを押す
3. 「ファイルに保存」を押す

ファイルはブラウザのダウンロードフォルダに保存されます。

## 書き出される形

```markdown
---
title: "会話のタイトル"
source: https://gemini.google.com/app/…
model: "3.5 Flash"
exported: 2026-10-04 20:17
---

# 会話のタイトル

## 1. 最初の質問の1行目…

> **ユーザー**
> 質問の本文

**Gemini**

回答の本文（見出し、表、コード、数式はそのまま）

## 2. 次の質問の1行目…
...
```

- 往復ごとに見出しが付くので、目次から話題を探せます
- 回答内の見出しは、往復の見出しより下の段になるようにずらします
- 引用の目印（`[cite: 1]`）は消します。Deep Research の報告書では番号を残し、出典の一覧を付けます

## 書き出せないもの

- 添付した PDF・音声・動画などの中身（Gemini 側で取得できないため、ファイル名だけを書きます）
- Gemini が作った曲や動画のファイル（名前だけを書きます）
- 再生成した回答のうち、選んでいないもの

## プライバシー

会話の中身は、あなたのブラウザの中だけで処理します。開発者や外部のサーバーには一切送りません。詳しくは[プライバシーポリシー](https://22hym09.github.io/chat-to-markdown-for-gemini/privacy)を見てください。

## 仕組み

Gemini のページが会話を表示するときに使っている通信を、ページの中から同じように呼び出して会話のデータを受け取り、Markdown に整形します。画面の表示内容を読み取る方式ではないので、長い会話でも取りこぼしません。

この通信は公開されている仕組みではないため、Gemini 側の変更で動かなくなることがあります。

## 開発者向け

| ファイル | 役割 |
|---|---|
| `extension/core.js` | 会話データの解析と Markdown への整形、zip の作成 |
| `extension/popup.js` | 会話の取得と保存 |
| `gemini_md.py` | 共有リンクから書き出すコマンド（Python 版。標準ライブラリだけで動く） |
| `tests/check.py` | 手元の共有リンクの出力が以前と同じかを確かめる |
| `tests/check_js.mjs` | JavaScript 版が Python 版と同じ出力を作るかを確かめる |

Python 版の使い方：

```bash
python3 gemini_md.py https://share.gemini.google/xxxxxxxx
```

## ライセンス

[MIT](LICENSE)
