// JavaScript 版（extension/core.js）が Python 版と同じ md を作るかを確かめる。
//
// 使い方:
//     node tests/check_js.mjs
//
// tests/check.py --update が保存した生の応答（tests/data/raw/）を core.js に通し、
// Python 版の出力（tests/data/expected/）と比べる。Google への取得は行わない。

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseSharedConversation, buildMarkdown, imageKey } from "../extension/core.js";

const DATA = join(dirname(fileURLToPath(import.meta.url)), "data");
const RAW = join(DATA, "raw");
const EXPECTED = join(DATA, "expected");

// source 行は入力した URL の書き方で変わるので比べない
const stripVolatile = (md) => md.split("\n").filter((l) => !l.startsWith("source: "));

/** 基準の images/ にあるファイル名から、画像の対応表を作る。 */
function imagePathsFrom(dir) {
  const paths = new Map();
  const imgDir = join(dir, "images");
  if (!existsSync(imgDir)) return paths;
  for (const name of readdirSync(imgDir)) {
    const m = name.match(/^(\d+)-(gemini-)?(\d+)\./);
    if (m) paths.set(imageKey(m[2] ? "gemini" : "user", Number(m[1]), Number(m[3])), `images/${name}`);
  }
  return paths;
}

let failed = 0;
const keys = readdirSync(RAW).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5)).sort();
for (const key of keys) {
  const dir = join(EXPECTED, key);
  const mdName = existsSync(dir) && readdirSync(dir).find((f) => f.endsWith(".md"));
  if (!mdName) {
    console.log(`基準なし ${key}`);
    failed++;
    continue;
  }
  const inner = JSON.parse(readFileSync(join(RAW, `${key}.json`), "utf8"));
  const conv = parseSharedConversation(inner);
  const md = buildMarkdown(conv, `https://share.gemini.google/${key}`, imagePathsFrom(dir));

  const want = stripVolatile(readFileSync(join(dir, mdName), "utf8"));
  const got = stripVolatile(md);
  const j = want.findIndex((line, n) => line !== got[n]);
  if (j === -1 && want.length === got.length) {
    console.log(`同じ ${key}`);
  } else {
    const at = j === -1 ? Math.min(want.length, got.length) : j;
    console.log(`違い ${key}（${at + 1} 行目付近）`);
    console.log(`  Python: ${JSON.stringify(want[at])}`);
    console.log(`  JS    : ${JSON.stringify(got[at])}`);
    failed++;
  }
}
console.log(failed ? `\n${keys.length} 件中 ${failed} 件で違いがありました` : "\nすべて Python 版と同じです");
process.exit(failed ? 1 : 0);
