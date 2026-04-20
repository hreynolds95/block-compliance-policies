/* Block Compliance Metrics Dashboard */

let _docs = [];

async function init() {
  const res = await fetch('./docs-data.json').catch(() => null);
  if (!res || !res.ok) {
    document.querySelector('.page').insertAdjacentHTML('beforeend',
      '<p class="empty-state" style="text-align:center">Failed to load data.</p>');
    return;
  }

  const data = await res.json();
  const docs = data.documents || [];
  _docs = docs;

  const badge = document.getElementById('dataSourceBadge');
  if (badge && data.generated) {
    const refreshed = new Date(data.generated).toLocaleString('en-US', {
      month: 'short', day: 'numeric', year: 'numeric',
      hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
      timeZone: 'America/New_York',
    });
    badge.innerHTML = `Data Source: ${data.source || 'LogicGate → Snowflake'}<br>Last refreshed: ${refreshed}<br><a href="./section-logic.html" class="section-logic-btn">Section Logic &amp; Data Dictionary →</a>`;
  }

  renderKPIs(docs);
  renderRecentKPI(docs);
  renderReviewSchedule(docs);
  renderLifecycleBreakdown(docs);
  renderCoverageBreakdown(docs, 'domain');
  renderTierBreakdown(docs);
  renderStatusBreakdown(docs);
  renderOwnershipBreakdown(docs, 'at-risk');

  if (window.quincyInit) window.quincyInit(docs, { page: 'dashboard' });

  const ownershipSel = document.getElementById('ownershipFilter');
  if (ownershipSel) {
    ownershipSel.addEventListener('change', () => {
      const filter = ownershipSel.value;
      renderOwnershipBreakdown(_docs, filter);
      ownershipSel.classList.toggle('filter-select--active', filter !== 'at-risk');
    });
  }

  const coverageSel = document.getElementById('coverageGroupBy');
  if (coverageSel) {
    coverageSel.addEventListener('change', () => {
      const groupBy = coverageSel.value;
      renderCoverageBreakdown(_docs, groupBy);
      coverageSel.classList.toggle('filter-select--active', groupBy !== 'domain');
    });
  }
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
  document.getElementById('kpiRetired').textContent =
    docs.filter(d => d.status === 'retired').length;
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

function renderReviewSchedule(docs) {
  const MONTH_ABBR = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const CHART_H = 140; // px — max bar height

  const today = new Date();
  const startYM = `${today.getFullYear()}-${String(today.getMonth()+1).padStart(2,'0')}`;

  // Count published docs by next_review_date year-month (current month forward)
  const counts = {};
  docs.filter(d => d.status === 'published' && d.next_review_date).forEach(d => {
    const ym = d.next_review_date.slice(0, 7);
    if (ym >= startYM) counts[ym] = (counts[ym] || 0) + 1;
  });

  const sortedYMs = Object.keys(counts).sort();
  if (!sortedYMs.length) return;

  // Build continuous month range from today to last month with data
  const months = [];
  const cursor = new Date(today.getFullYear(), today.getMonth(), 1);
  const endDate = new Date(sortedYMs[sortedYMs.length - 1] + '-01');
  while (cursor <= endDate) {
    months.push(`${cursor.getFullYear()}-${String(cursor.getMonth()+1).padStart(2,'0')}`);
    cursor.setMonth(cursor.getMonth() + 1);
  }

  const maxCount = Math.max(...months.map(ym => counts[ym] || 0));

  const bars = months.map(ym => {
    const count = counts[ym] || 0;
    const barH  = count ? Math.max(4, Math.round((count / maxCount) * CHART_H)) : 0;
    const [y, m] = ym.split('-');
    const url   = `./index.html?month=${ym}`;
    return `<div class="bar-col" onclick="location.href='${esc(url)}'" title="${count} doc${count !== 1 ? 's' : ''} due ${MONTH_ABBR[+m-1]} ${y}">
      <span class="bar-count${count === 0 ? ' bar-count--empty' : ''}">${count || '0'}</span>
      <div class="bar-fill${count === 0 ? ' bar-fill--zero' : ''}" style="height:${barH}px"></div>
    </div>`;
  }).join('');

  const labels = months.map(ym => {
    const m = parseInt(ym.split('-')[1], 10);
    return `<span>${MONTH_ABBR[m-1]}</span>`;
  }).join('');

  document.getElementById('reviewScheduleBars').innerHTML   = bars;
  document.getElementById('reviewScheduleLabels').innerHTML = labels;
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

function renderCoverageBreakdown(docs, groupBy) {
  const published = docs.filter(d => d.status === 'published');
  const keyFn   = d => groupBy === 'business' ? d.business : d.domain;
  const labelFn = groupBy === 'business' ? s => s : domainLabel;
  const groups  = [...new Set(published.map(keyFn).filter(Boolean))].sort();

  const colHeader = document.getElementById('coverageColHeader');
  if (colHeader) colHeader.textContent = groupBy === 'business' ? 'Business' : 'Domain';

  let totTotal = 0, totOv = 0, totCd = 0, totOk = 0;

  const rows = groups.map(group => {
    const items = published.filter(d => keyFn(d) === group);
    const total = items.length;
    const ov    = items.filter(d => ['overdue','pending-review','overdue-past-extension'].includes(d.review_status)).length;
    const cd    = items.filter(d => ['due-soon','extension-coming-due'].includes(d.review_status)).length;
    const ok    = total - ov - cd;
    totTotal += total; totOv += ov; totCd += cd; totOk += ok;
    return `<tr>
      <td class="cell-label">${esc(labelFn(group))}</td>
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
    return `<a href="./index.html?tier=${tier}" class="tier-card tier-card--link">
      <div class="tier-card-label">Tier ${tier}</div>
      <div class="tier-card-value">${total}</div>
      <div class="tier-card-sub">${esc(labels[tier])}${alert}</div>
    </a>`;
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

function renderOwnershipBreakdown(docs, filter) {
  const published = docs.filter(d => d.status === 'published');

  // Build owner map
  const ownerMap = {};
  for (const d of published) {
    const owner = d.owner || 'Unassigned';
    if (!ownerMap[owner]) ownerMap[owner] = { total: 0, ov: 0, cd: 0, ok: 0 };
    ownerMap[owner].total++;
    const rs = d.review_status || '';
    if (['overdue','pending-review','overdue-past-extension'].includes(rs)) ownerMap[owner].ov++;
    else if (['due-soon','extension-coming-due'].includes(rs))              ownerMap[owner].cd++;
    else                                                                    ownerMap[owner].ok++;
  }

  // Filter: at-risk = any overdue/coming-due, plus Unassigned always
  let owners = Object.keys(ownerMap);
  if (filter === 'at-risk') {
    owners = owners.filter(o => o === 'Unassigned' || ownerMap[o].ov > 0 || ownerMap[o].cd > 0);
  }

  // Sort: overdue desc → coming-due desc → total desc
  owners.sort((a, b) => {
    const A = ownerMap[a], B = ownerMap[b];
    return (B.ov - A.ov) || (B.cd - A.cd) || (B.total - A.total);
  });

  let totTotal = 0, totOv = 0, totCd = 0, totOk = 0;

  const rows = owners.map(owner => {
    const { total, ov, cd, ok } = ownerMap[owner];
    totTotal += total; totOv += ov; totCd += cd; totOk += ok;
    const isUnassigned = owner === 'Unassigned';
    const nameCls = isUnassigned ? 'cell-warning' : 'cell-label';
    return `<tr>
      <td class="${nameCls}">${esc(owner)}</td>
      <td>${total}</td>
      <td class="${ov > 0 ? 'cell-danger' : 'cell-muted'}">${ov > 0 ? ov : '—'}</td>
      <td class="${cd > 0 ? 'cell-warning' : 'cell-muted'}">${cd > 0 ? cd : '—'}</td>
      <td class="cell-success">${ok}</td>
    </tr>`;
  }).join('');

  const totalsRow = `<tr class="dash-totals-row">
    <td class="cell-label">Total</td>
    <td>${totTotal}</td>
    <td class="${totOv > 0 ? 'cell-danger' : 'cell-muted'}">${totOv > 0 ? totOv : '—'}</td>
    <td class="${totCd > 0 ? 'cell-warning' : 'cell-muted'}">${totCd > 0 ? totCd : '—'}</td>
    <td class="cell-success">${totOk}</td>
  </tr>`;

  document.getElementById('ownershipTbody').innerHTML = rows + totalsRow;
}

function esc(s) {
  return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

document.addEventListener('DOMContentLoaded', init);
