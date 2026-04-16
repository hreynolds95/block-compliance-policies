/* Block Compliance Metrics Dashboard */

async function init() {
  const res = await fetch('./docs-data.json').catch(() => null);
  if (!res || !res.ok) {
    document.querySelector('.page').insertAdjacentHTML('beforeend',
      '<p class="empty-state" style="text-align:center">Failed to load data.</p>');
    return;
  }

  const data = await res.json();
  const docs = data.documents || [];

  const badge = document.getElementById('dataSourceBadge');
  if (badge && data.generated) {
    const refreshed = new Date(data.generated).toLocaleString('en-US', {
      month: 'short', day: 'numeric', year: 'numeric',
      hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
      timeZone: 'America/New_York',
    });
    badge.innerHTML = `Data Source: ${data.source || 'LogicGate → Snowflake'}<br>Last refreshed: ${refreshed}`;
  }

  renderKPIs(docs);
  renderRecentKPI(docs);
  renderLifecycleBreakdown(docs);
  renderDomainBreakdown(docs);
  renderTierBreakdown(docs);
  renderStatusBreakdown(docs);
}

function renderKPIs(docs) {
  document.getElementById('kpiActive').textContent =
    docs.filter(d => d.status === 'published').length;
  document.getElementById('kpiIntake').textContent =
    docs.filter(d => d.status === 'draft' || d.status === 'in-review').length;
  document.getElementById('kpiOverdue').textContent =
    docs.filter(d => ['overdue','pending-review','overdue-past-extension'].includes(d.review_status)).length;
  document.getElementById('kpiDueSoon').textContent =
    docs.filter(d => d.review_status === 'due-soon' || d.review_status === 'extension-coming-due').length;
  document.getElementById('kpiExtensions').textContent =
    docs.filter(d => d.extension_status === 'approved' || d.extension_status === 'in-progress').length;
}

function renderRecentKPI(docs) {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 30);
  const count = docs.filter(d => {
    if (d.status !== 'published') return false;
    const eff = d.effective_date ? new Date(d.effective_date) : null;
    return eff && eff >= cutoff;
  }).length;
  document.getElementById('kpiRecent').textContent = count;
}

function renderLifecycleBreakdown(docs) {
  const published = docs.filter(d => d.status === 'published');
  const domains = [...new Set(published.map(d => d.domain).filter(Boolean))].sort();

  let totCurr = 0, totQc = 0, totApp = 0;

  const rows = domains.map(domain => {
    const group = published.filter(d => d.domain === domain);
    const curr = group.filter(d => d.lifecycle_status === 'current').length;
    const qc   = group.filter(d => d.lifecycle_status === 'under-qc').length;
    const app  = group.filter(d => d.lifecycle_status === 'in-approvals').length;
    const total = group.length;
    totCurr += curr; totQc += qc; totApp += app;
    return `<tr>
      <td class="cell-label">${esc(domainLabel(domain))}</td>
      <td class="cell-success">${curr}</td>
      <td class="${qc > 0 ? 'cell-warning' : 'cell-muted'}">${qc > 0 ? qc : '—'}</td>
      <td class="${app > 0 ? 'cell-warning' : 'cell-muted'}">${app > 0 ? app : '—'}</td>
      <td>${total}</td>
    </tr>`;
  }).join('');

  const totTotal = totCurr + totQc + totApp;
  const totalsRow = `<tr class="dash-totals-row">
    <td class="cell-label">Total</td>
    <td class="cell-success">${totCurr}</td>
    <td class="${totQc > 0 ? 'cell-warning' : 'cell-muted'}">${totQc > 0 ? totQc : '—'}</td>
    <td class="${totApp > 0 ? 'cell-warning' : 'cell-muted'}">${totApp > 0 ? totApp : '—'}</td>
    <td>${totTotal}</td>
  </tr>`;

  document.getElementById('lifecycleTbody').innerHTML = rows + totalsRow;
}

function domainLabel(d) {
  return (d || '').split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

function renderDomainBreakdown(docs) {
  const published = docs.filter(d => d.status === 'published');
  const domains = [...new Set(published.map(d => d.domain).filter(Boolean))].sort();

  let totTotal = 0, totOv = 0, totCd = 0, totOk = 0;

  const rows = domains.map(domain => {
    const group  = published.filter(d => d.domain === domain);
    const total  = group.length;
    const ov     = group.filter(d => ['overdue','pending-review','overdue-past-extension'].includes(d.review_status)).length;
    const cd     = group.filter(d => ['due-soon','extension-coming-due'].includes(d.review_status)).length;
    const ok     = total - ov - cd;
    totTotal += total; totOv += ov; totCd += cd; totOk += ok;
    return `<tr>
      <td class="cell-label">${esc(domainLabel(domain))}</td>
      <td class="${ov > 0 ? 'cell-danger' : 'cell-muted'}">${ov > 0 ? ov : '—'}</td>
      <td class="${cd > 0 ? 'cell-warning' : 'cell-muted'}">${cd > 0 ? cd : '—'}</td>
      <td class="cell-success">${ok}</td>
      <td>${total}</td>
    </tr>`;
  }).join('');

  const totalsRow = `<tr class="dash-totals-row">
    <td class="cell-label">Total</td>
    <td class="${totOv > 0 ? 'cell-danger' : 'cell-muted'}">${totOv > 0 ? totOv : '—'}</td>
    <td class="${totCd > 0 ? 'cell-warning' : 'cell-muted'}">${totCd > 0 ? totCd : '—'}</td>
    <td class="cell-success">${totOk}</td>
    <td>${totTotal}</td>
  </tr>`;

  document.getElementById('domainTbody').innerHTML = rows + totalsRow;
}

function renderTierBreakdown(docs) {
  const published = docs.filter(d => d.status === 'published');
  const labels = { 1: 'Board-approved', 2: 'Committee-approved', 3: 'Owner-approved' };

  document.getElementById('tierCards').innerHTML = [1,2,3].map(tier => {
    const group  = published.filter(d => d.tier == tier);
    const total  = group.length;
    const ov     = group.filter(d => ['overdue','pending-review','overdue-past-extension'].includes(d.review_status)).length;
    const alert  = ov > 0 ? ` · <span class="tier-card-alert">${ov} overdue</span>` : '';
    return `<div class="tier-card">
      <div class="tier-card-label">Tier ${tier}</div>
      <div class="tier-card-value">${total}</div>
      <div class="tier-card-sub">${esc(labels[tier])}${alert}</div>
    </div>`;
  }).join('');
}

function renderStatusBreakdown(docs) {
  const published = docs.filter(d => d.status === 'published');
  const statuses = [
    { keys: ['overdue'],               label: 'Overdue',              cls: 'cell-danger'  },
    { keys: ['pending-review'],        label: 'Pending Review',       cls: 'cell-danger'  },
    { keys: ['overdue-past-extension'],label: 'Overdue (Past Ext.)',   cls: 'cell-danger'  },
    { keys: ['due-soon'],              label: 'Due Soon (90d)',        cls: 'cell-warning' },
    { keys: ['extension-coming-due'],  label: 'Ext. Coming Due',      cls: 'cell-warning' },
    { keys: ['ok'],                    label: 'On Track',             cls: 'cell-success' },
    { keys: ['unknown'],               label: 'Unknown',              cls: 'cell-muted'   },
  ];

  let total = 0;
  const rows = statuses.map(({ keys, label, cls }) => {
    const count = published.filter(d => keys.includes(d.review_status)).length;
    if (!count) return '';
    total += count;
    return `<tr>
      <td class="cell-label">${esc(label)}</td>
      <td class="${cls}">${count}</td>
    </tr>`;
  }).join('');

  const totalsRow = `<tr class="dash-totals-row">
    <td class="cell-label">Total</td>
    <td>${total}</td>
  </tr>`;

  document.getElementById('statusRows').innerHTML = rows + totalsRow;
}

function esc(s) {
  return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

document.addEventListener('DOMContentLoaded', init);
