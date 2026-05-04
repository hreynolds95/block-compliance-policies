/* Block Compliance Policy Library — GitHub Pages UI */

let allDocs = [];
let auditEntries = [];
let sortCol = 'doc_id';
let sortAsc = true;
let recentDays   = null;  // set by ?recent=N URL param
let filterMonth  = null;  // set by ?month=YYYY-MM URL param (from review schedule chart)

// ── Full-text search index (lazy-loaded on first search focus) ───────────────

let searchIndex = null;       // Map<doc_id, content string> once loaded
let searchIndexState = 'idle'; // 'idle' | 'loading' | 'ready' | 'failed'

function ensureSearchIndex() {
  if (searchIndexState !== 'idle') return;
  searchIndexState = 'loading';
  fetch('./search-index.json')
    .then(r => r.ok ? r.json() : Promise.reject('not ok'))
    .then(data => {
      searchIndex = new Map(Object.entries(data.documents || {}));
      searchIndexState = 'ready';
      // Re-render if user already typed something while index was loading
      if (document.getElementById('searchInput').value.trim()) {
        renderTable(filteredDocs());
      }
    })
    .catch(() => { searchIndexState = 'failed'; });
}

// ── Bootstrap ───────────────────────────────────────────────────────────────

async function init() {
  const [docsRes, auditRes] = await Promise.allSettled([
    fetch('./docs-data.json'),
    fetch('./audit-log.jsonl'),
  ]);

  if (docsRes.status === 'fulfilled' && docsRes.value.ok) {
    const data = await docsRes.value.json();
    allDocs = data.documents || [];
    if (window.quincyInit) window.quincyInit(allDocs, { page: 'library', getContext: getActiveLibraryContext });
    const active = allDocs.filter(d => d.status === 'published').length;
    const intake = allDocs.filter(d => d.status !== 'published').length;
    const badge = document.getElementById('dataSourceBadge');
    if (badge) {
      const refreshed = data.generated
        ? new Date(data.generated).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short', timeZone: 'America/New_York' })
        : '—';
      badge.innerHTML = `Data Source: ${data.source || 'LogicGate → Snowflake'}<br>Last refreshed: ${refreshed}`;
    }
    populateDomainFilter(allDocs);
    populateBusinessFilter(allDocs);
    populateEntityFilter(allDocs);
    populateOwnerFilter(allDocs);
    renderHeroStats(allDocs, data.generated);
    applyUrlFilters();
    renderTable(filteredDocs());
  } else {
  }

  if (auditRes.status === 'fulfilled' && auditRes.value.ok) {
    const text = await auditRes.value.text();
    auditEntries = text.trim().split('\n').filter(Boolean).map(l => JSON.parse(l)).reverse();
    renderAuditLog(auditEntries);
  } else {
    document.getElementById('auditList').innerHTML =
      '<div class="empty-state">Audit log unavailable.</div>';
  }

  document.getElementById('drawerClose').addEventListener('click', closeDetailDrawer);
  document.getElementById('drawerBackdrop').addEventListener('click', closeDetailDrawer);
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeDetailDrawer(); });
}

// ── Hero stats line ──────────────────────────────────────────────────────────

function renderHeroStats(docs, generated) {
  const el = document.getElementById('heroStats');
  if (!el) return;
  const active  = docs.filter(d => d.status === 'published').length;
  const overdue = docs.filter(d => ['overdue','pending-review','overdue-past-extension'].includes(d.review_status)).length;
  const refreshed = generated
    ? new Date(generated).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
    : null;
  const ovHtml = overdue > 0
    ? `<span class="stat-danger">${overdue}</span> overdue`
    : `<span class="stat-val">0</span> overdue`;
  el.innerHTML =
    `<span class="stat-val">${active}</span> active` +
    `<span class="stat-sep">·</span>${ovHtml}` +
    (refreshed ? `<span class="stat-sep">·</span>refreshed ${refreshed}` : '');
}

// ── Domain filter ────────────────────────────────────────────────────────────

function populateDomainFilter(docs) {
  const domains = [...new Set(docs.map(d => d.domain).filter(Boolean))].sort();
  const sel = document.getElementById('filterDomain');
  domains.forEach(dom => {
    const opt = document.createElement('option');
    opt.value = dom;
    opt.textContent = domainLabel(dom);
    sel.appendChild(opt);
  });
}

function populateBusinessFilter(docs) {
  const businesses = [...new Set(docs.map(d => d.business).filter(Boolean))].sort();
  const sel = document.getElementById('filterBusiness');
  businesses.forEach(b => {
    const opt = document.createElement('option');
    opt.value = b;
    opt.textContent = b;
    sel.appendChild(opt);
  });
}

function populateEntityFilter(docs) {
  const entities = [...new Set(docs.map(d => d.legal_entity).filter(Boolean))].sort();
  const sel = document.getElementById('filterEntity');
  entities.forEach(e => {
    const opt = document.createElement('option');
    opt.value = e;
    opt.textContent = e;
    sel.appendChild(opt);
  });
}

function populateOwnerFilter(docs) {
  const owners = [...new Set(docs.map(d => d.owner).filter(Boolean))].sort();
  const sel = document.getElementById('filterOwner');
  owners.forEach(o => {
    const opt = document.createElement('option');
    opt.value = o;
    opt.textContent = o;
    sel.appendChild(opt);
  });
}

// ── Table rendering ──────────────────────────────────────────────────────────

function filteredDocs() {
  const q         = document.getElementById('searchInput').value.toLowerCase();
  const domain    = document.getElementById('filterDomain').value;
  const status    = document.getElementById('filterStatus').value;
  const business  = document.getElementById('filterBusiness').value;
  const entity    = document.getElementById('filterEntity').value;
  const owner     = document.getElementById('filterOwner').value;
  const tier      = document.getElementById('filterTier').value;
  const review    = document.getElementById('filterReview').value;
  const extension  = document.getElementById('filterExtension').value;
  const docType    = document.getElementById('filterDocType').value;
  const lifecycle  = document.getElementById('filterLifecycle').value;

  return allDocs
    .filter(d => {
      if (d.status === 'retired' && status !== 'retired') return false;
      if (q) {
        const metaMatch = `${d.doc_id} ${d.pwf_record_id ?? ''} ${d.title} ${d.owner} ${d.domain}`.toLowerCase().includes(q);
        const contentMatch = searchIndex?.get(d.doc_id)?.toLowerCase().includes(q) ?? false;
        if (!metaMatch && !contentMatch) return false;
      }
      if (domain && d.domain !== domain) return false;
      if (status === 'not-published' && !(d.status === 'draft' || d.status === 'in-review')) return false;
      else if (status && status !== 'not-published' && d.status !== status) return false;
      if (business && d.business !== business) return false;
      if (entity && d.legal_entity !== entity) return false;
      if (owner && d.owner !== owner) return false;
      if (tier && String(d.tier) !== tier) return false;
      if (review === 'overdue'    && !['overdue','pending-review','overdue-past-extension'].includes(d.review_status)) return false;
      else if (review === 'coming-due' && !['due-soon','extension-coming-due'].includes(d.review_status)) return false;
      else if (review && !['overdue','coming-due'].includes(review) && d.review_status !== review) return false;
      if (extension === 'active' && !d.extension_status) return false;
      if (extension && extension !== 'active' && d.extension_status !== extension) return false;
      if (docType && (d.doc_type || '') !== docType) return false;
      if (lifecycle && (d.lifecycle_status || '') !== lifecycle) return false;
      if (recentDays !== null) {
        const cutoff = new Date();
        cutoff.setDate(cutoff.getDate() - recentDays);
        const eff = d.effective_date ? new Date(d.effective_date) : null;
        if (!eff || eff < cutoff) return false;
      }
      if (filterMonth !== null) {
        if (!d.next_review_date || !d.next_review_date.startsWith(filterMonth)) return false;
      }
      return true;
    })
    .sort((a, b) => {
      let va, vb;

      if (sortCol === 'next_review_date') {
        // Sort by effective displayed date — extended_due_date takes precedence
        // for docs with an active extension, matching what the column shows.
        const eff = d => (d.extension_status && d.extended_due_date)
          ? d.extended_due_date : (d.next_review_date ?? '');
        va = eff(a); vb = eff(b);
      } else if (sortCol === 'review_status') {
        // Sort by urgency, not alphabetically.
        // Ascending (↑) = least urgent first; descending (↓) = most urgent first.
        const URGENCY = {
          'overdue-past-extension': 0,
          'overdue':                1,
          'pending-review':         2,
          'due-soon':               3,
          'extension-coming-due':   4,
          'ok':                     5,
          'unknown':                6,
        };
        va = URGENCY[a.review_status] ?? 7;
        vb = URGENCY[b.review_status] ?? 7;
        return sortAsc ? va - vb : vb - va;
      } else {
        va = (a[sortCol] ?? '').toString().toLowerCase();
        vb = (b[sortCol] ?? '').toString().toLowerCase();
      }

      return sortAsc ? va.toString().localeCompare(vb.toString())
                     : vb.toString().localeCompare(va.toString());
    });
}

function renderTable(docs) {
  const tbody  = document.getElementById('docTbody');
  const empty  = document.getElementById('emptyState');
  const visible = docs ?? filteredDocs();
  const q = document.getElementById('searchInput').value.toLowerCase();

  document.getElementById('resultCount').textContent =
    `${visible.length} of ${allDocs.length}`;

  if (!visible.length) {
    tbody.innerHTML = '';
    empty.style.display = '';
    return;
  }
  empty.style.display = 'none';

  tbody.innerHTML = visible.map(d => `
    <tr class="doc-row" data-doc-id="${esc(d.doc_id)}" style="cursor:pointer;">
      <td><span class="doc-id">${esc(d.doc_id)}</span></td>
      <td><span class="doc-title">${highlight(d.title, q)}</span></td>
      <td><span class="domain-label">${esc(domainLabel(d.domain))}</span></td>
      <td><span class="badge badge-tier${d.tier}">Tier ${esc(d.tier)}</span></td>
      <td><span class="doc-owner">${highlight(d.owner, q)}</span></td>
      <td>${d.extension_status ? `<span title="Extended to ${esc(d.extended_due_date ?? '?')}">${esc(d.extended_due_date ?? d.next_review_date ?? '—')}</span>` : esc(d.next_review_date ?? '—')}</td>
      <td>${d.status !== 'published' ? '<span class="review-pill pill-draft">Draft</span>' : reviewPill(d.review_status) + extensionPill(d.extension_status)}</td>
    </tr>
  `).join('');

  tbody.querySelectorAll('.doc-row').forEach(row => {
    row.addEventListener('click', () => {
      const doc = allDocs.find(d => d.doc_id === row.dataset.docId);
      if (doc) openDetailDrawer(doc);
    });
  });
}

// ── Detail drawer ────────────────────────────────────────────────────────────

function openDetailDrawer(doc) {
  const idEl     = document.getElementById('drawerDocId');
  const verEl    = document.getElementById('drawerVersion');
  const titleEl  = document.getElementById('drawerTitle');
  const pillsEl  = document.getElementById('drawerPills');
  const bodyEl   = document.getElementById('drawerBody');
  const footerEl = document.getElementById('drawerFooter');

  idEl.textContent  = doc.doc_id;
  verEl.textContent = `v${doc.version}`;
  titleEl.textContent = doc.title;

  pillsEl.innerHTML = `
    <span class="badge badge-${doc.status}">${esc(doc.status)}</span>
    ${reviewPill(doc.review_status, doc.status)}
    ${extensionPill(doc.extension_status)}
  `;

  const fields = [
    ['Domain',        domainLabel(doc.domain)],
    ['Tier',          `<span class="badge badge-tier${doc.tier}">Tier ${esc(doc.tier)}</span>`],
    ['Approval',      `<span class="badge badge-${doc.approval_type}">${esc(doc.approval_type)}</span>`],
    ['Owner',         esc(doc.owner || '—')],
    ['Business',      esc(doc.business || '—')],
    ['Legal Entity',  esc(doc.legal_entity || '—')],
    ['Effective Date',esc(doc.effective_date || '—')],
    ['Next Review',   esc(doc.next_review_date || '—')],
    ...(doc.extension_status ? [['Extended Due', esc(doc.extended_due_date || '—')]] : []),
    ['Retention',     doc.retention_years ? `${esc(doc.retention_years)} yrs` : '—'],
    ...(doc.pwf_record_id ? [['LogicGate ID', `<a href="https://block.logicgate.com/records/${esc(doc.pwf_record_id)}" target="_blank" rel="noopener" class="detail-value--mono detail-lg-link">${esc(doc.pwf_record_id)}</a>`]] : []),
    ...(doc.extension_reason ? [['Extension Reason', esc(doc.extension_reason)]] : []),
  ];

  bodyEl.innerHTML = `
    <div class="drawer-grid">
      ${fields.map(([label, val]) => `
        <div class="drawer-field">
          <span class="detail-label">${label}</span>
          <span class="detail-value">${val}</span>
        </div>`).join('')}
    </div>
    ${drawerAuditHistory(doc.doc_id)}
  `;

  footerEl.innerHTML = doc.published_pdf
    ? `<a href="${esc(doc.published_pdf)}" target="_blank" rel="noopener" class="drawer-pdf-btn">View PDF &#x2192;</a>`
    : '';

  document.getElementById('detailDrawer').classList.add('drawer--open');
  document.getElementById('drawerBackdrop').classList.add('drawer-backdrop--open');
  document.body.style.overflow = 'hidden';

  // highlight the selected row
  document.querySelectorAll('.doc-row--expanded').forEach(r => r.classList.remove('doc-row--expanded'));
  document.querySelectorAll(`.doc-row[data-doc-id="${CSS.escape(doc.doc_id)}"]`)
    .forEach(r => r.classList.add('doc-row--expanded'));
}

function drawerAuditHistory(docId) {
  const entries = auditEntries.filter(e => e.doc_id === docId);
  if (!entries.length) return '';
  const rows = entries.map(e => {
    const ts    = e.timestamp ? new Date(e.timestamp).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—';
    const ver   = e.version ? `v${e.version}` : '';
    const actor = e.actor ?? '—';
    const link  = e.run_url
      ? `<a href="${esc(e.run_url)}" target="_blank" rel="noopener" class="drawer-audit-link">${esc(actor)}</a>`
      : esc(actor);
    return `<div class="drawer-audit-row">
      <span class="audit-ts">${esc(ts)}</span>
      <span class="audit-id">${esc(ver)}</span>
      <span class="drawer-audit-actor">${link}</span>
    </div>`;
  }).join('');
  return `
    <div class="drawer-section-label">Approval History</div>
    <div class="drawer-audit">${rows}</div>
  `;
}

function closeDetailDrawer() {
  document.getElementById('detailDrawer').classList.remove('drawer--open');
  document.getElementById('drawerBackdrop').classList.remove('drawer-backdrop--open');
  document.body.style.overflow = '';
  document.querySelectorAll('.doc-row--expanded').forEach(r => r.classList.remove('doc-row--expanded'));
}

// ── Audit log ────────────────────────────────────────────────────────────────

function renderAuditLog(entries) {
  const el = document.getElementById('auditList');
  if (!entries.length) {
    el.innerHTML = '<div class="empty-state">No audit entries yet.</div>';
    return;
  }
  el.innerHTML = entries.map(e => {
    const ts   = e.timestamp ? new Date(e.timestamp).toLocaleString() : '—';
    const id   = e.doc_id ?? '—';
    const ver  = e.version ? `v${e.version}` : '';
    const desc = eventLabel(e.event, e.title, ver);
    const actor = e.actor ?? '—';
    const link  = e.run_url
      ? `<a href="${esc(e.run_url)}" target="_blank" rel="noopener" style="color:var(--info);text-decoration:none;">${esc(actor)}</a>`
      : esc(actor);
    return `
      <div class="audit-entry">
        <span class="audit-ts">${esc(ts)}</span>
        <span class="audit-id">${esc(id)}</span>
        <span class="audit-desc">${desc}</span>
        <span class="audit-actor">${link}</span>
      </div>`;
  }).join('');
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function esc(s) {
  return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function highlight(rawText, query) {
  const escaped = esc(rawText);
  if (!query) return escaped;
  const re = new RegExp(`(${query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi');
  return escaped.replace(re, '<mark class="search-hl">$1</mark>');
}

function domainLabel(d) {
  return (d || '').replace(/-/g, ' ');
}

function reviewPill(status) {
  const map = {
    ok:                       ['pill-ok',                     'OK'],
    'due-soon':               ['pill-due-soon',               'Due soon'],
    'pending-review':         ['pill-pending-review',         'Pending Review'],
    'extension-coming-due':   ['pill-extension-coming-due',   'Ext. Coming Due'],
    'overdue-past-extension': ['pill-overdue-past-extension', 'Overdue (Past Ext.)'],
    overdue:                  ['pill-overdue',                'Overdue'],
    unknown:                  ['pill-unknown',                'Unknown'],
  };
  const [cls, label] = map[status] ?? map.unknown;
  return `<span class="review-pill ${cls}">${label}</span>`;
}

function extensionPill(status) {
  if (!status) return '';
  const map = {
    'approved':    ['pill-extension-approved',    'Ext. Approved'],
    'in-progress': ['pill-extension-in-progress', 'Ext. Pending'],
  };
  const [cls, label] = map[status] ?? ['pill-unknown', status];
  return ` <span class="review-pill ${cls}">${label}</span>`;
}

function eventLabel(event, title, ver) {
  const t = esc(title || '');
  const v = esc(ver || '');
  switch (event) {
    case 'document_approved':     return `Approved ${t} ${v}`.trim();
    case 'repository_initialized': return 'Repository initialized';
    default:                       return esc(event);
  }
}

// ── CSV Export ───────────────────────────────────────────────────────────────

function exportToCsv(docs) {
  const cols = [
    ['ID',               d => d.doc_id],
    ['Title',            d => d.title],
    ['Domain',           d => d.domain],
    ['Tier',             d => d.tier],
    ['Status',           d => d.status],
    ['Owner',            d => d.owner],
    ['Next Review',      d => d.next_review_date ?? ''],
    ['Extended Due',     d => d.extended_due_date ?? ''],
    ['Review State',     d => d.review_status],
    ['Extension Status', d => d.extension_status ?? ''],
    ['Version',          d => d.version],
    ['Approval Type',    d => d.approval_type],
    ['Business',         d => d.business ?? ''],
    ['Legal Entity',     d => d.legal_entity ?? ''],
    ['Effective Date',   d => d.effective_date ?? ''],
    ['Retention (yrs)',  d => d.retention_years ?? ''],
    ['LogicGate ID',     d => d.pwf_record_id ?? ''],
    ['Published PDF',    d => d.published_pdf ?? ''],
  ];

  const escape = v => {
    const s = String(v ?? '');
    return s.includes(',') || s.includes('"') || s.includes('\n')
      ? `"${s.replace(/"/g, '""')}"` : s;
  };

  const header = cols.map(([h]) => h).join(',');
  const rows   = docs.map(d => cols.map(([, fn]) => escape(fn(d))).join(','));
  const csv    = [header, ...rows].join('\n');

  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  const date = new Date().toISOString().slice(0, 10);
  a.href     = url;
  a.download = `block-compliance-policy-library-${date}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

// ── Sorting ──────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  document.querySelectorAll('#docTable th[data-col]').forEach(th => {
    th.addEventListener('click', () => {
      const col = th.dataset.col;
      if (sortCol === col) {
        sortAsc = !sortAsc;
      } else {
        sortCol = col;
        sortAsc = true;
      }
      document.querySelectorAll('#docTable th').forEach(h => h.classList.remove('sorted'));
      th.classList.add('sorted');
      th.querySelector('.sort-arrow').textContent = sortAsc ? '↑' : '↓';
      renderTable(filteredDocs());
    });
  });

  document.getElementById('searchInput').addEventListener('focus', ensureSearchIndex, { once: true });

  ['searchInput', 'filterDomain', 'filterStatus', 'filterBusiness', 'filterEntity', 'filterOwner', 'filterTier', 'filterReview', 'filterExtension', 'filterDocType', 'filterLifecycle'].forEach(id => {
    document.getElementById(id).addEventListener('input', () => {
      updateFilterHighlights();
      renderTable(filteredDocs());
    });
  });

  document.getElementById('exportCsv').addEventListener('click', () => {
    exportToCsv(filteredDocs());
  });

  function clearAllFilters() {
    document.getElementById('searchInput').value     = '';
    document.getElementById('filterDomain').value    = '';
    document.getElementById('filterStatus').value    = '';
    document.getElementById('filterBusiness').value  = '';
    document.getElementById('filterEntity').value    = '';
    document.getElementById('filterOwner').value     = '';
    document.getElementById('filterTier').value      = '';
    document.getElementById('filterReview').value    = '';
    document.getElementById('filterExtension').value  = '';
    document.getElementById('filterDocType').value    = '';
    document.getElementById('filterLifecycle').value  = '';
    recentDays = null;
    filterMonth = null;
    const chip = document.getElementById('recentChip');
    if (chip) chip.style.display = 'none';
    const mchip = document.getElementById('monthChip');
    if (mchip) mchip.style.display = 'none';
    updateFilterHighlights();
    renderTable(filteredDocs());
  }

  document.getElementById('clearFilters').addEventListener('click', clearAllFilters);

  const recentChipClear = document.getElementById('recentChipClear');
  if (recentChipClear) {
    recentChipClear.addEventListener('click', () => {
      recentDays = null;
      document.getElementById('recentChip').style.display = 'none';
      updateFilterHighlights();
      renderTable(filteredDocs());
    });
  }

  const monthChipClear = document.getElementById('monthChipClear');
  if (monthChipClear) {
    monthChipClear.addEventListener('click', () => {
      filterMonth = null;
      document.getElementById('monthChip').style.display = 'none';
      updateFilterHighlights();
      renderTable(filteredDocs());
    });
  }

  // '/' focuses search (unless already typing in an input)
  document.addEventListener('keydown', e => {
    if (e.key === '/' && document.activeElement.tagName !== 'INPUT' && document.activeElement.tagName !== 'SELECT') {
      e.preventDefault();
      document.getElementById('searchInput').focus();
    }
  });

  // Mark default sort column
  const defaultTh = document.querySelector(`#docTable th[data-col="${sortCol}"]`);
  if (defaultTh) {
    defaultTh.classList.add('sorted');
    defaultTh.querySelector('.sort-arrow').textContent = '↑';
  }

  init();
});

function applyUrlFilters() {
  const params = new URLSearchParams(location.search);
  const filterMap = {
    review:    'filterReview',
    domain:    'filterDomain',
    status:    'filterStatus',
    business:  'filterBusiness',
    entity:    'filterEntity',
    owner:     'filterOwner',
    tier:      'filterTier',
    extension:  'filterExtension',
    doc_type:   'filterDocType',
    lifecycle:  'filterLifecycle',
  };
  Object.entries(filterMap).forEach(([param, id]) => {
    const val = params.get(param);
    if (val) document.getElementById(id).value = val;
  });
  const recent = params.get('recent');
  if (recent) {
    recentDays = parseInt(recent, 10);
    const chip = document.getElementById('recentChip');
    if (chip) {
      chip.querySelector('.filter-chip-x').textContent = '×';
      chip.style.display = '';
    }
  }
  const month = params.get('month');
  if (month && /^\d{4}-\d{2}$/.test(month)) {
    filterMonth = month;
    const mchip = document.getElementById('monthChip');
    if (mchip) {
      const MONTH_ABBR = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
      const [y, m] = month.split('-');
      mchip.querySelector('#monthChipLabel').textContent = `Due: ${MONTH_ABBR[+m-1]} ${y}`;
      mchip.style.display = '';
    }
  }
  updateFilterHighlights();
}

function getActiveLibraryContext() {
  const parts = [];
  const search = document.getElementById('searchInput')?.value?.trim();
  if (search) parts.push(`searching for "${search}"`);
  const checks = [
    ['filterDomain',   'domain'],
    ['filterStatus',   'status'],
    ['filterBusiness', 'business'],
    ['filterEntity',   'legal entity'],
    ['filterOwner',    'owner'],
    ['filterTier',     'tier'],
    ['filterReview',   'review status'],
    ['filterExtension','extension'],
    ['filterDocType',  'document type'],
    ['filterLifecycle','lifecycle'],
  ];
  for (const [id, label] of checks) {
    const val = document.getElementById(id)?.value;
    if (val) parts.push(`${label}: ${val}`);
  }
  if (recentDays)  parts.push(`recently published (last ${recentDays} days)`);
  if (filterMonth) parts.push(`review due month: ${filterMonth}`);
  return parts.length > 0
    ? `User is viewing the policy library filtered by: ${parts.join(', ')}.`
    : null;
}

function updateFilterHighlights() {
  const filterIds = ['filterDomain', 'filterStatus', 'filterBusiness', 'filterEntity', 'filterOwner', 'filterTier', 'filterReview', 'filterExtension', 'filterDocType', 'filterLifecycle'];
  let anyActive = document.getElementById('searchInput').value !== '' || recentDays !== null || filterMonth !== null;
  filterIds.forEach(id => {
    const el = document.getElementById(id);
    const active = el.value !== '';
    el.classList.toggle('filter-select--active', active);
    if (active) anyActive = true;
  });
  document.getElementById('clearFilters').style.display = anyActive ? '' : 'none';
}

