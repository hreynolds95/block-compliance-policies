#!/usr/bin/env python3
"""One-shot script to import 24 missing retired docs from dashboard-data.json."""
import json, os, re

with open('/Users/hreynolds/Documents/compliance-dashboard-blockcell/dashboard-data.json') as f:
    d = json.load(f)

# Get existing logicgate_record_ids
existing_ids = set()
for dirpath, _, files in os.walk('docs'):
    for fn in files:
        if not fn.endswith('.md'): continue
        with open(os.path.join(dirpath, fn)) as f2:
            content = f2.read()
        m = re.search(r'^logicgate_record_id:\s*"?([^"\n]+)"?', content, re.MULTILINE)
        if m: existing_ids.add(m.group(1).strip())

retired = [r for r in d['rows'] if r.get('WORKFLOW_STATUS') == 'Retired'
           and r.get('PWF_RECORD_ID','').strip() not in existing_ids]
retired.sort(key=lambda r: (r.get('DOMAIN',''), r.get('NAME','')))

DOMAIN_SLUG = {
    'Consumer Protection':         'consumer-protection',
    'Ethics and Employee Conduct': 'ethics-and-employee-conduct',
    'Financial Crimes':            'financial-crimes',
    'Governance':                  'governance',
}
PREFIX = {
    'consumer-protection':         'CP',
    'ethics-and-employee-conduct': 'EE',
    'financial-crimes':            'FC',
    'governance':                  'GOV',
}
DOC_TYPE_LABEL = {'1': 'Policy', '2': 'Standard', '3': 'Procedure'}
APPROVAL_MAP = {'Board': 'board', 'Committee': 'committee', 'Document Owner, Leadership': 'owner'}

def slugify(text):
    text = re.sub(r'[^\w\s-]', '', text.lower())
    text = re.sub(r'[\s_]+', '-', text.strip())
    return re.sub(r'-+', '-', text)[:80].rstrip('-')

def clean_name(name):
    return re.sub(r'\s+Draft(\s+\(.*?\))?\s*$', '', name, flags=re.IGNORECASE).strip()

def tier_num(tier_str):
    m = re.search(r'\d', tier_str or '')
    return int(m.group()) if m else 2

def retention(tier):
    return 7 if tier == 1 else (5 if tier == 2 else 3)

def parse_date(val):
    if not val or str(val).strip() in ('', 'None', 'NULL'): return ''
    return str(val).strip()[:10]

counters = {'CP': 61, 'EE': 15, 'FC': 47, 'GOV': 50}
created = 0

for row in retired:
    domain_raw = row.get('DOMAIN','').strip()
    domain_slug = DOMAIN_SLUG.get(domain_raw)
    if not domain_slug:
        print(f"  SKIP unknown domain: {domain_raw}")
        continue

    prefix = PREFIX[domain_slug]
    counters[prefix] += 1
    doc_id = f"{prefix}-{counters[prefix]:03d}"

    title = clean_name(row.get('NAME','').strip())
    tier = tier_num(row.get('TIER',''))
    approval_routing = (row.get('APPROVAL_ROUTING_LEVELS') or '').strip()
    if approval_routing in APPROVAL_MAP:
        approval_type = APPROVAL_MAP[approval_routing]
    else:
        approval_type = 'board' if tier == 1 else ('owner' if tier == 3 else 'committee')

    owner_name = (row.get('DOCUMENT_OWNER_NAME') or '').strip()
    legal_entity = (row.get('LEGAL_ENTITY') or '').strip()
    business = (row.get('BUSINESS') or '').strip()
    effective_date = parse_date(row.get('DATE_OF_FINAL_APPROVAL') or row.get('PUBLICATION_DATE') or '')
    retirement_date = parse_date(row.get('DOCUMENT_RETIREMENTDATE',''))
    published_pdf = (row.get('LINK_TO_PUBLISHED_PDF') or '').strip()
    if published_pdf in ('None', ''): published_pdf = ''
    record_id = row.get('PWF_RECORD_ID','').strip()
    doc_type = DOC_TYPE_LABEL.get(str(row.get('DOCUMENT_TYPE','')).split('.')[0].strip(), 'Policy')
    ret_years = retention(tier)

    slug = slugify(title)
    filename = f"{doc_id.lower()}-{slug}.md"
    dirpath = f"docs/{domain_slug}"
    os.makedirs(dirpath, exist_ok=True)
    filepath = os.path.join(dirpath, filename)

    if os.path.exists(filepath):
        print(f"  EXISTS {filepath}")
        continue

    rev_date = retirement_date or effective_date or '2025-10-23'
    pdf_line = f'published_pdf: "{published_pdf}"' if published_pdf else ''
    retired_note = f" — {retirement_date}" if retirement_date else ""

    lines = [
        "---",
        f'doc_id: {doc_id}',
        f'title: "{title}"',
        "version: 1.0.0",
        "status: retired",
        f"tier: {tier}",
        f"domain: {domain_slug}",
        f'legal_entity: "{legal_entity}"',
        f'business: "{business}"',
        f'owner: "{owner_name}"',
        f"approval_type: {approval_type}",
        "reviewers: []",
        f'effective_date: "{effective_date}"',
        f'retirement_date: "{retirement_date}"',
        'next_review_date: ""',
        'due_date_status: "Complete"',
        f"retention_years: {ret_years}",
    ]
    if pdf_line:
        lines.append(pdf_line)
    lines += [
        f'logicgate_record_id: "{record_id}"',
        "---",
        "",
        f"## {title}",
        "",
        f"> **Document type:** {doc_type}",
        f"> **Domain:** {domain_raw}",
        f"> **Legal entity:** {legal_entity}",
        f"> **Status:** Retired{retired_note}",
        "",
        "<!-- Document body to be populated from LogicGate published PDF or manual authoring. -->",
        "",
        "## Revision History",
        "",
        "| Version | Date | Author | Summary of Changes |",
        "|---------|------|--------|-------------------|",
        f"| 1.0.0 | {rev_date} | {owner_name or 'Unknown'} | Imported from LogicGate (retired) |",
        "",
    ]

    with open(filepath, 'w') as out:
        out.write('\n'.join(lines))
    print(f"  CREATED {filepath}")
    created += 1

print(f"\nDone: {created} stubs created")
