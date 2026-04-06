#!/usr/bin/env python3
"""
Checks all compliance documents for overdue reviews and retention policy.
When run with --open-issues, creates GitHub Issues for any findings.

Scheduled weekly by retention-check.yml GitHub Actions workflow.

Usage:
    python scripts/retention_check.py docs/
    python scripts/retention_check.py docs/ --open-issues
"""

import argparse
import json
import os
import subprocess
import sys
from datetime import date, timedelta

import yaml

WARNING_DAYS = 30  # flag documents whose review is due within this many days


def parse_frontmatter(path: str) -> dict:
    with open(path, encoding="utf-8") as f:
        content = f.read()
    if not content.startswith("---"):
        return {}
    parts = content.split("---", 2)
    if len(parts) < 3:
        return {}
    return yaml.safe_load(parts[1]) or {}


def collect_docs(root: str):
    docs = []
    for dirpath, _, filenames in os.walk(root):
        if "_templates" in dirpath:
            continue
        for fn in filenames:
            if fn.endswith(".md"):
                docs.append(os.path.join(dirpath, fn))
    return sorted(docs)


def load_open_issue_titles(repo: str, token: str) -> set:
    """Returns the set of titles of all open compliance-review issues."""
    if not repo or not token:
        return set()
    result = subprocess.run(
        ["gh", "issue", "list",
         "--repo", repo,
         "--label", "compliance-review",
         "--state", "open",
         "--limit", "500",
         "--json", "title"],
        capture_output=True, text=True,
        env={**os.environ, "GH_TOKEN": token}
    )
    if result.returncode != 0:
        print(f"  Warning: could not fetch open issues: {result.stderr.strip()}")
        return set()
    try:
        return {item["title"] for item in json.loads(result.stdout)}
    except (json.JSONDecodeError, KeyError):
        return set()


def open_github_issue(title: str, body: str, existing_titles: set):
    repo = os.environ.get("GH_REPO", "")
    token = os.environ.get("GH_TOKEN", "")
    if not repo or not token:
        print(f"  (would open issue: {title})")
        return

    if title in existing_titles:
        print(f"  Skipped (already open): {title}")
        return

    result = subprocess.run(
        ["gh", "issue", "create",
         "--repo", repo,
         "--title", title,
         "--body", body,
         "--label", "compliance-review"],
        capture_output=True, text=True,
        env={**os.environ, "GH_TOKEN": token}
    )
    if result.returncode == 0:
        existing_titles.add(title)  # prevent re-creation within the same run
        print(f"  Issue created: {result.stdout.strip()}")
    else:
        print(f"  Failed to create issue: {result.stderr.strip()}")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("root", help="Root docs directory")
    parser.add_argument("--open-issues", action="store_true")
    args = parser.parse_args()

    docs = collect_docs(args.root)
    today = date.today()
    warn_threshold = today + timedelta(days=WARNING_DAYS)
    findings = []

    for path in docs:
        meta = parse_frontmatter(path)
        if not meta.get("doc_id"):
            continue

        doc_id = meta["doc_id"]
        title = meta.get("title", path)
        owner = meta.get("owner", "unknown")
        status = meta.get("status", "")
        next_review = meta.get("next_review_date")

        if status == "retired":
            continue

        if not next_review:
            findings.append({
                "level": "warning",
                "doc_id": doc_id,
                "title": title,
                "owner": owner,
                "file": path,
                "issue": "Missing next_review_date",
            })
            continue

        if isinstance(next_review, str):
            next_review = date.fromisoformat(next_review)

        if next_review < today:
            days_overdue = (today - next_review).days
            findings.append({
                "level": "overdue",
                "doc_id": doc_id,
                "title": title,
                "owner": owner,
                "file": path,
                "next_review_date": str(next_review),
                "issue": f"Review overdue by {days_overdue} day(s)",
            })
        elif next_review <= warn_threshold:
            days_until = (next_review - today).days
            findings.append({
                "level": "upcoming",
                "doc_id": doc_id,
                "title": title,
                "owner": owner,
                "file": path,
                "next_review_date": str(next_review),
                "issue": f"Review due in {days_until} day(s)",
            })

    if not findings:
        print(f"All {len(docs)} document(s) are within review schedule.")
        sys.exit(0)

    # Load existing open issues once to avoid duplicates across weekly runs
    existing_titles: set = set()
    if args.open_issues:
        repo = os.environ.get("GH_REPO", "")
        token = os.environ.get("GH_TOKEN", "")
        existing_titles = load_open_issue_titles(repo, token)
        print(f"  {len(existing_titles)} open compliance-review issue(s) already exist — skipping duplicates.")

    for f in findings:
        level = f["level"].upper()
        print(f"[{level}] {f['doc_id']} — {f['issue']} (owner: {f['owner']}, file: {f['file']})")

        if args.open_issues and f["level"] in ("overdue", "warning"):
            issue_title = f"[Compliance Review] {f['doc_id']}: {f['issue']}"
            issue_body = (
                f"**Document:** {f['title']}\n"
                f"**ID:** {f['doc_id']}\n"
                f"**Owner:** {f['owner']}\n"
                f"**File:** `{f['file']}`\n"
                f"**Finding:** {f['issue']}\n\n"
                f"Please initiate a review PR using the `policy-change` PR template."
            )
            open_github_issue(issue_title, issue_body, existing_titles)

    overdue = sum(1 for f in findings if f["level"] == "overdue")
    print(f"\n{len(findings)} finding(s): {overdue} overdue.")
    sys.exit(1 if overdue else 0)


if __name__ == "__main__":
    main()
