#!/usr/bin/env python3
"""
Download published PDFs from Google Drive and extract plain text for search indexing.

Default mode (incremental): only re-extracts a doc if its effective_date in the
frontmatter is newer than the existing pdf-text-cache/<doc_id>.txt file.
This means after a full initial run, subsequent runs are fast — only recently
published or updated policies are re-downloaded.

Run generate_search_index.py afterwards to rebuild site/search-index.json.

Usage:
    python scripts/extract_pdf_text.py                  # incremental (default)
    python scripts/extract_pdf_text.py --force          # re-extract all
    python scripts/extract_pdf_text.py --doc-id CP-001  # single doc

Credentials: ~/.config/gdrive-skill/credentials.json (refresh token, no re-auth needed)
"""

import argparse
import io
import json
import re
import sys
import time
import warnings
from datetime import date, datetime, timezone
from pathlib import Path

warnings.filterwarnings("ignore", category=FutureWarning)  # suppress Python 3.9 EOL noise

import pdfplumber
import yaml
from google.oauth2.credentials import Credentials
from google.auth.transport.requests import Request
from googleapiclient.discovery import build
from googleapiclient.http import MediaIoBaseDownload
from googleapiclient.errors import HttpError

DOCS_ROOT  = Path("docs")
CACHE_DIR  = Path("pdf-text-cache")
CREDS_PATH = Path.home() / ".config/gdrive-skill/credentials.json"
FILE_ID_RE = re.compile(r"/file/d/([^/?#]+)")

# ── Credentials ───────────────────────────────────────────────────────────────

def load_credentials():
    if not CREDS_PATH.exists():
        print(f"ERROR: credentials not found at {CREDS_PATH}")
        sys.exit(1)
    raw = json.loads(CREDS_PATH.read_text())
    creds = Credentials(
        token         = raw.get("token"),
        refresh_token = raw["refresh_token"],
        token_uri     = raw["token_uri"],
        client_id     = raw["client_id"],
        client_secret = raw["client_secret"],
        scopes        = raw.get("scopes") or ["https://www.googleapis.com/auth/drive.readonly"],
    )
    if not creds.valid:
        creds.refresh(Request())
    return creds

# ── Frontmatter parser ────────────────────────────────────────────────────────

def iter_docs():
    """Yield (doc_id, pdf_url, effective_date) for every doc with a published_pdf field."""
    for path in sorted(DOCS_ROOT.rglob("*.md")):
        if "_templates" in path.parts:
            continue
        text = path.read_text(encoding="utf-8")
        if not text.startswith("---"):
            continue
        parts = text.split("---", 2)
        if len(parts) < 3:
            continue
        meta = yaml.safe_load(parts[1]) or {}
        doc_id  = meta.get("doc_id")
        pdf_url = meta.get("published_pdf")
        if doc_id and pdf_url:
            yield doc_id, str(pdf_url), meta.get("effective_date")

def extract_file_id(url):
    m = FILE_ID_RE.search(url)
    return m.group(1) if m else None

def effective_date_as_utc(eff):
    """Convert a date or string effective_date to a UTC timestamp, or 0 if unavailable."""
    if isinstance(eff, date) and not isinstance(eff, datetime):
        return datetime(eff.year, eff.month, eff.day, tzinfo=timezone.utc).timestamp()
    if isinstance(eff, str):
        try:
            d = date.fromisoformat(eff)
            return datetime(d.year, d.month, d.day, tzinfo=timezone.utc).timestamp()
        except ValueError:
            pass
    return 0

# ── Download + extract ────────────────────────────────────────────────────────

def download_pdf(service, file_id):
    request = service.files().get_media(fileId=file_id)
    buf = io.BytesIO()
    dl = MediaIoBaseDownload(buf, request)
    done = False
    while not done:
        _, done = dl.next_chunk()
    buf.seek(0)
    return buf.read()

def extract_text(pdf_bytes):
    with pdfplumber.open(io.BytesIO(pdf_bytes)) as pdf:
        pages = []
        for page in pdf.pages:
            t = page.extract_text()
            if t:
                pages.append(t.strip())
        return "\n\n".join(pages)

# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--force",  action="store_true",
                        help="Re-extract all docs regardless of cache state")
    parser.add_argument("--doc-id", help="Extract a single doc by ID (e.g. CP-001)")
    args = parser.parse_args()

    CACHE_DIR.mkdir(exist_ok=True)

    creds   = load_credentials()
    service = build("drive", "v3", credentials=creds, cache_discovery=False)

    docs = list(iter_docs())
    if args.doc_id:
        docs = [(d, u, e) for d, u, e in docs if d == args.doc_id]
        if not docs:
            print(f"ERROR: {args.doc_id} not found or has no published_pdf")
            sys.exit(1)

    ok = skipped = updated = stale = errors = 0

    for doc_id, url, effective_date in docs:
        out_path = CACHE_DIR / f"{doc_id}.txt"

        if not args.force and out_path.exists():
            cache_mtime  = out_path.stat().st_mtime
            eff_ts       = effective_date_as_utc(effective_date)
            if eff_ts <= cache_mtime:
                skipped += 1
                continue
            # effective_date is newer than cache — re-extract
            print(f"  UPDATE {doc_id}: effective_date {effective_date} is newer than cache")
            updated += 1

        file_id = extract_file_id(url)
        if not file_id:
            print(f"  WARN  {doc_id}: could not parse file ID from URL: {url}")
            stale += 1
            continue

        try:
            pdf_bytes = download_pdf(service, file_id)
            text      = extract_text(pdf_bytes)
            if not text.strip():
                print(f"  WARN  {doc_id}: PDF downloaded but no text extracted (may be scanned image)")
                errors += 1
                continue
            out_path.write_text(text, encoding="utf-8")
            print(f"  OK    {doc_id}: {len(text):,} chars")
            ok += 1
            time.sleep(0.3)  # gentle rate limit

        except HttpError as e:
            if e.resp.status == 404:
                print(f"  STALE {doc_id}: file not found in Drive (stale link)")
                stale += 1
            elif e.resp.status == 403:
                print(f"  PERM  {doc_id}: permission denied — check Drive sharing")
                errors += 1
            else:
                print(f"  ERR   {doc_id}: HTTP {e.resp.status} — {e}")
                errors += 1

        except Exception as e:
            print(f"  ERR   {doc_id}: {e}")
            errors += 1

    print(f"\nDone: {ok} newly extracted, {updated} updated (effective_date changed), "
          f"{skipped} skipped (up to date), {stale} stale links, {errors} errors")
    print(f"Next: python scripts/generate_search_index.py")


if __name__ == "__main__":
    main()
