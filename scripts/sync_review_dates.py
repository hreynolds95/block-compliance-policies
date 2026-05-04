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
    "Extension Coming Due",
    "Overdue",
    "Pending Review",
    "Overdue Past Extension",
}

# Maps Snowflake WORKFLOW_STATUS → DMS frontmatter status value
WORKFLOW_STATUS_MAP = {
    "Published": "published",
    "Retired":   "retired",
    "Draft":     "draft",
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


def load_dashboard(path: str) -> tuple:
    """Load dashboard-data.json and enrich Complete rows with next-cycle due_items.

    Mirrors Blockcell's enrichRowsWithNextDueDate(): for any main row where
    DUE_DATE_STATUS='Complete', overlay DUE_DATE and DUE_DATE_STATUS from the
    best non-Complete due_items entry with the same PWF_RECORD_ID.

    Also builds a lifecycle_lookup: PWF_RECORD_ID → lifecycle_status for
    published docs based on TOLLGATE and CURRENT_STEP in due_items.
    """
    with open(path, encoding="utf-8") as f:
        data = json.load(f)

    # Build due_items lookup: PWF_RECORD_ID → best non-Complete item
    due_lookup: dict = {}
    lifecycle_lookup: dict = {}
    for item in data.get("due_items", []):
        pwf = (item.get("PWF_RECORD_ID") or "").strip()
        if not pwf:
            continue

        # Lifecycle status for published docs only
        if (item.get("WORKFLOW_STATUS") or "").strip() == "Published":
            tollgate = (item.get("TOLLGATE") or "").strip()
            step = (item.get("CURRENT_STEP") or "").strip()
            if tollgate == "Approvals and Publication":
                lifecycle_lookup[pwf] = "in-approvals"
            elif tollgate == "Published" and "QC" in step:
                lifecycle_lookup[pwf] = "under-qc"
            else:
                lifecycle_lookup[pwf] = "current"

        if (item.get("DUE_DATE_STATUS") or "").strip().lower() == "complete":
            continue
        due_date = parse_date(item.get("DUE_DATE"))
        if not due_date:
            continue
        existing = due_lookup.get(pwf)
        if existing is None or due_date > parse_date(existing.get("DUE_DATE")):
            due_lookup[pwf] = item

    # Build status_lookup: PWF_RECORD_ID → DMS status (from WORKFLOW_STATUS in rows)
    status_lookup: dict = {}
    doc_type_lookup: dict = {}
    doc_type_map = {"1": "Policy", "2": "Standard", "3": "Procedure"}
    for r in data["rows"]:
        pwf = (r.get("PWF_RECORD_ID") or "").strip()
        if not pwf:
            continue
        wf = (r.get("WORKFLOW_STATUS") or "").strip()
        dms_status = WORKFLOW_STATUS_MAP.get(wf)
        if dms_status:
            status_lookup[pwf] = dms_status
        raw_type = str(r.get("DOCUMENT_TYPE", "")).split(".")[0].strip()
        if raw_type in doc_type_map:
            doc_type_lookup[pwf] = doc_type_map[raw_type]

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
                r["DUE_DATE"]                    = next_cycle.get("DUE_DATE")
                r["DUE_DATE_STATUS"]             = next_cycle.get("DUE_DATE_STATUS")
                r["EXTENDED_DUEDATE"]            = next_cycle.get("EXTENDED_DUEDATE")
                r["EXTENSION_LIFECYCLE_STATUS"]  = next_cycle.get("EXTENSION_LIFECYCLE_STATUS")
        by_record[pwf] = r

    # Build extension_status lookup: PWF_RECORD_ID → extension_status
    # Build extended_due_lookup: PWF_RECORD_ID → extended due date string (YYYY-MM-DD)
    extension_lookup: dict = {}
    extended_due_lookup: dict = {}
    PENDING_EXTENSION_STATUSES = {
        "Extension In Progress",
        "Extension Pending Compliance Leadership Review",
        "Extension Pending Approver Review",
    }
    for item in data.get("due_items", []):
        pwf = (item.get("PWF_RECORD_ID") or "").strip()
        if not pwf:
            continue
        ext_status = (item.get("EXTENSION_LIFECYCLE_STATUS") or "").strip()
        if ext_status == "Extension Approved":
            extension_lookup[pwf] = "approved"
        elif ext_status in PENDING_EXTENSION_STATUSES:
            extension_lookup[pwf] = "in-progress"
        ext_due = parse_date(item.get("EXTENDED_DUEDATE"))
        if ext_due and ext_status in ({"Extension Approved"} | PENDING_EXTENSION_STATUSES):
            extended_due_lookup[pwf] = ext_due.isoformat()

    return by_record, lifecycle_lookup, extension_lookup, status_lookup, doc_type_lookup, extended_due_lookup


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
        # Mirror Blockcell's effectiveDueDate(): prefer EXTENDED_DUEDATE when extension approved
        if (row.get("EXTENSION_LIFECYCLE_STATUS") or "").strip() == "Extension Approved":
            ext_due = parse_date(row.get("EXTENDED_DUEDATE"))
            if ext_due:
                return ext_due
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


def patch_frontmatter(content: str, new_date: Optional[date], due_date_status: str,
                      lifecycle_status: Optional[str] = None,
                      extension_status: Optional[str] = None,
                      doc_status: Optional[str] = None,
                      doc_type: Optional[str] = None,
                      extended_due_date: Optional[str] = None) -> str:
    # Patch doc status (published / retired / draft)
    if doc_status is not None:
        patched, count = re.subn(
            r'^status:.*$', f'status: {doc_status}', content, flags=re.MULTILINE
        )
        content = patched if count else content

    # Patch next_review_date
    if new_date is None:
        return content
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

    # Patch lifecycle_status (only for published docs)
    if lifecycle_status is not None:
        new_lifecycle_val = f'lifecycle_status: "{lifecycle_status}"'
        patched, count = re.subn(
            r'^lifecycle_status:.*$', new_lifecycle_val, patched, flags=re.MULTILINE
        )
        if count == 0:
            patched = re.sub(
                r'^(due_date_status:.*)', r'\1\n' + new_lifecycle_val, patched, flags=re.MULTILINE
            )

    # Patch extension_status
    if extension_status is not None:
        new_ext_val = f'extension_status: "{extension_status}"'
        patched, count = re.subn(
            r'^extension_status:.*$', new_ext_val, patched, flags=re.MULTILINE
        )
        if count == 0:
            patched = re.sub(
                r'^(lifecycle_status:.*|due_date_status:.*)',
                r'\1\n' + new_ext_val, patched, count=1, flags=re.MULTILINE
            )

    # Patch extended_due_date
    if extended_due_date is not None:
        new_ext_due_val = f'extended_due_date: "{extended_due_date}"'
        patched, count = re.subn(
            r'^extended_due_date:.*$', new_ext_due_val, patched, flags=re.MULTILINE
        )
        if count == 0:
            patched = re.sub(
                r'^(extension_status:.*)',
                r'\1\n' + new_ext_due_val, patched, count=1, flags=re.MULTILINE
            )

    # Patch doc_type
    if doc_type is not None:
        new_doc_type_val = f'doc_type: "{doc_type}"'
        patched, count = re.subn(
            r'^doc_type:.*$', new_doc_type_val, patched, flags=re.MULTILINE
        )
        if count == 0:
            patched = re.sub(
                r'^(extension_status:.*|lifecycle_status:.*|due_date_status:.*)',
                r'\1\n' + new_doc_type_val, patched, count=1, flags=re.MULTILINE
            )

    return patched


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--dashboard", required=True, help="Path to dashboard-data.json")
    parser.add_argument("--docs", default="docs", help="Docs root directory")
    parser.add_argument("--dry-run", action="store_true", help="Print changes without writing")
    args = parser.parse_args()

    by_record, lifecycle_lookup, extension_lookup, status_lookup, doc_type_lookup, extended_due_lookup = load_dashboard(args.dashboard)
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

        due_status = row.get("DUE_DATE_STATUS", "")

        # STATUS_FIX: align status with actual due date so our library matches G2 logic
        # ("overdue" = past due date, not yet complete).
        raw_due = parse_date(row.get("DUE_DATE"))
        today = date.today()

        # Fix 1 (pre-existing): LogicGate marks some 2027+ docs as 'Pending Review' — override.
        if due_status == "Pending Review" and raw_due and raw_due >= date(2027, 1, 1):
            due_status = "Current"

        # Fix 2: LogicGate sometimes carries 'Overdue' from a prior cycle even after the
        # review was completed and the next due date was advanced to the future.
        # If the due date is in the future, the doc is not overdue — use 'Current'.
        if due_status in ("Overdue", "Overdue Past Extension") and raw_due and raw_due > today:
            due_status = "Current"

        # Fix 3: LogicGate sometimes leaves status as 'Pending Review' even when the due
        # date has passed. Override to 'Overdue' so our library matches G2's overdue count.
        NON_TERMINAL = {"Pending Review", "Coming Due"}
        if due_status in NON_TERMINAL and raw_due and raw_due < today:
            due_status = "Overdue"

        # DATE_OVERRIDE: per-record corrections where LogicGate holds the wrong due date.
        # Format: PWF_RECORD_ID → (next_review_date, due_date_status)
        DATE_OVERRIDES = {
            # CP-019: LogicGate shows 2025-10-30; correct next review is 2026-10-30.
            # Confirmed by Hunter Reynolds 2026-05-04; parent record: block.logicgate.com/records/gNsb8BOP
            "gNsb8BOP": (date(2026, 10, 30), "Current"),
        }
        if record_id in DATE_OVERRIDES:
            new_date, due_status = DATE_OVERRIDES[record_id]

        lifecycle_status = lifecycle_lookup.get(record_id)    # None for non-published docs
        extension_status = extension_lookup.get(record_id)    # None if no active extension
        extended_due_date = extended_due_lookup.get(record_id) # None if no extension date
        doc_status = status_lookup.get(record_id)             # None if unmapped workflow status
        doc_type = doc_type_lookup.get(record_id)             # None if not in lookup

        # Check current values
        m_date = re.search(r'^next_review_date:\s*"?([^"\n]*)"?', content, re.MULTILINE)
        current_date_str = m_date.group(1).strip() if m_date else ""
        m_status = re.search(r'^due_date_status:\s*"?([^"\n]*)"?', content, re.MULTILINE)
        current_status_str = m_status.group(1).strip() if m_status else ""
        m_lifecycle = re.search(r'^lifecycle_status:\s*"?([^"\n]*)"?', content, re.MULTILINE)
        current_lifecycle_str = m_lifecycle.group(1).strip() if m_lifecycle else ""
        m_ext = re.search(r'^extension_status:\s*"?([^"\n]*)"?', content, re.MULTILINE)
        current_ext_str = m_ext.group(1).strip() if m_ext else ""
        m_ext_due = re.search(r'^extended_due_date:\s*"?([^"\n]*)"?', content, re.MULTILINE)
        current_ext_due_str = m_ext_due.group(1).strip() if m_ext_due else ""
        m_doc_status = re.search(r'^status:\s*(\S+)', content, re.MULTILINE)
        current_doc_status_str = m_doc_status.group(1).strip() if m_doc_status else ""
        m_doc_type = re.search(r'^doc_type:\s*"?([^"\n]*)"?', content, re.MULTILINE)
        current_doc_type_str = m_doc_type.group(1).strip() if m_doc_type else ""

        date_changed = new_date is not None and current_date_str != new_date.isoformat()
        review_status_changed = current_status_str != due_status
        lifecycle_changed = lifecycle_status is not None and current_lifecycle_str != lifecycle_status
        extension_changed = extension_status is not None and current_ext_str != extension_status
        ext_due_changed = extended_due_date is not None and current_ext_due_str != extended_due_date
        doc_status_changed = doc_status is not None and current_doc_status_str != doc_status
        doc_type_changed = doc_type is not None and current_doc_type_str != doc_type

        if not any([date_changed, review_status_changed, lifecycle_changed,
                    extension_changed, ext_due_changed, doc_status_changed, doc_type_changed]):
            if new_date is None:
                print(f"  [NO DATE]   {os.path.basename(path)} — no usable date in dashboard row")
                skipped += 1
            else:
                unchanged += 1
            continue

        changes = []
        if doc_status_changed:
            changes.append(f"doc_status {current_doc_status_str!r} → {doc_status!r}")
        if date_changed:
            changes.append(f"date {current_date_str} → {new_date.isoformat()}")
        if review_status_changed:
            changes.append(f"review_status {current_status_str!r} → {due_status!r}")
        if lifecycle_changed:
            changes.append(f"lifecycle {current_lifecycle_str!r} → {lifecycle_status!r}")
        if extension_changed:
            changes.append(f"extension {current_ext_str!r} → {extension_status!r}")
        if ext_due_changed:
            changes.append(f"extended_due {current_ext_due_str!r} → {extended_due_date!r}")
        if doc_type_changed:
            changes.append(f"doc_type {current_doc_type_str!r} → {doc_type!r}")
        print(f"  [UPDATE]    {os.path.basename(path)}: {', '.join(changes)}")

        if not args.dry_run:
            new_content = patch_frontmatter(content, new_date, due_status, lifecycle_status,
                                            extension_status, doc_status, doc_type, extended_due_date)
            with open(path, "w", encoding="utf-8") as f:
                f.write(new_content)
        updated += 1

    print()
    print(f"{'[DRY RUN] ' if args.dry_run else ''}Done: {updated} updated, {unchanged} unchanged, {unmatched} unmatched, {skipped} skipped")


if __name__ == "__main__":
    main()
