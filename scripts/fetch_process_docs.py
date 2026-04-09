#!/usr/bin/env python3
"""
Export process procedure Google Docs as plain text for Quincy indexing.

Reads process-docs/manifest.json, exports each Google Doc via the Drive API,
and writes plain text to process-text-cache/<proc_id>.txt.

Usage:
    python scripts/fetch_process_docs.py              # fetch all
    python scripts/fetch_process_docs.py --id PROC-001  # single doc

Credentials: ~/.config/gdrive-skill/credentials.json (same as extract_pdf_text.py)
Run generate_process_index.py afterwards to rebuild site/process-index.json.
"""

import argparse
import io
import json
import re
import sys
import warnings
from pathlib import Path

warnings.filterwarnings("ignore", category=FutureWarning)

import pdfplumber
from google.oauth2.credentials import Credentials
from google.auth.transport.requests import Request
from googleapiclient.discovery import build
from googleapiclient.errors import HttpError

SLIDES_MIME = "application/vnd.google-apps.presentation"


def fix_doubled_chars(text):
    """Fix font-rendering artifact where each character is doubled (e.g. 'bblloocckk' → 'block')."""
    def fix_word(m):
        w = m.group(0)
        if len(w) >= 4 and len(w) % 2 == 0 and all(w[i] == w[i + 1] for i in range(0, len(w) - 1, 2)):
            return w[::2]
        return w
    return re.sub(r'[A-Za-z]{4,}', fix_word, text)

MANIFEST_PATH = Path("process-docs/manifest.json")
CACHE_DIR     = Path("process-text-cache")
CREDS_PATH    = Path.home() / ".config/gdrive-skill/credentials.json"


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


def fetch_doc(service, proc_id, google_doc_id, title, file_type="doc"):
    print(f"  Fetching {proc_id}: {title} ...", end=" ")
    try:
        from googleapiclient.http import MediaIoBaseDownload

        # file_type="slides" uses PDF export + pdfplumber; anything else uses plain text
        is_slides = file_type == "slides"

        buf = io.BytesIO()
        mime = "application/pdf" if is_slides else "text/plain"
        downloader = MediaIoBaseDownload(buf, service.files().export_media(fileId=google_doc_id, mimeType=mime))
        done = False
        while not done:
            _, done = downloader.next_chunk()

        if is_slides:
            buf.seek(0)
            pages = []
            with pdfplumber.open(buf) as pdf:
                for page in pdf.pages:
                    t = page.extract_text() or ""
                    if t.strip():
                        pages.append(t)
            text = fix_doubled_chars("\n".join(pages))
        else:
            text = buf.getvalue().decode("utf-8", errors="replace")

        out_path = CACHE_DIR / f"{proc_id}.txt"
        out_path.write_text(text, encoding="utf-8")
        words = len(text.split())
        print(f"ok ({words:,} words{'  [slides→pdf]' if is_slides else ''})")
        return True
    except HttpError as e:
        print(f"FAILED ({e.status_code}: {e.reason})")
        return False


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--id", dest="proc_id", help="Fetch a single PROC-NNN doc only")
    args = parser.parse_args()

    if not MANIFEST_PATH.exists():
        print(f"ERROR: {MANIFEST_PATH} not found. Run from repo root.")
        sys.exit(1)

    manifest = json.loads(MANIFEST_PATH.read_text())
    CACHE_DIR.mkdir(exist_ok=True)

    if args.proc_id:
        manifest = [d for d in manifest if d["proc_id"] == args.proc_id]
        if not manifest:
            print(f"ERROR: {args.proc_id} not found in manifest")
            sys.exit(1)

    creds   = load_credentials()
    service = build("drive", "v3", credentials=creds, cache_discovery=False)

    ok = failed = 0
    for doc in manifest:
        success = fetch_doc(service, doc["proc_id"], doc["google_doc_id"], doc["title"], doc.get("file_type", "doc"))
        if success:
            ok += 1
        else:
            failed += 1

    print(f"\nDone: {ok} fetched, {failed} failed")
    if ok:
        print("Run: python scripts/generate_process_index.py")


if __name__ == "__main__":
    main()
