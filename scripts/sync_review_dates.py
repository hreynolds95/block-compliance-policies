#!/usr/bin/env python3
"""
Syncs next_review_date and due_date_status in all DMS doc frontmatter
from dashboard-data.json.

dashboard-data.json has two record sets:
  rows       — one deduped Published/Active record per document
  due_items  — active next-cycle workflow records (mirrors Blockcell's
               enrichRowsWithNextDueDate logic)

For a Complete main row that has a non-Complete due_items entry, the
due_items entry is the authoritative source for next_review_date and
due_date_status (it represents the current open review cycle).

  - due_items entry exists and is non-Complete: use its DUE_DATE / DUE_DATE_STATUS
  - DUE_DATE_STATUS is an active status (Current/Coming Due/etc.): use DUE_DATE
  - DUE_DATE_STATUS='Complete', no due_items entry: DATE_OF_FINAL_APPROVAL + 1 yr

Docs with no matching dashboard record are left unchanged.

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
    """Load dashboard-data.json and enrich Complete rows with next-cycle due_items.

    Mirrors Blockcell's enrichRowsWithNextDueDate(): for any main row where
    DUE_DATE_STATUS='Complete', overlay DUE_DATE and DUE_DATE_STATUS from the
    best non-Complete due_items entry with the same PWF_RECORD_ID.
    """
    with open(path, encoding="utf-8") as f:
        data = json.load(f)

    # Build due_items lookup: PWF_RECORD_ID → best non-Complete item
    due_lookup: dict = {}
    for item in data.get("due_items", []):
        pwf = (item.get("PWF_RECORD_ID") or "").strip()
        if not pwf:
            continue
        if (item.get("DUE_DATE_STATUS") or "").strip().lower() == "complete":
            continue
        due_date = parse_date(item.get("DUE_DATE"))
        if not due_date:
            continue
        existing = due_lookup.get(pwf)
        if existing is None or due_date > parse_date(existing.get("DUE_DATE")):
            due_lookup[pwf] = item

    by_record: dict = {}
    for r in data["rows"]:
        pwf = (r.get("PWF_RECORD_ID") or "").strip()
        if not pwf:
            continue
        # Enrich Complete rows with the next open review cycle
        if (r.get("DUE_DATE_STATUS") or "").strip().lower() == "complete":
            next_cycle = due_lookup.get(pwf)
            if next_cycle:
                r = dict(r)  # don't mutate original
                r["DUE_DATE"]        = next_cycle.get("DUE_DATE")
                r["DUE_DATE_STATUS"] = next_cycle.get("DUE_DATE_STATUS")
        by_record[pwf] = r

    return by_record


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
        # Active cycle (including enriched Complete→next-cycle rows): use deadline directly
        return parse_date(row.get("DUE_DATE"))
    # Genuinely Complete with no open next cycle — derive from last approval
    final = parse_date(row.get("DATE_OF_FINAL_APPROVAL"))
    if final:
        return final + relativedelta(years=REVIEW_CYCLE_YEARS)
    # Fallback: DUE_DATE + 1 year
    due = parse_date(row.get("DUE_DATE"))
    if due:
        return due + relativedelta(years=REVIEW_CYCLE_YEARS)
    return None


def patch_frontmatter(content: str, new_date: date, due_date_status: str) -> str:
    # Patch next_review_date
    new_date_val = f'next_review_date: "{new_date.isoformat()}"'
    patched, count = re.subn(
        r'^next_review_date:.*$', new_date_val, content, flags=re.MULTILINE
    )
    if count == 0:
        patched = re.sub(
            r'^(effective_date:.*)', r'\1\n' + new_date_val, content, flags=re.MULTILINE
        )

    # Patch due_date_status
    new_status_val = f'due_date_status: "{due_date_status}"'
    patched, count = re.subn(
        r'^due_date_status:.*$', new_status_val, patched, flags=re.MULTILINE
    )
    if count == 0:
        patched = re.sub(
            r'^(next_review_date:.*)', r'\1\n' + new_status_val, patched, flags=re.MULTILINE
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
            unmatched += 1
            continue

        row = by_record[record_id]
        new_date = compute_next_review(row)
        if not new_date:
            print(f"  [NO DATE]   {os.path.basename(path)} — no usable date in dashboard row")
            skipped += 1
            continue

        due_status = row.get("DUE_DATE_STATUS", "")

        # Check both current values
        m_date = re.search(r'^next_review_date:\s*"?([^"\n]*)"?', content, re.MULTILINE)
        current_date_str = m_date.group(1).strip() if m_date else ""
        m_status = re.search(r'^due_date_status:\s*"?([^"\n]*)"?', content, re.MULTILINE)
        current_status_str = m_status.group(1).strip() if m_status else ""

        date_changed = current_date_str != new_date.isoformat()
        status_changed = current_status_str != due_status

        if not date_changed and not status_changed:
            unchanged += 1
            continue

        changes = []
        if date_changed:
            changes.append(f"date {current_date_str} → {new_date.isoformat()}")
        if status_changed:
            changes.append(f"status {current_status_str!r} → {due_status!r}")
        print(f"  [UPDATE]    {os.path.basename(path)}: {', '.join(changes)}")

        if not args.dry_run:
            new_content = patch_frontmatter(content, new_date, due_status)
            with open(path, "w", encoding="utf-8") as f:
                f.write(new_content)
        updated += 1

    print()
    print(f"{'[DRY RUN] ' if args.dry_run else ''}Done: {updated} updated, {unchanged} unchanged, {unmatched} unmatched, {skipped} skipped")


if __name__ == "__main__":
    main()
