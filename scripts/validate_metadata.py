#!/usr/bin/env python3
"""
Validates YAML frontmatter in compliance documents.
Run by CI on every PR touching docs/, and can be run locally.

Usage:
    python scripts/validate_metadata.py docs/
    python scripts/validate_metadata.py docs/financial-crimes/POL-001-sanctions-policy.md
"""

import sys
import os
import re
from datetime import date
import yaml

REQUIRED_FIELDS = [
    "doc_id", "title", "version", "status", "tier", "domain",
    "legal_entity", "business", "owner", "approval_type",
    "effective_date", "next_review_date", "retention_years",
]

VALID_STATUSES = {"draft", "in-review", "published", "retired"}
VALID_APPROVAL_TYPES = {"board", "committee"}
VALID_TIERS = {1, 2}

VERSION_RE = re.compile(r"^\d+\.\d+\.\d+$")
DOC_ID_RE = re.compile(r"^(POL|PRC|STD)-\d{3}$")


def parse_frontmatter(path: str) -> dict:
    with open(path, encoding="utf-8") as f:
        content = f.read()

    if not content.startswith("---"):
        raise ValueError("Missing YAML frontmatter (file must start with ---)")

    parts = content.split("---", 2)
    if len(parts) < 3:
        raise ValueError("Malformed frontmatter (no closing ---)")

    return yaml.safe_load(parts[1]) or {}


def validate_doc(path: str) -> list[str]:
    errors = []

    try:
        meta = parse_frontmatter(path)
    except Exception as e:
        return [f"Could not parse frontmatter: {e}"]

    # Required fields
    for field in REQUIRED_FIELDS:
        if field not in meta or meta[field] in (None, ""):
            errors.append(f"Missing required field: '{field}'")

    if errors:
        return errors  # stop early — remaining checks need these fields

    # Field value validation
    if not VERSION_RE.match(str(meta["version"])):
        errors.append(f"'version' must be semver (e.g. 1.0.0), got: {meta['version']}")

    if not DOC_ID_RE.match(str(meta["doc_id"])):
        errors.append(f"'doc_id' must match POL-NNN / PRC-NNN / STD-NNN, got: {meta['doc_id']}")

    if meta["status"] not in VALID_STATUSES:
        errors.append(f"'status' must be one of {VALID_STATUSES}, got: {meta['status']}")

    if meta["approval_type"] not in VALID_APPROVAL_TYPES:
        errors.append(f"'approval_type' must be one of {VALID_APPROVAL_TYPES}, got: {meta['approval_type']}")

    if meta["tier"] not in VALID_TIERS:
        errors.append(f"'tier' must be 1 or 2, got: {meta['tier']}")

    if not isinstance(meta["retention_years"], int) or meta["retention_years"] < 1:
        errors.append(f"'retention_years' must be a positive integer, got: {meta['retention_years']}")

    for date_field in ("effective_date", "next_review_date"):
        val = meta[date_field]
        if not isinstance(val, date):
            errors.append(f"'{date_field}' must be a date (YYYY-MM-DD), got: {val}")

    # Tier/approval_type consistency
    if meta["tier"] == 1 and meta["approval_type"] != "board":
        errors.append("Tier 1 documents require approval_type 'board'")
    if meta["tier"] == 2 and meta["approval_type"] != "committee":
        errors.append("Tier 2 documents require approval_type 'committee'")

    return errors


def collect_files(paths: list[str]) -> list[str]:
    files = []
    for p in paths:
        if os.path.isdir(p):
            for root, _, filenames in os.walk(p):
                for fn in filenames:
                    if fn.endswith(".md") and not fn.startswith("_"):
                        full = os.path.join(root, fn)
                        # Skip template directory
                        if "_templates" not in full:
                            files.append(full)
        elif p.endswith(".md"):
            files.append(p)
    return files


def main():
    paths = sys.argv[1:]
    if not paths:
        print("Usage: validate_metadata.py <file_or_dir> [...]")
        sys.exit(1)

    files = collect_files(paths)
    if not files:
        print("No document files found.")
        sys.exit(0)

    failed = 0
    for path in sorted(files):
        errors = validate_doc(path)
        if errors:
            failed += 1
            print(f"\nFAIL  {path}")
            for e in errors:
                print(f"      - {e}")
        else:
            print(f"OK    {path}")

    print(f"\n{len(files)} document(s) checked, {failed} failed.")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
