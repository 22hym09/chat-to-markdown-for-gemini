"""Gemini の共有リンクから会話全体を Markdown に書き出す。

使い方:
    python3 gemini_md.py <共有リンク> [-o 出力先]

画像の添付がない会話は .md を、ある会話は .md と images/ をまとめた .zip を書き出す。
出力先の既定はこのスクリプトの隣の output/。
"""

import argparse
import datetime
import io
import json
import re
import sys
import urllib.parse
import urllib.request
import zipfile
from pathlib import Path

USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/130.0 Safari/537.36"
)
RPC_ID = "ujx1Bf"  # 共有された会話の本文を返す rpcid
BATCH_URL = "https://gemini.google.com/_/BardChatUi/data/batchexecute"
TIMEOUT = 30
IMAGE_EXT = {
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
    "image/gif": "gif",
}


class ExportError(Exception):
    """どの段階で失敗したかを添えて利用者に伝えるための例外。"""

    def __init__(self, stage, message):
        super().__init__(f"[{stage}] {message}")


# ---------------------------------------------------------------- 取得


def http_get(url):
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=TIMEOUT) as res:
        return res.geturl(), res.read()


def fetch_share_page(url):
    """共有リンクを開き、共有ID と通信に必要な値（bl, f.sid）を得る。"""
    try:
        final_url, body = http_get(url)
    except Exception as e:
        raise ExportError("共有ページの取得", f"{url} を開けませんでした: {e}")

    m = re.search(r"/share/([0-9A-Za-z]+)", urllib.parse.urlparse(final_url).path)
    if not m:
        raise ExportError("共有ページの取得", f"転送先 {final_url} から共有ID を読み取れませんでした")
    share_id = m.group(1)

    html = body.decode("utf-8", errors="replace")
    params = {}
    for key, name in (("cfb2h", "bl"), ("FdrFJe", "f.sid")):
        mm = re.search(rf'"{key}":"([^"]*)"', html)
        if not mm:
            raise ExportError("共有ページの解析", f"ページ内に {key}（{name}）が見つかりませんでした")
        params[name] = mm.group(1)
    return share_id, params


def fetch_conversation(share_id, params):
    """batchexecute に rpcid を送り、二重構造をほどいた配列（inner）を返す。"""
    query = urllib.parse.urlencode({
        "rpcids": RPC_ID,
        "source-path": f"/share/{share_id}",
        "bl": params["bl"],
        "f.sid": params["f.sid"],
        "hl": "ja",
        "_reqid": "100000",
        "rt": "c",
    })
    f_req = json.dumps([[[RPC_ID, json.dumps([None, share_id]), None, "generic"]]])
    data = urllib.parse.urlencode({"f.req": f_req}).encode()
    req = urllib.request.Request(
        f"{BATCH_URL}?{query}",
        data=data,
        headers={
            "User-Agent": USER_AGENT,
            "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as res:
            raw = res.read().decode("utf-8")
    except Exception as e:
        raise ExportError("本文の取得", f"batchexecute への要求が失敗しました: {e}")

    # 応答は「)]}'」の後に「文字数の行」と「JSON の行」が交互に並ぶ
    for line in raw.splitlines():
        if not line.startswith("["):
            continue
        try:
            chunk = json.loads(line)
        except json.JSONDecodeError:
            continue
        for entry in chunk:
            if isinstance(entry, list) and entry[:2] == ["wrb.fr", RPC_ID]:
                if entry[2] is None:
                    raise ExportError(
                        "本文の取得",
                        "本文が空で返りました。共有が取り消されたか、rpcid・引数の形が変わった可能性があります",
                    )
                return json.loads(entry[2])
    raise ExportError("本文の取得", f"応答の中に {RPC_ID} の結果が見つかりませんでした")


# ---------------------------------------------------------------- 解析


def dig(x, *path):
    """入れ子の配列を path の順にたどる。途中で無ければ None を返す。"""
    for p in path:
        try:
            x = x[p]
        except (IndexError, KeyError, TypeError):
            return None
    return x


def parse_conversation(inner):
    """inner から会話の情報と往復の一覧を取り出す。"""
    try:
        root = inner[0]
        meta = root[2]
        conv = {
            "title": meta[1],
            "model": meta[7][2],
            "gem": dig(meta, 6, 3),  # Gem での会話なら Gem の名前
            "published": datetime.datetime.fromtimestamp(root[4][0]),
            "turns": [],
        }
        for t in root[1]:
            question = t[2][0][0]
            candidate = t[3][0][0]  # 共有されるのは選ばれていた回答の1つだけ
            answer = candidate[1][0]
            conv["turns"].append({
                "question": question,
                "answer": answer,
                "attachments": [
                    {"name": f[2], "url": f[3], "mime": f[11]}
                    for f in dig(t, 2, 0, 4, 0, 3) or []
                ],
                "generated": parse_generated_images(candidate),
                "documents": parse_documents(candidate),
                "plans": parse_research_plans(t),
                "action_cards": parse_action_cards(candidate),
                "maps": parse_maps(candidate),
                "places": parse_places(candidate),
                "music": parse_music(candidate),
            })
    except (IndexError, TypeError, KeyError) as e:
        raise ExportError("本文の解析", f"応答の配列の形が想定と違います（{e!r}）。配列の位置が変わった可能性があります")
    return conv


def parse_generated_images(candidate):
    """Gemini が生成した画像。本文には目印（image_generation_content/…）だけがある。"""
    images = []
    for img in dig(candidate, 12, 7, 0) or []:
        url, marker = dig(img, 0, 3, 3), dig(img, 1, 0)
        if isinstance(url, str) and isinstance(marker, str):
            images.append({"url": url, "marker": marker})
    return images


def parse_documents(candidate):
    """Canvas と Deep Research の報告書。本文には目印（immersive_entry_chip/N）だけがある。

    共有されるのは最終版だけで、途中の往復にも最終版が入っている。
    """
    docs = []
    for d in dig(candidate, 30) or []:
        content = dig(d, 4)
        if not isinstance(content, str):
            continue
        docs.append({
            "id": dig(d, 0),
            "title": dig(d, 2) or "",
            "kind": "Deep Research の報告書" if dig(d, 10) == 3 else "Canvas",
            "content": content,
            "sources": parse_sources(dig(d, 5, 0, "44")),
        })
    return docs


def parse_sources(items):
    """Deep Research の出典番号 → (URL, 題名)。"""
    sources = {}
    for item in items or []:
        nums = [int(n) for n in re.findall(r"\d+", dig(item, 0, 0) or "")]
        found = []

        def walk(x):
            # [ファビコンのURL, ページのURL, 題名, …] の形を探す
            if not isinstance(x, list):
                return
            if len(x) >= 3 and isinstance(x[0], str) and "faviconV2" in x[0] and isinstance(x[1], str):
                found.append((x[1], x[2] or x[1]))
                return
            for y in x:
                walk(y)

        walk(dig(item, 1))
        for n, src in zip(nums, found):
            sources.setdefault(n, src)
    return sources


def parse_action_cards(candidate):
    """カレンダー登録など、Google のアプリを操作した結果のカード。

    本文には目印（action_card_content/N）だけがある。カードのリンクは利用者本人の
    予定などを指し、アカウントを特定できる情報を含むので出力しない。
    """
    groups = dig(candidate, 12, 8)
    if not isinstance(groups, dict):
        return []
    cards = []
    for group in groups.values():
        for card in group if isinstance(group, list) else []:
            marker = dig(card, 0, 0)
            if not (isinstance(marker, str) and "action_card_content" in marker):
                continue
            app_url = dig(card, 0, 6, 2) or ""
            service = "Google カレンダー" if "calendar" in app_url else "Google のアプリ"
            # 日時などの説明文（例：「3月 5日 (水曜日) • 10:00～11:00」）。カードの中の辞書形式の
            # 要素にある。位置は共有ページでは [7]、自分の会話では [5] や [1] と一定しない
            details = [
                dig(v, 1, 0, 4)
                for e in card if isinstance(e, dict)
                for v in e.values()
            ]
            detail = next((d for d in details if isinstance(d, str)), None)
            cards.append({"marker": marker, "service": service, "detail": detail})
    return cards


def parse_maps(candidate):
    """Google マップの地図。本文には目印（map_content/N）だけがある。"""
    maps = []
    for m in dig(candidate, 12, 0, 4) or []:
        marker, title = dig(m, 2, 0), dig(m, 2, 2)
        if isinstance(marker, str):
            maps.append({"marker": marker, "title": title or ""})
    return maps


def parse_places(candidate):
    """地名のリンク先。本文では [東京タワー](目印 map_location_reference/N) の形で使われる。"""
    places = []
    for p in dig(candidate, 12, 0, 81) or []:
        marker = dig(p, 1, 0)
        if not isinstance(marker, str):
            continue
        url = dig(p, 5, 3, 14)
        place_id = dig(p, 2, 0)
        if not (isinstance(url, str) and url.startswith("http")) and place_id:
            url = f"https://www.google.com/maps/place/?q=place_id:{place_id}"
        places.append({"marker": marker, "url": url})
    return places


def parse_music(candidate):
    """Gemini が作成した曲。本文には目印（generated_music_content/N）だけがある。"""
    m = dig(candidate, 12, 0, 87)
    title = dig(m, 2, 0)
    if not isinstance(title, str):
        return None
    return {"title": title, "genre": dig(m, 2, 4)}


def parse_research_plans(t):
    """Deep Research の調査計画。本文には目印（deep_research_confirmation_content/N）だけがある。"""
    plans = {}
    for p in dig(t, 3, 12, 0, 0, 1, 27) or []:
        marker = dig(p, 4, 0)
        if not isinstance(marker, str):
            continue
        steps = [(dig(s, 1) or "", dig(s, 2) or "") for s in dig(p, 1) or []]
        plans[marker] = {"title": dig(p, 0) or "", "steps": steps}
    return plans


# ---------------------------------------------------------------- 整形


MARKER = re.compile(r"http://googleusercontent\.com/\w+/[\w-]+")


def warn(message):
    print(f"注意：{message}", file=sys.stderr)


def put_marker(text, marker, replacement, append=True):
    """本文中の目印を、前後に空行を付けて置き換える。目印が無ければ append に従い末尾に足す。"""
    pattern = re.compile(r"\s*" + re.escape(marker) + r"[ \t]*(\n|$)")
    if pattern.search(text):
        return pattern.sub(lambda _: f"\n\n{replacement}\n\n", text).strip("\n")
    return f"{text}\n\n{replacement}" if append else text


def render_answer(i, turn, image_paths, doc_last_turn):
    # 引用の目印を消す。改行は残す（出典の対応が共有されていないため）
    text = turn["answer"].replace("[cite_start]", "")
    text = re.sub(r"[ \t]*\[cite: [^\]]*\]", "", text)
    # 埋め込み動画の目印を消す（同じ回答内に本物のリンクがある）
    text = re.sub(r"\n?http://googleusercontent\.com/youtube_content/\d+", "", text)

    for k, img in enumerate(turn["generated"], 1):
        rel = image_paths.get(("gemini", i, k))
        if rel:
            text = put_marker(text, img["marker"], f"![]({rel})")

    for n, doc in enumerate(turn["documents"]):
        last = doc_last_turn[doc["id"]]
        if last == i:
            block = render_document(doc)
        else:
            block = f"*{doc['kind']}「{doc['title']}」（最終版は {last} 往復目に掲載）*"
        text = put_marker(text, f"http://googleusercontent.com/immersive_entry_chip/{n}", block)

    for marker, plan in turn["plans"].items():
        text = put_marker(text, marker, render_plan(plan))

    for card in turn["action_cards"]:
        detail = f"：{card['detail']}" if card["detail"] else ""
        # 登録前の下書きのカードは本文に目印が無いので、足さない
        text = put_marker(text, card["marker"], f"*（{card['service']}で操作{detail}）*", append=False)

    for m in turn["maps"]:
        # 本文で使われない地図（地名ごとの小さな地図）は足さない
        text = put_marker(text, m["marker"], f"*（Google マップ：{m['title']}）*", append=False)

    for p in turn["places"]:
        if p["url"]:
            text = text.replace(f"({p['marker']})", f"({p['url']})")

    if turn["music"]:
        genre = f"（{turn['music']['genre']}）" if turn["music"]["genre"] else ""
        text = re.sub(
            r"http://googleusercontent\.com/generated_music_content/\d+",
            lambda _: f"*（Gemini が作成した曲：{turn['music']['title']}{genre}）*",
            text,
        )

    for m in sorted(set(MARKER.findall(text))):
        warn(f"{i} 往復目に未対応の目印があります: {m}")

    return shift_headings(text, top=3).strip()


def render_document(doc):
    content = doc["content"].replace("[cite_start]", "")
    # 出典の対応が取れるので、番号として残す
    content = re.sub(r"[ \t]*\[cite: ([^\]]*)\]", r" [\1]", content)
    parts = [f"**{doc['kind']}：{doc['title']}**", content.strip()]
    if doc["sources"]:
        lines = [
            f"{n}. [{escape_link_text(title)}]({url})"
            for n, (url, title) in sorted(doc["sources"].items())
        ]
        parts.append("**出典**\n\n" + "\n".join(lines))
    return "\n\n".join(parts)


def render_plan(plan):
    lines = [f"**Deep Research の調査計画：{plan['title']}**", ""]
    for n, (label, detail) in enumerate(plan["steps"], 1):
        lines.append(f"{n}. {label}")
        for d in detail.split("\n") if detail else []:
            lines.append(f"    - {d}")
    return "\n".join(lines)


def escape_link_text(text):
    return text.replace("[", r"\[").replace("]", r"\]")


def shift_headings(text, top):
    """いちばん上の見出しが top 段になるように、回答内の見出しをずらす。

    コードブロックの中の「#」（コメントなど）は見出しとみなさない。
    """
    lines = text.split("\n")
    in_code = []
    fenced = False
    for line in lines:
        if line.lstrip().startswith("```"):
            fenced = not fenced
            in_code.append(True)
        else:
            in_code.append(fenced)

    heading = re.compile(r"^(#{1,6}) ")
    levels = [
        len(m.group(1))
        for line, code in zip(lines, in_code)
        if not code and (m := heading.match(line))
    ]
    if not levels:
        return text
    shift = top - min(levels)

    out = []
    for line, code in zip(lines, in_code):
        m = None if code else heading.match(line)
        if m:
            level = min(6, len(m.group(1)) + shift)
            line = "#" * level + line[len(m.group(1)):]
        out.append(line)
    return "\n".join(out)


def turn_heading(question, limit=30):
    first = next((line.strip() for line in question.split("\n") if line.strip()), "")
    if not first:
        return "（本文なし）"
    return first if len(first) <= limit else first[:limit] + "…"


def quote(text):
    return "\n".join(f"> {line}" if line else ">" for line in text.split("\n"))


def build_markdown(conv, source_url, image_paths):
    """image_paths: (種類, 往復番号, 番号) → md から見た画像の相対パス"""
    # 同じ Canvas・報告書は、最後に出てくる往復に1回だけ載せる
    doc_last_turn = {}
    for i, turn in enumerate(conv["turns"], 1):
        for doc in turn["documents"]:
            doc_last_turn[doc["id"]] = i

    published = conv["published"].strftime("%Y-%m-%d %H:%M")
    parts = [
        "---\n"
        f"title: {json.dumps(conv['title'], ensure_ascii=False)}\n"
        f"source: {source_url}\n"
        f"model: {json.dumps(conv['model'], ensure_ascii=False)}\n"
        + (f"gem: {json.dumps(conv['gem'], ensure_ascii=False)}\n" if conv["gem"] else "")
        + f"published: {published}\n"
        "---\n\n"
        f"# {conv['title']}\n"
    ]
    for i, turn in enumerate(conv["turns"], 1):
        block = [f"## {i}. {turn_heading(turn['question'])}\n", "> **ユーザー**", quote(turn["question"])]
        for k, att in enumerate(turn["attachments"], 1):
            block.append(">")
            if ("user", i, k) in image_paths:
                block.append(f"> ![]({image_paths[('user', i, k)]})")
            else:
                block.append(f"> *添付：{att['name']}（本文は共有されていません）*")
        block.append(f"\n**Gemini**\n\n{render_answer(i, turn, image_paths, doc_last_turn)}\n")
        parts.append("\n".join(block))
    return "\n".join(parts)


# ---------------------------------------------------------------- 書き出し


MAX_FILENAME_BYTES = 150  # 拡張子を足しても多くのファイルシステムの上限（255バイト）に収まる長さ


def safe_filename(name):
    """会話のタイトルを、どの OS でも保存できるファイル名にする（拡張子は含まない）。"""
    name = re.sub(r'[\\/:*?"<>|\x00-\x1f\x7f]', "_", name).strip(" .")
    # UTF-8 で上限を超えないよう、文字の途中で切らずに縮める
    while len(name.encode("utf-8")) > MAX_FILENAME_BYTES:
        name = name[:-1]
    name = name.rstrip(" .")
    # Windows で使えない名前（CON、NUL、COM1 など）は末尾に _ を付ける
    if re.fullmatch(r"(con|prn|aux|nul|com\d|lpt\d)", name, re.IGNORECASE):
        name += "_"
    return name or "gemini"


def original_size_url(url):
    # 末尾に「=s0」を付けると縮小されていない原寸の画像が返る
    return re.sub(r"=[^/=]*$", "", url) + "=s0"


def image_ext(data, mime):
    # 添付情報の MIME型は実際の形式と食い違うことがあるので、中身から判定する
    if data.startswith(b"\x89PNG"):
        return "png"
    if data.startswith(b"\xff\xd8"):
        return "jpg"
    if data[:6] in (b"GIF87a", b"GIF89a"):
        return "gif"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "webp"
    return IMAGE_EXT.get(mime, "bin")


def download_images(conv):
    """ユーザーの添付画像と Gemini の生成画像を取得する。

    返り値: ({(種類, i, k): 相対パス}, {相対パス: バイト列})
    名前はユーザーの添付が「01-1.jpg」、生成画像が「01-gemini-1.jpg」。
    """
    targets = []
    for i, turn in enumerate(conv["turns"], 1):
        for k, att in enumerate(turn["attachments"], 1):
            targets.append((("user", i, k), att["url"], att["mime"], f"{i:02d}-{k}"))
        for k, img in enumerate(turn["generated"], 1):
            targets.append((("gemini", i, k), img["url"], None, f"{i:02d}-gemini-{k}"))

    paths, blobs = {}, {}
    for key, url, mime, stem in targets:
        if not (isinstance(url, str) and url.startswith("http")):
            continue
        try:
            _, data = http_get(original_size_url(url))
        except Exception as e:
            raise ExportError("画像の取得", f"{key[1]} 往復目の画像を取得できませんでした: {e}")
        rel = f"images/{stem}.{image_ext(data, mime)}"
        blobs[rel] = data
        paths[key] = rel
    return paths, blobs


def export(url, out_dir):
    share_id, params = fetch_share_page(url)
    conv = parse_conversation(fetch_conversation(share_id, params))
    image_paths, blobs = download_images(conv)
    md = build_markdown(conv, url, image_paths)

    out_dir.mkdir(parents=True, exist_ok=True)
    stem = safe_filename(conv["title"])
    if not blobs:
        path = out_dir / f"{stem}.md"
        path.write_text(md, encoding="utf-8")
    else:
        path = out_dir / f"{stem}.zip"
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
            z.writestr(f"{stem}.md", md)
            for rel, data in blobs.items():
                z.writestr(rel, data)
        path.write_bytes(buf.getvalue())
    return path, conv, len(blobs)


def main():
    parser = argparse.ArgumentParser(description="Gemini の共有リンクから会話を Markdown に書き出す")
    parser.add_argument("url", help="共有リンク（share.gemini.google/… または gemini.google.com/share/…）")
    parser.add_argument(
        "-o", "--out",
        default=Path(__file__).resolve().parent / "output",
        help="出力先のフォルダ（既定：このスクリプトの隣の output/）",
    )
    args = parser.parse_args()

    try:
        path, conv, n_images = export(args.url, Path(args.out))
    except ExportError as e:
        print(f"失敗しました {e}", file=sys.stderr)
        sys.exit(1)

    print(f"{len(conv['turns'])} 往復、画像 {n_images} 枚 → {path}")


if __name__ == "__main__":
    main()
