# block-compliance-policies

GitHub-based compliance document management system for Block Inc., satisfying GRC requirements for versioning, retention, audit trails, and approval workflows.

---

## Design

### Core principle

Git is the system of record. Every GRC requirement maps to a native Git/GitHub primitive — no extra tooling required to satisfy auditors.

---

### Repo structure

```
compliance-dms/
├── docs/
│   ├── financial-crimes/
│   │   ├── POL-001-sanctions-policy.md
│   │   └── POL-002-aml-ctf-policy.md
│   ├── governance/
│   │   └── POL-003-...
│   └── _templates/
│       ├── policy.md
│       └── procedure.md
├── .github/
│   ├── CODEOWNERS                    # routes approvals by domain/tier
│   ├── workflows/
│   │   ├── validate.yml              # metadata lint on every PR
│   │   ├── audit-log.yml             # appends to audit trail on merge
│   │   └── retention-check.yml      # flags overdue reviews (scheduled)
│   └── PULL_REQUEST_TEMPLATE/
│       ├── policy-change.md
│       └── new-document.md
├── audit/
│   └── audit-log.jsonl               # append-only, committed by CI
└── scripts/
    ├── validate_metadata.py
    ├── append_audit_entry.py
    └── retention_check.py
```

---

### How each GRC requirement is met

| Requirement | Mechanism |
|---|---|
| **Versioning** | Semantic version in doc frontmatter (`v2.1.0`); Git tag on merge (`POL-001@v2.1.0`) |
| **Audit trail** | CI appends a signed JSON entry to `audit/audit-log.jsonl` on every merge; immutable via branch protection |
| **Retention** | `retention_years` in frontmatter; scheduled workflow flags expired/overdue docs as GitHub Issues |
| **Approval workflows** | CODEOWNERS routes by domain + tier; Tier 1 requires Board-level reviewers, Tier 2 requires Committee; branch protection enforces N approvals before merge |

---

### Document frontmatter (YAML header in every `.md`)

```yaml
---
doc_id: POL-001
title: Block Inc. Global Sanctions Policy
version: 2.1.0
status: published          # draft | in-review | published | retired
tier: 1
domain: financial-crimes
legal_entity: Block, Inc.
business: Block
owner: Faisal Sohail
approval_type: board       # board | committee
reviewers: []
effective_date: 2025-01-01
next_review_date: 2026-01-01
retention_years: 7
---
```

---

### CODEOWNERS routing logic

```
# Tier 1 — requires Board approval (2 reviewers from board group)
docs/financial-crimes/POL-001-*    @block/compliance-board @block/legal

# All Tier 1 docs default
docs/financial-crimes/             @block/compliance-board

# Tier 2 — committee approval
docs/governance/                   @block/compliance-committee

# Audit log is protected — only CI can touch it
audit/                             @block/compliance-ci-bot
```

---

### Audit log entry (appended by CI on every merge)

```json
{
  "timestamp": "2025-06-01T14:32:00Z",
  "event": "document_approved",
  "doc_id": "POL-001",
  "version": "2.1.0",
  "actor": "faisalsohail",
  "reviewers": ["ktriemstra", "jsmith"],
  "pr_number": 42,
  "pr_url": "https://github.com/hreynolds95/block-compliance-policies/pull/42",
  "commit_sha": "abc123def456",
  "git_tag": "POL-001@v2.1.0"
}
```

---

### Workflow: approving a document change

1. Author branches off `main`, edits the `.md`, bumps `version`, updates `effective_date`
2. Opens PR using the `policy-change` template (checklist: owner sign-off, legal review, effective date set)
3. CI runs `validate_metadata.py` — blocks merge if required frontmatter fields are missing or malformed
4. CODEOWNERS auto-requests reviewers based on domain/tier
5. Required approvals satisfied → merge unblocked
6. On merge: CI appends audit entry, creates Git tag `POL-001@v2.1.0`, optionally publishes to a static site

---

## Branch protection (configure after repo creation)

Go to **Settings → Branches → Add rule** for the `main` branch:

- [x] Require a pull request before merging
- [x] Require approvals: **2** (Tier 1) / **1** (Tier 2)
- [x] Require review from Code Owners
- [x] Require status checks to pass: `validate-metadata`
- [x] Do not allow bypassing the above settings
- [x] Restrict who can push to matching branches
- [x] **Disable force pushes** (critical for audit trail integrity)
- [x] **Do not allow deletions**

---

## Local setup

```bash
git clone https://github.com/hreynolds95/block-compliance-policies.git
cd block-compliance-policies
pip install pyyaml
```

**Validate all documents locally:**
```bash
python scripts/validate_metadata.py docs/
```

**Run retention check locally:**
```bash
python scripts/retention_check.py docs/
```
