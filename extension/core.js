// Gemini の会話データを Markdown に整形する中心部分。
// gemini_md.py の解析・整形をそのまま移したもの。ブラウザにも Node にも依存しない。
// 出力が Python 版と同じかは tests/check_js.mjs で確かめる。

export const RPC_SHARE = "ujx1Bf"; // 共有された会話の本文
export const RPC_CHAT = "hNvQHb"; // 自分の会話の本文（新しい順、最大100往復ずつ）
export const RPC_GEM = "HcT8bb"; // Gem の情報（名前、説明、カスタム指示）

const IMAGE_EXT = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
};

export class ExportError extends Error {
  constructor(stage, message) {
    super(`[${stage}] ${message}`);
  }
}

// ------------------------------------------------------------------ 解析

/** 入れ子の配列を path の順にたどる。途中で無ければ null を返す。 */
export function dig(x, ...path) {
  for (const p of path) {
    if (x === null || x === undefined || typeof x !== "object") return null;
    x = x[p];
  }
  return x === undefined ? null : x;
}

/** 共有された会話（ujx1Bf の応答をほどいたもの）から会話の情報と往復の一覧を取り出す。 */
export function parseSharedConversation(inner) {
  try {
    const root = inner[0];
    const meta = root[2];
    return {
      title: meta[1],
      model: meta[7][2],
      gem: dig(meta, 6, 3), // Gem での会話なら Gem の名前
      own: false,
      published: new Date(root[4][0] * 1000),
      exported: null,
      turns: root[1].map(parseTurn),
    };
  } catch (e) {
    throw new ExportError("本文の解析", `応答の配列の形が想定と違います（${e}）。配列の位置が変わった可能性があります`);
  }
}

/**
 * 自分の会話（hNvQHb の応答の往復を集めたもの。新しい順）から会話の情報を作る。
 * title は画面から取ったタイトル。サイドバーに出ていない会話では画面にタイトルが無いので、
 * 空なら最初の質問の1行目を使う。gem は Gem での会話なら Gem の名前（HcT8bb の応答の [0][1][0]）。
 */
export function parseOwnConversation(turnsNewestFirst, title, gem = null) {
  try {
    const turns = [...turnsNewestFirst].reverse().map(parseTurn);
    const last = turnsNewestFirst[0];
    return {
      title: title || turnHeading(turns[0].question),
      model: dig(last, 3, 21) || "",
      gem,
      own: true,
      published: null,
      exported: new Date(),
      turns,
    };
  } catch (e) {
    throw new ExportError("本文の解析", `応答の配列の形が想定と違います（${e}）。配列の位置が変わった可能性があります`);
  }
}

function parseTurn(t) {
  const question = t[2][0][0];
  const candidate = t[3][0][0]; // 返ってくるのは選ばれている回答の1つだけ
  const answer = candidate[1][0];
  if (typeof question !== "string" || typeof answer !== "string") {
    throw new TypeError("質問か回答が文字列ではありません");
  }
  return {
    question,
    answer,
    attachments: (dig(t, 2, 0, 4, 0, 3) || []).map((f) => ({ name: f[2], url: f[3], mime: f[11] })),
    generated: parseGeneratedImages(candidate),
    documents: parseDocuments(candidate),
    plans: parseResearchPlans(t),
    actionCards: parseActionCards(candidate),
    maps: parseMaps(candidate),
    places: parsePlaces(candidate),
    music: parseMusic(candidate),
  };
}

/** Gemini が生成した画像。本文には目印（image_generation_content/…）だけがある。 */
function parseGeneratedImages(candidate) {
  const images = [];
  for (const img of dig(candidate, 12, 7, 0) || []) {
    const url = dig(img, 0, 3, 3);
    const marker = dig(img, 1, 0);
    if (typeof url === "string" && typeof marker === "string") images.push({ url, marker });
  }
  return images;
}

/**
 * Canvas と Deep Research の報告書。本文には目印（immersive_entry_chip/N）だけがある。
 * 共有されるのは最終版だけで、途中の往復にも最終版が入っている。
 */
function parseDocuments(candidate) {
  const docs = [];
  for (const d of dig(candidate, 30) || []) {
    const content = dig(d, 4);
    if (typeof content !== "string") continue;
    docs.push({
      id: dig(d, 0),
      title: dig(d, 2) || "",
      kind: dig(d, 10) === 3 ? "Deep Research の報告書" : "Canvas",
      content,
      sources: parseSources(dig(d, 5, 0, "44")),
    });
  }
  return docs;
}

/** Deep Research の出典番号 → [URL, 題名]。 */
function parseSources(items) {
  const sources = new Map();
  for (const item of items || []) {
    const nums = ((dig(item, 0, 0) || "").match(/\d+/g) || []).map(Number);
    const found = [];
    const walk = (x) => {
      // [ファビコンのURL, ページのURL, 題名, …] の形を探す
      if (!Array.isArray(x)) return;
      if (x.length >= 3 && typeof x[0] === "string" && x[0].includes("faviconV2") && typeof x[1] === "string") {
        found.push([x[1], x[2] || x[1]]);
        return;
      }
      x.forEach(walk);
    };
    walk(dig(item, 1));
    nums.forEach((n, i) => {
      if (i < found.length && !sources.has(n)) sources.set(n, found[i]);
    });
  }
  return sources;
}

/**
 * カレンダー登録など、Google のアプリを操作した結果のカード。
 * 本文には目印（action_card_content/N）だけがある。カードのリンクは利用者本人の
 * 予定などを指し、アカウントを特定できる情報を含むので出力しない。
 */
function parseActionCards(candidate) {
  const groups = dig(candidate, 12, 8);
  if (!groups || Array.isArray(groups) || typeof groups !== "object") return [];
  const cards = [];
  for (const group of Object.values(groups)) {
    for (const card of Array.isArray(group) ? group : []) {
      const marker = dig(card, 0, 0);
      if (!(typeof marker === "string" && marker.includes("action_card_content"))) continue;
      const appUrl = dig(card, 0, 6, 2) || "";
      const service = appUrl.includes("calendar") ? "Google カレンダー" : "Google のアプリ";
      // 日時などの説明文（例：「3月 5日 (水曜日) • 10:00～11:00」）。カードの中の辞書形式の
      // 要素にある。位置は共有ページでは [7]、自分の会話では [5] や [1] と一定しない
      const details = card
        .filter((e) => e && typeof e === "object" && !Array.isArray(e))
        .flatMap((e) => Object.values(e).map((v) => dig(v, 1, 0, 4)));
      const detail = details.find((d) => typeof d === "string") || null;
      cards.push({ marker, service, detail });
    }
  }
  return cards;
}

/** Google マップの地図。本文には目印（map_content/N）だけがある。 */
function parseMaps(candidate) {
  const maps = [];
  for (const m of dig(candidate, 12, 0, 4) || []) {
    const marker = dig(m, 2, 0);
    if (typeof marker === "string") maps.push({ marker, title: dig(m, 2, 2) || "" });
  }
  return maps;
}

/** 地名のリンク先。本文では [東京タワー](目印 map_location_reference/N) の形で使われる。 */
function parsePlaces(candidate) {
  const places = [];
  for (const p of dig(candidate, 12, 0, 81) || []) {
    const marker = dig(p, 1, 0);
    if (typeof marker !== "string") continue;
    let url = dig(p, 5, 3, 14);
    const placeId = dig(p, 2, 0);
    if (!(typeof url === "string" && url.startsWith("http")) && placeId) {
      url = `https://www.google.com/maps/place/?q=place_id:${placeId}`;
    }
    places.push({ marker, url });
  }
  return places;
}

/** Gemini が作成した曲。本文には目印（generated_music_content/N）だけがある。 */
function parseMusic(candidate) {
  const m = dig(candidate, 12, 0, 87);
  const title = dig(m, 2, 0);
  if (typeof title !== "string") return null;
  return { title, genre: dig(m, 2, 4) };
}

/** Deep Research の調査計画。本文には目印（deep_research_confirmation_content/N）だけがある。 */
function parseResearchPlans(t) {
  const plans = new Map();
  for (const p of dig(t, 3, 12, 0, 0, 1, 27) || []) {
    const marker = dig(p, 4, 0);
    if (typeof marker !== "string") continue;
    const steps = (dig(p, 1) || []).map((s) => [dig(s, 1) || "", dig(s, 2) || ""]);
    plans.set(marker, { title: dig(p, 0) || "", steps });
  }
  return plans;
}

// ------------------------------------------------------------------ 整形

const MARKER = /http:\/\/googleusercontent\.com\/[\p{L}\p{N}_]+\/[\p{L}\p{N}_-]+/gu;

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function stripNewlines(s) {
  return s.replace(/^\n+|\n+$/g, "");
}

/** 本文中の目印を、前後に空行を付けて置き換える。目印が無ければ append に従い末尾に足す。 */
function putMarker(text, marker, replacement, append = true) {
  const pattern = new RegExp(String.raw`\s*` + escapeRegExp(marker) + String.raw`[ \t]*(\n|$)`, "g");
  if (pattern.test(text)) {
    pattern.lastIndex = 0;
    return stripNewlines(text.replace(pattern, () => `\n\n${replacement}\n\n`));
  }
  return append ? `${text}\n\n${replacement}` : text;
}

function renderAnswer(i, turn, imagePaths, docLastTurn, warn) {
  // 引用の目印を消す。改行は残す（出典の対応が共有されていないため）
  let text = turn.answer.replaceAll("[cite_start]", "");
  text = text.replace(/[ \t]*\[cite: [^\]]*\]/g, "");
  // 埋め込み動画の目印を消す（同じ回答内に本物のリンクがある）
  text = text.replace(/\n?http:\/\/googleusercontent\.com\/youtube_content\/\d+/g, "");

  turn.generated.forEach((img, k) => {
    const key = imageKey("gemini", i, k + 1);
    const rel = imagePaths.get(key);
    if (rel) text = putMarker(text, img.marker, `![](${rel})`);
    else if (imagePaths.has(key)) text = putMarker(text, img.marker, "*（画像を取得できませんでした）*");
  });

  turn.documents.forEach((doc, n) => {
    const last = docLastTurn.get(doc.id);
    const block =
      last === i ? renderDocument(doc) : `*${doc.kind}「${doc.title}」（最終版は ${last} 往復目に掲載）*`;
    text = putMarker(text, `http://googleusercontent.com/immersive_entry_chip/${n}`, block);
  });

  for (const [marker, plan] of turn.plans) {
    text = putMarker(text, marker, renderPlan(plan));
  }

  for (const card of turn.actionCards) {
    const detail = card.detail ? `：${card.detail}` : "";
    // 登録前の下書きのカードは本文に目印が無いので、足さない
    text = putMarker(text, card.marker, `*（${card.service}で操作${detail}）*`, false);
  }

  for (const m of turn.maps) {
    // 本文で使われない地図（地名ごとの小さな地図）は足さない
    text = putMarker(text, m.marker, `*（Google マップ：${m.title}）*`, false);
  }

  for (const p of turn.places) {
    if (p.url) text = text.replaceAll(`(${p.marker})`, `(${p.url})`);
  }

  if (turn.music) {
    const genre = turn.music.genre ? `（${turn.music.genre}）` : "";
    text = text.replace(
      /http:\/\/googleusercontent\.com\/generated_music_content\/\d+/g,
      () => `*（Gemini が作成した曲：${turn.music.title}${genre}）*`,
    );
  }

  for (const m of [...new Set(text.match(MARKER) || [])].sort()) {
    warn(`${i} 往復目に未対応の目印があります: ${m}`);
  }

  return shiftHeadings(text, 3).trim();
}

function renderDocument(doc) {
  let content = doc.content.replaceAll("[cite_start]", "");
  // 出典の対応が取れるので、番号として残す
  content = content.replace(/[ \t]*\[cite: ([^\]]*)\]/g, " [$1]");
  const parts = [`**${doc.kind}：${doc.title}**`, content.trim()];
  if (doc.sources.size) {
    const lines = [...doc.sources.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([n, [url, title]]) => `${n}. [${escapeLinkText(title)}](${url})`);
    parts.push("**出典**\n\n" + lines.join("\n"));
  }
  return parts.join("\n\n");
}

function renderPlan(plan) {
  const lines = [`**Deep Research の調査計画：${plan.title}**`, ""];
  plan.steps.forEach(([label, detail], n) => {
    lines.push(`${n + 1}. ${label}`);
    for (const d of detail ? detail.split("\n") : []) lines.push(`    - ${d}`);
  });
  return lines.join("\n");
}

function escapeLinkText(text) {
  return text.replaceAll("[", "\\[").replaceAll("]", "\\]");
}

/**
 * いちばん上の見出しが top 段になるように、回答内の見出しをずらす。
 * コードブロックの中の「#」（コメントなど）は見出しとみなさない。
 */
export function shiftHeadings(text, top) {
  const lines = text.split("\n");
  const inCode = [];
  let fenced = false;
  for (const line of lines) {
    if (line.trimStart().startsWith("```")) {
      fenced = !fenced;
      inCode.push(true);
    } else {
      inCode.push(fenced);
    }
  }

  const heading = /^(#{1,6}) /;
  const levels = [];
  lines.forEach((line, j) => {
    const m = !inCode[j] && line.match(heading);
    if (m) levels.push(m[1].length);
  });
  if (!levels.length) return text;
  const shift = top - Math.min(...levels);

  return lines
    .map((line, j) => {
      const m = !inCode[j] && line.match(heading);
      if (!m) return line;
      const level = Math.min(6, m[1].length + shift);
      return "#".repeat(level) + line.slice(m[1].length);
    })
    .join("\n");
}

function turnHeading(question, limit = 30) {
  const first = question.split("\n").map((l) => l.trim()).find((l) => l) || "";
  if (!first) return "（本文なし）";
  const chars = Array.from(first); // 絵文字などを1文字として数える
  return chars.length <= limit ? first : chars.slice(0, limit).join("") + "…";
}

function quote(text) {
  return text.split("\n").map((line) => (line ? `> ${line}` : ">")).join("\n");
}

function formatDate(d) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function imageKey(kind, i, k) {
  return `${kind}:${i}:${k}`;
}

/**
 * 会話を Markdown にする。
 * imagePaths: imageKey(種類, 往復番号, 番号) → md から見た画像の相対パス
 * warn: 未対応の目印などを知らせる関数
 */
export function buildMarkdown(conv, sourceUrl, imagePaths = new Map(), warn = () => {}) {
  // 同じ Canvas・報告書は、最後に出てくる往復に1回だけ載せる
  const docLastTurn = new Map();
  conv.turns.forEach((turn, idx) => {
    for (const doc of turn.documents) docLastTurn.set(doc.id, idx + 1);
  });

  let header =
    "---\n" +
    `title: ${JSON.stringify(conv.title)}\n` +
    `source: ${sourceUrl}\n` +
    `model: ${JSON.stringify(conv.model)}\n`;
  if (conv.gem) header += `gem: ${JSON.stringify(conv.gem)}\n`;
  if (conv.published) header += `published: ${formatDate(conv.published)}\n`;
  if (conv.exported) header += `exported: ${formatDate(conv.exported)}\n`;
  header += "---\n\n" + `# ${conv.title}\n`;

  // 添付の中身は、共有ページでも自分の会話でも取れない（画像を除く）
  const noContent = conv.own ? "ファイルの中身は書き出せません" : "本文は共有されていません";

  const parts = [header];
  conv.turns.forEach((turn, idx) => {
    const i = idx + 1;
    const block = [`## ${i}. ${turnHeading(turn.question)}\n`, "> **ユーザー**", quote(turn.question)];
    turn.attachments.forEach((att, k) => {
      block.push(">");
      const key = imageKey("user", i, k + 1);
      const rel = imagePaths.get(key);
      // imagePaths に null が入っているのは、画像だが取得に失敗したもの
      const note = imagePaths.has(key) ? "画像を取得できませんでした" : noContent;
      block.push(rel ? `> ![](${rel})` : `> *添付：${att.name}（${note}）*`);
    });
    block.push(`\n**Gemini**\n\n${renderAnswer(i, turn, imagePaths, docLastTurn, warn)}\n`);
    parts.push(block.join("\n"));
  });
  return parts.join("\n");
}

// ------------------------------------------------------------------ 画像・ファイル

/** 取得する画像の一覧。名前はユーザーの添付が「01-1」、生成画像が「01-gemini-1」。 */
export function imageTargets(conv) {
  const targets = [];
  conv.turns.forEach((turn, idx) => {
    const i = idx + 1;
    const nn = String(i).padStart(2, "0");
    turn.attachments.forEach((att, k) => {
      targets.push({ key: imageKey("user", i, k + 1), url: att.url, mime: att.mime, stem: `${nn}-${k + 1}` });
    });
    turn.generated.forEach((img, k) => {
      targets.push({ key: imageKey("gemini", i, k + 1), url: img.url, mime: null, stem: `${nn}-gemini-${k + 1}` });
    });
  });
  return targets.filter((t) => typeof t.url === "string" && t.url.startsWith("http"));
}

/** 末尾に「=s0」を付けると縮小されていない原寸の画像が返る */
export function originalSizeUrl(url) {
  return url.replace(/=[^/=]*$/, "") + "=s0";
}

/** 添付情報の MIME型は実際の形式と食い違うことがあるので、中身から判定する */
export function imageExt(bytes, mime) {
  const b = bytes;
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "png";
  if (b[0] === 0xff && b[1] === 0xd8) return "jpg";
  const head = String.fromCharCode(...b.slice(0, 12));
  if (head.startsWith("GIF87a") || head.startsWith("GIF89a")) return "gif";
  if (head.startsWith("RIFF") && head.slice(8, 12) === "WEBP") return "webp";
  return IMAGE_EXT[mime] || "bin";
}

const MAX_FILENAME_BYTES = 150; // 拡張子を足しても多くのファイルシステムの上限（255バイト）に収まる長さ

/** 会話のタイトルを、どの OS でも保存できるファイル名にする（拡張子は含まない）。 */
export function safeFilename(name) {
  let s = name.replace(/[\\/:*?"<>|\x00-\x1f\x7f]/g, "_").replace(/^[ .]+|[ .]+$/g, "");
  // UTF-8 で上限を超えないよう、文字の途中で切らずに縮める
  const enc = new TextEncoder();
  const chars = Array.from(s);
  while (chars.length && enc.encode(chars.join("")).length > MAX_FILENAME_BYTES) chars.pop();
  s = chars.join("").replace(/[ .]+$/, "");
  // Windows で使えない名前（CON、NUL、COM1 など）は末尾に _ を付ける
  if (/^(con|prn|aux|nul|com\d|lpt\d)$/i.test(s)) s += "_";
  return s || "gemini";
}

// ------------------------------------------------------------------ zip

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * 圧縮しない zip を作る（画像はすでに圧縮されているため）。
 * files: [{ name, data: Uint8Array }]。名前は UTF-8 として印を付ける。
 * date: 各ファイルの更新日時（zip の形式上、2秒単位）
 */
export function makeZip(files, date = new Date()) {
  const enc = new TextEncoder();
  // MS-DOS 形式の日時。1980年より前は表せない
  const dosTime = (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1);
  const dosDate = ((Math.max(date.getFullYear(), 1980) - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const { name, data } of files) {
    const nameBytes = enc.encode(name);
    const crc = crc32(data);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true); // 展開に必要な版
    local.setUint16(6, 0x0800, true); // 名前は UTF-8
    local.setUint16(8, 0, true); // 無圧縮
    local.setUint16(10, dosTime, true);
    local.setUint16(12, dosDate, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, data.length, true);
    local.setUint32(22, data.length, true);
    local.setUint16(26, nameBytes.length, true);
    chunks.push(new Uint8Array(local.buffer), nameBytes, data);

    const entry = new DataView(new ArrayBuffer(46));
    entry.setUint32(0, 0x02014b50, true);
    entry.setUint16(4, 20, true);
    entry.setUint16(6, 20, true);
    entry.setUint16(8, 0x0800, true);
    entry.setUint16(10, 0, true);
    entry.setUint16(12, dosTime, true);
    entry.setUint16(14, dosDate, true);
    entry.setUint32(16, crc, true);
    entry.setUint32(20, data.length, true);
    entry.setUint32(24, data.length, true);
    entry.setUint16(28, nameBytes.length, true);
    entry.setUint32(42, offset, true);
    central.push(new Uint8Array(entry.buffer), nameBytes);

    offset += 30 + nameBytes.length + data.length;
  }
  const centralSize = central.reduce((s, c) => s + c.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, files.length, true);
  end.setUint16(10, files.length, true);
  end.setUint32(12, centralSize, true);
  end.setUint32(16, offset, true);

  const all = [...chunks, ...central, new Uint8Array(end.buffer)];
  const out = new Uint8Array(all.reduce((s, c) => s + c.length, 0));
  let pos = 0;
  for (const c of all) {
    out.set(c, pos);
    pos += c.length;
  }
  return out;
}
