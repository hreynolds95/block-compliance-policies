#!/usr/bin/env python3
"""
Build site/process-index.json from process-text-cache/ and the manifest.

Usage:
    python scripts/generate_process_index.py
"""

import json
import re
from datetime import datetime, timezone
from pathlib import Path

MANIFEST_PATH = Path("process-docs/manifest.json")
CACHE_DIR     = Path("process-text-cache")
OUT_FILE      = Path("site/process-index.json")


def clean_text(raw: str) -> str:
    return re.sub(r"\s+", " ", raw).strip()


def main():
    if not MANIFEST_PATH.exists():
        print(f"ERROR: {MANIFEST_PATH} not found. Run from repo root.")
        raise SystemExit(1)

    manifest = json.loads(MANIFEST_PATH.read_text())
    documents = {}
    populated = 0

    for doc in manifest:
        proc_id  = doc["proc_id"]
        txt_path = CACHE_DIR / f"{proc_id}.txt"
        documents[proc_id] = {
            "title":       doc["title"],
            "description": doc["description"],
            "text":        clean_text(txt_path.read_text(encoding="utf-8", errors="replace")) if txt_path.exists() else "",
        }
        if txt_path.exists():
            populated += 1

    out = {
        "generated": datetime.now(timezone.utc).isoformat(),
        "documents": documents,
    }

    OUT_FILE.parent.mkdir(parents=True, exist_ok=True)
    OUT_FILE.write_text(json.dumps(out, indent=2, ensure_ascii=False))
    print(f"Wrote {OUT_FILE}: {populated}/{len(manifest)} docs with content")


if __name__ == "__main__":
    main()
