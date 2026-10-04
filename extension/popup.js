// ポップアップの処理。開いている Gemini のページの中で通信して会話を取得し、
// core.js で Markdown にして保存する。

import {
  RPC_SHARE,
  RPC_CHAT,
  RPC_GEM,
  ExportError,
  parseSharedConversation,
  parseOwnConversation,
  buildMarkdown,
  imageTargets,
  originalSizeUrl,
  imageExt,
  safeFilename,
  makeZip,
} from "./core.js";

const CHAT_PAGE_SIZE = 100; // hNvQHb で一度に読める往復の上限
const MAX_CHAT_PAGES = 200; // 続きの目印が終わらない場合の歯止め（2万往復）
const IMAGE_CONCURRENCY = 6; // 同時に取得する画像の枚数
// 画像はこの2か所からだけ取る（プライバシーポリシーに書いた通信先）
const IMAGE_HOSTS = ["https://lh3.googleusercontent.com/", "https://lh3.google.com/"];

const $ = (id) => document.getElementById(id);

/** 開いているページから、どの会話かを読み取る。Gemini の会話でなければ null。 */
function pageInfo(tab) {
  if (!tab || !tab.url) return null;
  const url = new URL(tab.url);
  if (url.hostname !== "gemini.google.com") return null;
  // 複数のアカウントでログインしていると、先頭に /u/1 などが付く
  const path = url.pathname.replace(/^\/u\/\d+(?=\/)/, "");
  let m = path.match(/^\/share\/([\w-]+)/);
  if (m) return { kind: "share", id: m[1], source: `https://gemini.google.com/share/${m[1]}` };
  // 自分の会話は /app/<会話ID>、Gem の会話は /gem/<GemID>/<会話ID>。
  // Google が用意した Gem の ID は coding-partner のような英単語になる
  m = path.match(/^\/(?:app|gem\/([\w-]+))\/([\w-]+)/);
  if (m) return { kind: "chat", id: m[2], gemId: m[1] || null, source: `${url.origin}${url.pathname}` };
  return null;
}

/**
 * ページの中で batchexecute を呼ぶ。ログイン情報と照合値（at）を使うため、
 * ページと同じ環境（MAIN world）で動かす。この関数は単独でページに送られるので、
 * 外の変数や関数を使わない。
 */
async function pageRpc(rpc, args) {
  const w = window.WIZ_global_data;
  if (!w || !w.cfb2h || !w.FdrFJe) return { error: "ページの設定データ（bl, f.sid）が見つかりません" };
  // 複数のアカウントでログインしているときは /u/1 などを付けて、開いているアカウントに問い合わせる
  const account = (location.pathname.match(/^\/u\/\d+(?=\/)/) || [""])[0];
  const query = new URLSearchParams({
    rpcids: rpc,
    "source-path": location.pathname.slice(account.length),
    bl: w.cfb2h,
    "f.sid": w.FdrFJe,
    hl: document.documentElement.lang || "ja",
    _reqid: String(Math.floor(Math.random() * 900000) + 100000),
    rt: "c",
  });
  const body = { "f.req": JSON.stringify([[[rpc, JSON.stringify(args), null, "generic"]]]) };
  // ログイン中は照合値（at）が無いと 400 になる。未ログインでは無い
  if (w.SNlM0e) body.at = w.SNlM0e;
  const res = await fetch(`${account}/_/BardChatUi/data/batchexecute?${query}`, {
    method: "POST",
    body: new URLSearchParams(body),
    credentials: "include",
  });
  if (!res.ok) return { error: `batchexecute への要求が失敗しました（HTTP ${res.status}）` };
  // 応答は「)]}'」の後に「文字数の行」と「JSON の行」が交互に並ぶ
  for (const line of (await res.text()).split("\n")) {
    if (!line.startsWith("[")) continue;
    let chunk;
    try {
      chunk = JSON.parse(line);
    } catch {
      continue;
    }
    for (const entry of chunk) {
      if (Array.isArray(entry) && entry[0] === "wrb.fr" && entry[1] === rpc) {
        if (entry[2] === null) return { error: "本文が空で返りました。rpcid・引数の形が変わった可能性があります" };
        return { data: JSON.parse(entry[2]) };
      }
    }
  }
  return { error: `応答の中に ${rpc} の結果が見つかりませんでした` };
}

async function rpc(tabId, name, args) {
  let result;
  try {
    [{ result }] = await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: pageRpc,
      args: [name, args],
    });
  } catch (e) {
    throw new ExportError("本文の取得", `ページで通信できませんでした: ${e.message}`);
  }
  if (!result || result.error) throw new ExportError("本文の取得", result ? result.error : "結果が返りませんでした");
  return result.data;
}

async function fetchConversation(tab, info, progress) {
  if (info.kind === "share") {
    progress("取得中…");
    return parseSharedConversation(await rpc(tab.id, RPC_SHARE, [null, info.id]));
  }
  // 自分の会話は新しい順に最大100往復ずつ返るので、続きの目印が無くなるまで読む
  const turns = [];
  let token = null;
  for (let page = 0; ; page++) {
    if (page >= MAX_CHAT_PAGES) throw new ExportError("本文の取得", "続きの読み込みが終わりません。応答の形が変わった可能性があります");
    progress(`取得中… ${turns.length} 往復`);
    const r = await rpc(tab.id, RPC_CHAT, [`c_${info.id}`, CHAT_PAGE_SIZE, token, 1, [0], [4], null, 1]);
    if (!Array.isArray(r)) throw new ExportError("本文の解析", "応答の形が想定と違います。配列の位置が変わった可能性があります");
    turns.push(...(Array.isArray(r[0]) ? r[0] : []));
    const next = r[1] || null;
    if (!next) break;
    if (next === token) throw new ExportError("本文の取得", "同じ続きの目印が返りました。応答の形が変わった可能性があります");
    token = next;
  }
  if (!turns.length) throw new ExportError("本文の取得", "往復が1つも返りませんでした");
  return parseOwnConversation(turns, tabTitle(tab), info.gemId ? await gemName(tab.id, info.gemId) : null);
}

/** Gem の名前。取れなくても書き出しは続けたいので、失敗したら null を返す。 */
async function gemName(tabId, gemId) {
  try {
    const lang = (navigator.language || "ja").split("-")[0];
    const name = (await rpc(tabId, RPC_GEM, [gemId, [lang], 1, null, 1]))?.[0]?.[1]?.[0];
    return typeof name === "string" && name ? name : null;
  } catch {
    return null;
  }
}

/** タブのタイトルから会話のタイトルを取る。会話のタイトルが無ければ空文字。 */
function tabTitle(tab) {
  const title = (tab.title || "").replace(/\s*-\s*Google Gemini\s*$/, "").trim();
  return /^(Google )?Gemini$/.test(title) ? "" : title;
}

/** 画像を1枚取る。取れなければ理由の文字列を返す（例外は投げない）。 */
async function fetchImage(t) {
  if (!IMAGE_HOSTS.some((h) => t.url.startsWith(h))) return { error: "取得先が想定外です" };
  try {
    const res = await fetch(originalSizeUrl(t.url), { credentials: "include" });
    if (!res.ok) return { error: `HTTP ${res.status}` };
    return { data: new Uint8Array(await res.arrayBuffer()) };
  } catch (e) {
    return { error: e.message };
  }
}

/**
 * 画像を取得する。取れなかった画像は書き出しを止めずに警告にし、
 * paths には null を入れる（md には「画像を取得できませんでした」と書く）。
 */
async function downloadImages(conv, progress, warn) {
  // 1枚あたり0.5〜1秒かかるので、IMAGE_CONCURRENCY 枚ずつ同時に取る
  const targets = imageTargets(conv);
  const results = new Array(targets.length);
  let next = 0;
  let done = 0;
  const worker = async () => {
    while (next < targets.length) {
      const n = next++;
      results[n] = await fetchImage(targets[n]);
      progress(`画像を取得中… ${++done} / ${targets.length}`);
    }
  };
  await Promise.all(Array.from({ length: Math.min(IMAGE_CONCURRENCY, targets.length) }, worker));

  // zip 内の順番は往復の順にそろえる
  const paths = new Map();
  const files = [];
  targets.forEach((t, n) => {
    const { data, error } = results[n];
    if (!data) {
      paths.set(t.key, null);
      warn(`${t.key.split(":")[1]} 往復目の画像を取得できませんでした（${error}）`);
      return;
    }
    const rel = `images/${t.stem}.${imageExt(data, t.mime)}`;
    paths.set(t.key, rel);
    files.push({ name: rel, data });
  });
  return { paths, files };
}

async function save(blob, filename) {
  const url = URL.createObjectURL(blob);
  try {
    // 同じ名前のファイルがあれば「名前 (1).md」のように別名で保存する
    await chrome.downloads.download({ url, filename, conflictAction: "uniquify" });
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }
}

async function exportConversation(tab, info) {
  const status = $("status");
  // 取得中にポップアップが閉じると処理が止まるので、その旨を添える
  const progress = (text) => (status.textContent = `${text}\n保存が終わるまで、この画面を閉じないでください`);
  const warnings = [];
  const warn = (w) => warnings.push(w);

  const conv = await fetchConversation(tab, info, progress);
  $("title").textContent = conv.title;
  const { paths, files } = await downloadImages(conv, progress, warn);
  const md = buildMarkdown(conv, info.source, paths, warn);

  const stem = safeFilename(conv.title);
  const mdBytes = new TextEncoder().encode(md);
  if (files.length) {
    const zip = makeZip([{ name: `${stem}.md`, data: mdBytes }, ...files], new Date());
    await save(new Blob([zip], { type: "application/zip" }), `${stem}.zip`);
  } else {
    await save(new Blob([mdBytes], { type: "text/markdown" }), `${stem}.md`);
  }

  status.textContent = `保存しました（${conv.turns.length} 往復、画像 ${files.length} 枚）`;
  if (warnings.length) $("warnings").textContent = "注意：\n" + warnings.join("\n");
}

async function main() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const info = pageInfo(tab);
  if (!info) {
    $("title").textContent = "Gemini の会話を開いてから押してください";
    return;
  }
  $("title").textContent = tabTitle(tab) || "Gemini の会話";
  const button = $("save");
  button.disabled = false;
  button.addEventListener("click", async () => {
    button.disabled = true;
    $("status").classList.remove("error");
    $("warnings").textContent = "";
    try {
      await exportConversation(tab, info);
    } catch (e) {
      $("status").classList.add("error");
      $("status").textContent = `失敗しました ${e.message}`;
    } finally {
      button.disabled = false;
    }
  });
}

main();
