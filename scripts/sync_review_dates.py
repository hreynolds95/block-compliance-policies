#!/usr/bin/env python3
"""
Syncs next_review_date in all DMS doc frontmatter from dashboard-data.json.

Background: next_review_date was originally set from DUE_DATE (the workflow
approval deadline). For docs with DUE_DATE_STATUS='Complete', that deadline
has already passed because the approval cycle finished — making them appear
overdue when they are not. The correct next_review_date is:

  - DUE_DATE_STATUS='Complete': DATE_OF_FINAL_APPROVAL + 1 year
  - DUE_DATE_STATUS='Current' / 'Coming Due' / 'Extended' / 'Pending Review'
    / 'Overdue Past Extension': DUE_DATE (the active workflow deadline)

Docs with no matching dashboard record are left unchanged and reported.

Usage:
    python scripts/sync_review_dates.py --dashboard path/to/dashboard-data.json
    python scripts/sync_review_dates.py --dashboard path/to/dashboard-data.json --dry-run
"""

import argparse
import json
import os
import re
import sys
from datetime import date, datetime
from typing import Optional
from dateutil.relativedelta import relativedelta

REVIEW_CYCLE_YEARS = 1  # standard annual review cycle for all tiers

ACTIVE_WORKFLOW_STATUSES = {
    "Current",
    "Coming Due",
    "Extended",
    "Pending Review",
    "Overdue Past Extension",
}


def parse_date(val) -> Optional[date]:
    if not val:
        return None
    if isinstance(val, date):
        return val
    s = str(val).strip()
    for fmt in ("%Y-%m-%dT%H:%M:%S", "%Y-%m-%d"):
        try:
            return datetime.strptime(s, fmt).date()
        except ValueError:
            continue
    return None


def load_dashboard(path: str) -> dict:
    with open(path, encoding="utf-8") as f:
        data = json.load(f)
    return {r["PWF_RECORD_ID"]: r for r in data["rows"] if r.get("PWF_RECORD_ID")}


def collect_docs(root: str) -> list:
    docs = []
    for dirpath, _, filenames in os.walk(root):
        if "_templates" in dirpath:
            continue
        for fn in sorted(filenames):
            if fn.endswith(".md"):
                docs.append(os.path.join(dirpath, fn))
    return docs


def get_record_id(content: str) -> Optional[str]:
    m = re.search(r'^logicgate_record_id:\s*"?([^"\n]+)"?', content, re.MULTILINE)
    return m.group(1).strip() if m else None


def compute_next_review(row: dict) -> Optional[date]:
    status = row.get("DUE_DATE_STATUS", "")
    if status in ACTIVE_WORKFLOW_STATUSES:
        return parse_date(row.get("DUE_DATE"))
    # Complete — derive from last approval
    final = parse_date(row.get("DATE_OF_FINAL_APPROVAL"))
    if final:
        return final + relativedelta(years=REVIEW_CYCLE_YEARS)
    # Fallback: DUE_DATE + 1 year (covers cases with no final approval date yet)
    due = parse_date(row.get("DUE_DATE"))
    if due:
        return due + relativedelta(years=REVIEW_CYCLE_YEARS)
    return None


def patch_frontmatter(content: str, new_date: date) -> str:
    new_val = f'next_review_date: "{new_date.isoformat()}"'
    patched, count = re.subn(
        r'^next_review_date:.*$', new_val, content, flags=re.MULTILINE
    )
    if count == 0:
        # Field missing entirely — insert after effective_date line
        patched = re.sub(
            r'^(effective_date:.*)', r'\1\n' + new_val, content, flags=re.MULTILINE
        )
    return patched


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--dashboard", required=True, help="Path to dashboard-data.json")
    parser.add_argument("--docs", default="docs", help="Docs root directory")
    parser.add_argument("--dry-run", action="store_true", help="Print changes without writing")
    args = parser.parse_args()

    by_record = load_dashboard(args.dashboard)
    docs = collect_docs(args.docs)

    updated = skipped = unmatched = unchanged = 0

    for path in docs:
        with open(path, encoding="utf-8") as f:
            content = f.read()

        record_id = get_record_id(content)
        if not record_id or record_id not in by_record:
            print(f"  [UNMATCHED] {path}")
            unmatched += 1
            continue

        row = by_record[record_id]
        new_date = compute_next_review(row)
        if not new_date:
            print(f"  [NO DATE]   {os.path.basename(path)} — no usable date in dashboard row")
            skipped += 1
            continue

        # Check current value
        m = re.search(r'^next_review_date:\s*"?([^"\n]*)"?', content, re.MULTILINE)
        current_str = m.group(1).strip() if m else ""
        if current_str == new_date.isoformat():
            unchanged += 1
            continue

        due_status = row.get("DUE_DATE_STATUS", "")
        print(f"  [UPDATE]    {os.path.basename(path)}: {current_str} → {new_date.isoformat()}  ({due_status})")

        if not args.dry_run:
            new_content = patch_frontmatter(content, new_date)
            with open(path, "w", encoding="utf-8") as f:
                f.write(new_content)
        updated += 1

    print()
    print(f"{'[DRY RUN] ' if args.dry_run else ''}Done: {updated} updated, {unchanged} unchanged, {unmatched} unmatched, {skipped} skipped")


if __name__ == "__main__":
    main()
