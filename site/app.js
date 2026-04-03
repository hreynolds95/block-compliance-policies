/* Block Compliance Policy Library — GitHub Pages UI */

let allDocs = [];
let sortCol = 'doc_id';
let sortAsc = true;

// ── Bootstrap ───────────────────────────────────────────────────────────────

async function init() {
  const [docsRes, auditRes] = await Promise.allSettled([
    fetch('./docs-data.json'),
    fetch('./audit-log.jsonl'),
  ]);

  if (docsRes.status === 'fulfilled' && docsRes.value.ok) {
    const data = await docsRes.value.json();
    allDocs = data.documents || [];
    document.getElementById('heroMeta').innerHTML =
      `Last generated <span>${data.generated}</span> &middot; ${allDocs.length} document${allDocs.length !== 1 ? 's' : ''}`;
    populateDomainFilter(allDocs);
    renderKPIs(allDocs);
    renderTable(allDocs);
  } else {
    document.getElementById('heroMeta').textContent = 'Could not load document data.';
  }

  if (auditRes.status === 'fulfilled' && auditRes.value.ok) {
    const text = await auditRes.value.text();
    renderAuditLog(text.trim().split('\n').filter(Boolean).map(l => JSON.parse(l)).reverse());
  } else {
    document.getElementById('auditList').innerHTML =
      '<div class="empty-state">Audit log unavailable.</div>';
  }
}

// ── KPIs ────────────────────────────────────────────────────────────────────

function renderKPIs(docs) {
  document.getElementById('kpiTotal').textContent     = docs.length;
  document.getElementById('kpiPublished').textContent = docs.filter(d => d.status === 'published').length;
  document.getElementById('kpiOverdue').textContent   = docs.filter(d => d.review_status === 'overdue').length;
  document.getElementById('kpiDueSoon').textContent   = docs.filter(d => d.review_status === 'due-soon').length;
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

// ── Table rendering ──────────────────────────────────────────────────────────

function filteredDocs() {
  const q      = document.getElementById('searchInput').value.toLowerCase();
  const domain = document.getElementById('filterDomain').value;
  const status = document.getElementById('filterStatus').value;
  const review = document.getElementById('filterReview').value;

  return allDocs
    .filter(d => {
      if (q && !`${d.doc_id} ${d.title} ${d.owner} ${d.domain}`.toLowerCase().includes(q)) return false;
      if (domain && d.domain !== domain) return false;
      if (status && d.status !== status) return false;
      if (review && d.review_status !== review) return false;
      return true;
    })
    .sort((a, b) => {
      const va = (a[sortCol] ?? '').toString().toLowerCase();
      const vb = (b[sortCol] ?? '').toString().toLowerCase();
      return sortAsc ? va.localeCompare(vb) : vb.localeCompare(va);
    });
}

function renderTable(docs) {
  const tbody  = document.getElementById('docTbody');
  const empty  = document.getElementById('emptyState');
  const visible = docs ?? filteredDocs();

  document.getElementById('resultCount').textContent =
    `${visible.length} of ${allDocs.length}`;

  if (!visible.length) {
    tbody.innerHTML = '';
    empty.style.display = '';
    return;
  }
  empty.style.display = 'none';

  tbody.innerHTML = visible.map(d => `
    <tr>
      <td><span class="doc-id">${esc(d.doc_id)}</span></td>
      <td><span class="doc-title">${esc(d.title)}</span></td>
      <td><span class="domain-label">${esc(domainLabel(d.domain))}</span></td>
      <td><span class="badge badge-tier${d.tier}">Tier ${esc(d.tier)}</span></td>
      <td><span class="badge badge-${d.status}">${esc(d.status)}</span></td>
      <td><span class="doc-owner">${esc(d.owner)}</span></td>
      <td><span class="badge badge-${d.approval_type}">${esc(d.approval_type)}</span></td>
      <td>${esc(d.version)}</td>
      <td>${esc(d.next_review_date ?? '—')}</td>
      <td>${reviewPill(d.review_status)}</td>
    </tr>
  `).join('');
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

function domainLabel(d) {
  return (d || '').replace(/-/g, ' ');
}

function reviewPill(status) {
  const map = {
    ok:       ['pill-ok',       'OK'],
    'due-soon':['pill-due-soon','Due soon'],
    overdue:  ['pill-overdue',  'Overdue'],
    unknown:  ['pill-unknown',  'Unknown'],
  };
  const [cls, label] = map[status] ?? map.unknown;
  return `<span class="review-pill ${cls}">${label}</span>`;
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

  ['searchInput', 'filterDomain', 'filterStatus', 'filterReview'].forEach(id => {
    document.getElementById(id).addEventListener('input', () => renderTable(filteredDocs()));
  });

  init();
});
