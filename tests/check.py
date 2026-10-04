"""書き出し結果が以前と変わっていないかを確かめる。

使い方:
    python3 tests/check.py           # 今の出力を基準と比べる
    python3 tests/check.py --update  # 今の出力を新しい基準として保存する

共有リンクの一覧は tests/data/links.txt（1行に1つ。# 以降は注釈）に書く。
基準は tests/data/expected/、取得した生の応答は tests/data/raw/ に保存する。
どれも個人の会話を含むので git の管理外。
Google 側の変更で配列の位置がずれたことに気づくためと、別の実装（拡張機能）が
同じ出力を出すかを確かめるために使う。
"""

import argparse
import contextlib
import difflib
import io
import json
import shutil
import sys
import tempfile
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
import gemini_md  # noqa: E402

DATA = Path(__file__).resolve().parent / "data"
LINKS = DATA / "links.txt"
EXPECTED = DATA / "expected"
RAW = DATA / "raw"


def read_links():
    links = []
    for line in LINKS.read_text(encoding="utf-8").splitlines():
        url = line.split("#", 1)[0].strip()
        if url:
            links.append(url)
    return links


def link_key(url):
    return url.rstrip("/").rsplit("/", 1)[-1]


def snapshot(url):
    """書き出して、{相対パス: バイト列}、警告の文字列、取得した生の応答（inner）を返す。"""
    captured = {}
    fetch = gemini_md.fetch_conversation

    def capture(*args):
        captured["inner"] = fetch(*args)
        return captured["inner"]

    with tempfile.TemporaryDirectory() as tmp:
        warnings = io.StringIO()
        gemini_md.fetch_conversation = capture
        try:
            with contextlib.redirect_stderr(warnings):
                path, _, _ = gemini_md.export(url, Path(tmp))
        finally:
            gemini_md.fetch_conversation = fetch
        files = {}
        if path.suffix == ".zip":
            with zipfile.ZipFile(path) as z:
                for name in z.namelist():
                    files[name] = z.read(name)
        else:
            files[path.name] = path.read_bytes()
    return files, warnings.getvalue(), captured.get("inner")


def strip_volatile(md):
    # source 行は入力した URL の書き方で変わるので比べない
    return [line for line in md.splitlines() if not line.startswith("source: ")]


def compare(key, files):
    """基準との違いを文字列の一覧で返す。違いが無ければ空。"""
    base = EXPECTED / key
    expected = {
        p.relative_to(base).as_posix(): p.read_bytes()
        for p in base.rglob("*") if p.is_file()
    }
    problems = []
    for name in sorted(set(expected) - set(files)):
        problems.append(f"  無くなったファイル: {name}")
    for name in sorted(set(files) - set(expected)):
        problems.append(f"  増えたファイル: {name}")
    for name in sorted(set(files) & set(expected)):
        old, new = expected[name], files[name]
        if name.endswith(".md"):
            diff = list(difflib.unified_diff(
                strip_volatile(old.decode("utf-8")), strip_volatile(new.decode("utf-8")),
                "基準", "今回", lineterm="", n=1,
            ))
            if diff:
                problems.append(f"  {name} の本文が変わりました（先頭20行）:")
                problems.extend("    " + d for d in diff[:20])
        elif old != new:
            problems.append(f"  {name} の中身が変わりました（{len(old)} → {len(new)} バイト）")
    return problems


def main():
    parser = argparse.ArgumentParser(description="書き出し結果が以前と変わっていないかを確かめる")
    parser.add_argument("--update", action="store_true", help="今の出力を新しい基準として保存する")
    args = parser.parse_args()

    if not LINKS.exists():
        print(f"{LINKS} がありません。共有リンクを1行に1つ書いてください。", file=sys.stderr)
        sys.exit(1)

    failed = 0
    for url in read_links():
        key = link_key(url)
        try:
            files, warnings, inner = snapshot(url)
        except gemini_md.ExportError as e:
            print(f"失敗 {key}: {e}")
            failed += 1
            continue

        if warnings:
            print(f"警告 {key}:\n" + "".join("  " + w for w in warnings.splitlines(True)), end="")

        if args.update:
            target = EXPECTED / key
            shutil.rmtree(target, ignore_errors=True)
            for name, data in files.items():
                (target / name).parent.mkdir(parents=True, exist_ok=True)
                (target / name).write_bytes(data)
            # JavaScript 版（tests/check_js.mjs）が同じ応答から同じ md を作るかを確かめるために残す
            RAW.mkdir(parents=True, exist_ok=True)
            (RAW / f"{key}.json").write_text(json.dumps(inner, ensure_ascii=False), encoding="utf-8")
            print(f"保存 {key}")
            continue

        if not (EXPECTED / key).exists():
            print(f"基準なし {key}（--update で保存してください）")
            failed += 1
            continue

        problems = compare(key, files)
        if problems:
            print(f"違い {key}")
            print("\n".join(problems))
            failed += 1
        else:
            print(f"同じ {key}")

    if not args.update:
        print(f"\n{len(read_links())} 件中 {failed} 件で違いまたは失敗がありました" if failed else "\nすべて基準と同じです")
    sys.exit(1 if failed and not args.update else 0)


if __name__ == "__main__":
    main()
