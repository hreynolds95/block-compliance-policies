#!/usr/bin/env python3
"""
Walks docs/ and extracts YAML frontmatter from every .md file (skipping _templates/).
Writes a JSON array to site/docs-data.json for consumption by the GitHub Pages UI.

Usage:
    python scripts/generate_docs_data.py
"""

import json
import os
import sys
from datetime import date, datetime, timezone

import yaml

DOCS_ROOT = "docs"
OUT_FILE = "site/docs-data.json"


def parse_frontmatter(path: str):
    with open(path, encoding="utf-8") as f:
        content = f.read()
    if not content.startswith("---"):
        return None
    parts = content.split("---", 2)
    if len(parts) < 3:
        return None
    meta = yaml.safe_load(parts[1]) or {}
    if not meta.get("doc_id"):
        return None
    return meta


def serialize(obj):
    if isinstance(obj, date):
        return obj.isoformat()
    return obj


def main():
    docs = []
    today = date.today()
    now_utc = datetime.now(timezone.utc)

    for dirpath, _, filenames in os.walk(DOCS_ROOT):
        if "_templates" in dirpath:
            continue
        for fn in sorted(filenames):
            if not fn.endswith(".md"):
                continue
            path = os.path.join(dirpath, fn)
            meta = parse_frontmatter(path)
            if not meta:
                continue

            # Compute review status — prefer LogicGate's DUE_DATE_STATUS when present
            due_date_status = meta.get("due_date_status", "")

            # Parse dates once (needed for both DDS and fallback paths)
            next_review = meta.get("next_review_date")
            if isinstance(next_review, str):
                try:
                    next_review = date.fromisoformat(next_review)
                except ValueError:
                    next_review = None
            extended_due = meta.get("extended_due_date")
            if isinstance(extended_due, str):
                try:
                    extended_due = date.fromisoformat(extended_due)
                except ValueError:
                    extended_due = None

            if due_date_status and due_date_status != "Complete":
                # Mirror Blockcell's date-first classification:
                # effective date (set by sync, uses EXTENDED_DUEDATE for extension statuses)
                # drives overdue/due-soon/ok; status determines the "flavor".
                eff = next_review
                is_extension = due_date_status in ("Extended", "Extension Coming Due", "Overdue Past Extension")
                if isinstance(eff, date):
                    delta = (eff - today).days
                    if delta < 0:
                        if is_extension:
                            review_status = "overdue-past-extension"
                        elif due_date_status == "Overdue":
                            review_status = "overdue"
                        else:
                            review_status = "pending-review"
                    elif delta <= 30:
                        review_status = "extension-coming-due" if is_extension else "due-soon"
                    else:
                        review_status = "ok"
                else:
                    # No effective date — fall back to a safe default by status
                    if is_extension:
                        review_status = "extension-coming-due"
                    elif due_date_status in ("Overdue", "Overdue Past Extension"):
                        review_status = "overdue"
                    else:
                        review_status = "ok"
            elif due_date_status == "Complete":
                review_status = "ok"
            else:
                # Fallback: date-math (used when due_date_status is absent)
                has_extension = bool(meta.get("extension_status"))
                if isinstance(next_review, date):
                    delta = (next_review - today).days
                    if has_extension and isinstance(extended_due, date):
                        ext_delta = (extended_due - today).days
                        if ext_delta < 0:
                            review_status = "overdue-past-extension"
                        elif ext_delta <= 30:
                            review_status = "extension-coming-due"
                        else:
                            review_status = "ok"
                    elif delta < -30 and not has_extension:
                        review_status = "overdue"
                    elif delta < 0:
                        review_status = "pending-review"
                    elif delta <= 30:
                        review_status = "due-soon"
                    else:
                        review_status = "ok"
                else:
                    review_status = "unknown"

            docs.append({
                "doc_id": meta.get("doc_id", ""),
                "pwf_record_id": meta.get("pwf_record_id") or meta.get("logicgate_record_id", ""),
                "title": meta.get("title", ""),
                "version": str(meta.get("version", "")),
                "status": meta.get("status", ""),
                "tier": meta.get("tier", ""),
                "domain": meta.get("domain", ""),
                "legal_entity": meta.get("legal_entity", ""),
                "business": meta.get("business", ""),
                "owner": meta.get("owner", ""),
                "approval_type": meta.get("approval_type", ""),
                "effective_date": serialize(meta.get("effective_date")),
                "next_review_date": serialize(meta.get("next_review_date")),
                "retention_years": meta.get("retention_years"),
                "review_status": review_status,
                "extension_status": meta.get("extension_status"),
                "extended_due_date": serialize(meta.get("extended_due_date")),
                "extension_reason": meta.get("extension_reason"),
                "published_pdf": meta.get("published_pdf"),
                "lifecycle_status": meta.get("lifecycle_status"),
                "file": path,
            })

    docs.sort(key=lambda d: d["doc_id"])

    os.makedirs("site", exist_ok=True)
    with open(OUT_FILE, "w", encoding="utf-8") as f:
        json.dump({
            "generated": now_utc.isoformat(),
            "source": "LogicGate → Snowflake",
            "documents": docs,
        }, f, indent=2, default=serialize)

    print(f"Wrote {len(docs)} document(s) to {OUT_FILE}")


if __name__ == "__main__":
    main()
