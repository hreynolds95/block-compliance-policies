#!/usr/bin/env python3
"""
Appends a JSON audit log entry to audit/audit-log.jsonl for each changed document.
Also creates Git version tags when --tag-only is passed.

Called by the audit-log GitHub Actions workflow on every merge to main.

Usage:
    python scripts/append_audit_entry.py \\
        --files docs/financial-crimes/POL-001-sanctions-policy.md \\
        --actor faisalsohail \\
        --commit abc123 \\
        --run-url https://github.com/...

    python scripts/append_audit_entry.py \\
        --files docs/financial-crimes/POL-001-sanctions-policy.md \\
        --tag-only \\
        --commit abc123
"""

import argparse
import json
import os
import subprocess
import sys
from datetime import datetime, timezone

import yaml

AUDIT_LOG = "audit/audit-log.jsonl"


def parse_frontmatter(path: str) -> dict:
    with open(path, encoding="utf-8") as f:
        content = f.read()
    if not content.startswith("---"):
        return {}
    parts = content.split("---", 2)
    if len(parts) < 3:
        return {}
    return yaml.safe_load(parts[1]) or {}


def append_entry(entry: dict):
    os.makedirs("audit", exist_ok=True)
    with open(AUDIT_LOG, "a", encoding="utf-8") as f:
        f.write(json.dumps(entry, default=str) + "\n")


def create_tag(tag: str, commit: str):
    result = subprocess.run(
        ["git", "tag", tag, commit],
        capture_output=True, text=True
    )
    if result.returncode != 0:
        # Tag may already exist — not fatal
        print(f"  Note: could not create tag {tag}: {result.stderr.strip()}")
    else:
        subprocess.run(["git", "push", "origin", tag], capture_output=True)
        print(f"  Tagged: {tag}")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--files", nargs="+", required=True)
    parser.add_argument("--actor", default="ci")
    parser.add_argument("--commit", required=True)
    parser.add_argument("--run-url", default="")
    parser.add_argument("--tag-only", action="store_true")
    args = parser.parse_args()

    for path in args.files:
        if not path.endswith(".md") or not os.path.exists(path):
            continue

        meta = parse_frontmatter(path)
        if not meta.get("doc_id") or not meta.get("version"):
            print(f"Skipping {path} — missing doc_id or version in frontmatter")
            continue

        doc_id = meta["doc_id"]
        version = str(meta["version"])
        tag = f"{doc_id}@v{version}"

        if args.tag_only:
            create_tag(tag, args.commit)
            continue

        entry = {
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "event": "document_approved",
            "doc_id": doc_id,
            "title": meta.get("title", ""),
            "version": version,
            "status": meta.get("status", ""),
            "domain": meta.get("domain", ""),
            "tier": meta.get("tier", ""),
            "owner": meta.get("owner", ""),
            "actor": args.actor,
            "commit_sha": args.commit,
            "git_tag": tag,
            "run_url": args.run_url,
            "file": path,
        }

        append_entry(entry)
        print(f"Audit entry written for {doc_id} v{version}")


if __name__ == "__main__":
    main()
