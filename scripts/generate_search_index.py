#!/usr/bin/env python3
"""
Generate site/search-index.json from extracted PDF text.

Expected input: a directory of plain-text files named <doc_id>.txt
(e.g. pdf-text-cache/CP-001.txt), produced by the CI PDF extraction step.

Usage:
    python scripts/generate_search_index.py                        # default cache dir
    python scripts/generate_search_index.py --cache-dir /tmp/pdf-text

The output is site/search-index.json:
{
  "generated": "<ISO timestamp>",
  "documents": {
    "CP-001": "full extracted text...",
    "CP-002": "",   <- empty if no .txt file found for this doc
    ...
  }
}

doc_ids with no corresponding .txt file get an empty string so the frontend
can still load the index without errors.
"""

import argparse
import json
import os
import re
from datetime import datetime, timezone
from pathlib import Path

DOCS_DATA = Path("site/docs-data.json")
OUT_FILE = Path("site/search-index.json")
DEFAULT_CACHE_DIR = Path("pdf-text-cache")


def clean_text(raw: str) -> str:
    """Normalize extracted PDF text for search."""
    # Collapse runs of whitespace/newlines to single spaces
    text = re.sub(r"\s+", " ", raw)
    return text.strip()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--cache-dir",
        type=Path,
        default=DEFAULT_CACHE_DIR,
        help=f"Directory containing <doc_id>.txt files (default: {DEFAULT_CACHE_DIR})",
    )
    parser.add_argument(
        "--max-chars",
        type=int,
        default=4000,
        help="Truncate each doc's text to this many characters (default: 4000). "
             "Full text is preserved in the cache files.",
    )
    args = parser.parse_args()

    if not DOCS_DATA.exists():
        print(f"ERROR: {DOCS_DATA} not found. Run from repo root.")
        raise SystemExit(1)

    docs_data = json.loads(DOCS_DATA.read_text())
    all_doc_ids = [d["doc_id"] for d in docs_data.get("documents", [])]

    cache_dir: Path = args.cache_dir
    documents = {}
    populated = 0
    missing = 0

    for doc_id in all_doc_ids:
        txt_path = cache_dir / f"{doc_id}.txt"
        if txt_path.exists():
            raw = txt_path.read_text(encoding="utf-8", errors="replace")
            text = clean_text(raw)
            if args.max_chars and len(text) > args.max_chars:
                text = text[:args.max_chars]
            documents[doc_id] = text
            populated += 1
        else:
            documents[doc_id] = ""
            missing += 1

    out = {
        "generated": datetime.now(timezone.utc).isoformat(),
        "note": "Content populated by CI pipeline. Empty strings indicate PDF text has not yet been extracted.",
        "documents": documents,
    }

    OUT_FILE.parent.mkdir(parents=True, exist_ok=True)
    OUT_FILE.write_text(json.dumps(out, indent=2, ensure_ascii=False))

    print(f"Wrote {OUT_FILE}: {populated} docs with content, {missing} empty")


if __name__ == "__main__":
    main()
