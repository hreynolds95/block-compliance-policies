#!/usr/bin/env python3
"""
Imports active policies from a LogicGate Snowflake CSV export and creates
document stubs under docs/ with correct frontmatter.

Existing files are NOT overwritten — this is safe to re-run.

Usage:
    python scripts/import_from_logicgate.py /tmp/logicgate_policies.csv
"""

import csv
import os
import re
import sys
from collections import defaultdict
from datetime import date

# ── Mappings ────────────────────────────────────────────────────────────────

DOMAIN_SLUG = {
    "Consumer Protection":        "consumer-protection",
    "Ethics and Employee Conduct": "ethics-and-employee-conduct",
    "Financial Crimes":            "financial-crimes",
    "Governance":                  "governance",
}

DOC_TYPE_LABEL = {
    "1": "Policy",
    "2": "Standard",
    "3": "Procedure",
}

STATUS_MAP = {
    "Published":                      "published",
    "New Request Draft in Progress":  "draft",
    "In-Progress":                    "draft",
    "Under Review":                   "in-review",
    "Retired":                        "retired",
}

# Counters per domain for sequential doc IDs
PREFIX = {
    "consumer-protection":        "CP",
    "ethics-and-employee-conduct": "EE",
    "financial-crimes":           "FC",
    "governance":                 "GOV",
}

# ── Helpers ─────────────────────────────────────────────────────────────────

def slugify(text: str) -> str:
    text = re.sub(r"[^\w\s-]", "", text.lower())
    text = re.sub(r"[\s_]+", "-", text.strip())
    text = re.sub(r"-+", "-", text)
    return text[:80].rstrip("-")


def clean_name(name: str) -> str:
    """Strip trailing ' Draft' or ' Draft (...)' suffixes LogicGate appends."""
    name = re.sub(r"\s+Draft(\s+\(.*?\))?\s*$", "", name, flags=re.IGNORECASE)
    return name.strip()


def tier_num(tier_str: str) -> int:
    m = re.search(r"\d", tier_str or "")
    return int(m.group()) if m else 2


def approval_type(tier: int, board_required: str) -> str:
    if tier == 1 or (board_required or "").strip().lower() in ("yes", "true", "1"):
        return "board"
    if tier == 3:
        return "owner"
    return "committee"


def parse_date(val: str):
    if not val or val.strip() in ("", "None", "NULL"):
        return None
    # CSV dates come as YYYY-MM-DD or YYYY-MM-DDTHH:MM:SS
    return val.strip()[:10]


def doc_type_str(val: str) -> str:
    key = str(val).split(".")[0].strip()
    return DOC_TYPE_LABEL.get(key, "Policy")


def status_str(workflow: str, draft: str) -> str:
    for key, mapped in STATUS_MAP.items():
        if key.lower() in (workflow or "").lower():
            return mapped
    return "draft"


def retention_years(tier: int) -> int:
    return 7 if tier == 1 else (5 if tier == 2 else 3)


# ── Main ─────────────────────────────────────────────────────────────────────

def main():
    if len(sys.argv) < 2:
        print("Usage: import_from_logicgate.py <csv_file>")
        sys.exit(1)

    csv_path = sys.argv[1]
    counters = defaultdict(int)
    created = skipped = 0

    with open(csv_path, encoding="utf-8-sig", newline="") as f:
        reader = csv.DictReader(f)
        rows = list(reader)

    # Sort for deterministic ID assignment: domain → tier → name
    rows.sort(key=lambda r: (r.get("DOMAIN", ""), r.get("TIER", ""), r.get("NAME", "")))

    for row in rows:
        raw_name  = row.get("NAME", "").strip()
        domain_raw = row.get("DOMAIN", "").strip()
        domain    = DOMAIN_SLUG.get(domain_raw, slugify(domain_raw))
        tier      = tier_num(row.get("TIER", "Tier 2"))
        doc_type  = doc_type_str(row.get("DOCUMENT_TYPE", "1"))
        status    = status_str(row.get("WORKFLOW_STATUS", ""), row.get("DRAFT_STATUS", ""))
        owner     = (row.get("DOCUMENT_OWNER_NAME") or "").strip() or "Unassigned"
        board_req = row.get("REQUIRED_BOARD_APPROVAL", "")
        pub_date  = parse_date(row.get("PUBLICATION_DATE", ""))
        approval_date = parse_date(row.get("DATE_OF_FINAL_APPROVAL", ""))
        due_date  = parse_date(row.get("DUE_DATE", ""))
        pdf_link  = (row.get("LINK_TO_PUBLISHED_PDF") or "").strip()
        legal_entity = (row.get("LEGAL_ENTITY") or "Block, Inc.").strip()
        business  = (row.get("BUSINESS") or "Block").strip()
        record_id = (row.get("PWF_RECORD_ID") or "").strip()

        title = clean_name(raw_name)
        if not title:
            continue

        # Assign sequential doc ID
        prefix = PREFIX.get(domain, domain[:3].upper())
        counters[domain] += 1
        doc_id = f"{prefix}-{counters[domain]:03d}"

        # Determine file path
        domain_dir = os.path.join("docs", domain)
        os.makedirs(domain_dir, exist_ok=True)
        filename = f"{doc_id}-{slugify(title)}.md"
        filepath = os.path.join(domain_dir, filename)

        if os.path.exists(filepath):
            skipped += 1
            continue

        appr = approval_type(tier, board_req)
        effective = pub_date or approval_date or ""
        ret_years = retention_years(tier)

        # Build frontmatter
        lines = [
            "---",
            f"doc_id: {doc_id}",
            f'title: "{title}"',
            f"version: 1.0.0",
            f"status: {status}",
            f"tier: {tier}",
            f"domain: {domain}",
            f'legal_entity: "{legal_entity}"',
            f'business: "{business}"',
            f'owner: "{owner}"',
            f"approval_type: {appr}",
            f"reviewers: []",
            f"effective_date: \"{effective}\"",
            f"next_review_date: \"{due_date or ''}\"",
            f"retention_years: {ret_years}",
        ]
        if pdf_link:
            lines.append(f'published_pdf: "{pdf_link}"')
        if record_id:
            lines.append(f'logicgate_record_id: "{record_id}"')
        lines += [
            "---",
            "",
            f"## {title}",
            "",
            f"> **Document type:** {doc_type}  ",
            f"> **Domain:** {domain_raw}  ",
            f"> **Legal entity:** {legal_entity}  ",
            "",
            "<!-- Document body to be populated from LogicGate published PDF or manual authoring. -->",
            "",
            "## Revision History",
            "",
            "| Version | Date | Author | Summary of Changes |",
            "|---------|------|--------|-------------------|",
            f"| 1.0.0 | {effective or date.today().isoformat()} | {owner} | Imported from LogicGate |",
        ]

        with open(filepath, "w", encoding="utf-8") as out:
            out.write("\n".join(lines) + "\n")

        created += 1
        print(f"  created  {filepath}")

    print(f"\nDone: {created} created, {skipped} skipped (already exist).")


if __name__ == "__main__":
    main()
