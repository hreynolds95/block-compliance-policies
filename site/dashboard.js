/* Block Compliance Metrics Dashboard */

let _docs = [];
let _ownershipExpanded = false;

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
  renderOwnershipBreakdown(docs, '');

  if (window.quincyInit) window.quincyInit(docs, { page: 'dashboard' });

  document.getElementById('exportRegisterBtn').addEventListener('click', exportPolicyRegisterCSV);
  document.getElementById('exportCoverageBtn').addEventListener('click', exportCoverageCSV);
  document.getElementById('exportOwnershipBtn').addEventListener('click', exportOwnershipCSV);

  const ownershipDocTypeSel = document.getElementById('ownershipDocType');
  if (ownershipDocTypeSel) {
    ownershipDocTypeSel.addEventListener('change', () => {
      _ownershipExpanded = false;
      renderOwnershipBreakdown(_docs, ownershipDocTypeSel.value);
      ownershipDocTypeSel.classList.toggle('filter-select--active', ownershipDocTypeSel.value !== '');
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
  const OVERDUE_STATUSES = new Set(['overdue','pending-review','overdue-past-extension']);

  const today = new Date();
  const currYM = `${today.getFullYear()}-${String(today.getMonth()+1).padStart(2,'0')}`;

  // Past months: count only published docs that are still overdue (not completed)
  const pastCounts = {};
  docs.filter(d => d.status === 'published' && d.next_review_date && OVERDUE_STATUSES.has(d.review_status)).forEach(d => {
    const ym = d.next_review_date.slice(0, 7);
    if (ym < currYM) pastCounts[ym] = (pastCounts[ym] || 0) + 1;
  });

  // Current month + future: all published docs
  const futureCounts = {};
  docs.filter(d => d.status === 'published' && d.next_review_date).forEach(d => {
    const ym = d.next_review_date.slice(0, 7);
    if (ym >= currYM) futureCounts[ym] = (futureCounts[ym] || 0) + 1;
  });

  const futureYMs = Object.keys(futureCounts).sort();
  if (!futureYMs.length && !Object.keys(pastCounts).length) return;

  // Build continuous range for current month → last future month with data
  const futureMonths = [];
  if (futureYMs.length) {
    const cursor = new Date(today.getFullYear(), today.getMonth(), 1);
    const endDate = new Date(futureYMs[futureYMs.length - 1] + '-01');
    while (cursor <= endDate) {
      futureMonths.push(`${cursor.getFullYear()}-${String(cursor.getMonth()+1).padStart(2,'0')}`);
      cursor.setMonth(cursor.getMonth() + 1);
    }
  }

  // All months: past (overdue only, sorted) then continuous future range
  const pastMonths = Object.keys(pastCounts).sort();
  const months = [...pastMonths, ...futureMonths];
  if (!months.length) return;

  const allCounts = { ...pastCounts, ...futureCounts };
  const maxCount = Math.max(...months.map(ym => allCounts[ym] || 0));

  const bars = months.map(ym => {
    const count = allCounts[ym] || 0;
    const barH  = count ? Math.max(4, Math.round((count / maxCount) * CHART_H)) : 0;
    const [y, m] = ym.split('-');
    const isPast = ym < currYM;
    const overdueClass = isPast ? ' bar-fill--overdue' : '';
    const url   = `./index.html?month=${ym}`;
    return `<div class="bar-col" onclick="location.href='${esc(url)}'" title="${count} doc${count !== 1 ? 's' : ''} due ${MONTH_ABBR[+m-1]} ${y}${isPast ? ' — overdue' : ''}">
      <span class="bar-count${count === 0 ? ' bar-count--empty' : ''}">${count || '0'}</span>
      <div class="bar-fill${count === 0 ? ' bar-fill--zero' : ''}${overdueClass}" style="height:${barH}px"></div>
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
    const base    = `./index.html?status=published&domain=${encodeURIComponent(domain)}`;
    const currHTML = curr > 0 ? `<a href="${base}&lifecycle=current" class="dash-owner-link">${curr}</a>` : '—';
    const qcHTML   = qc > 0   ? `<a href="${base}&lifecycle=under-qc" class="dash-owner-link">${qc}</a>` : '—';
    const appHTML  = app > 0  ? `<a href="${base}&lifecycle=in-approvals" class="dash-owner-link">${app}</a>` : '—';
    const totHTML  = `<a href="${base}" class="dash-owner-link">${total}</a>`;
    return `<tr>
      <td class="cell-label"><a href="${base}" class="dash-owner-link">${esc(domainLabel(domain))}</a></td>
      <td class="cell-success">${currHTML}</td>
      <td class="${qc > 0 ? 'cell-warning' : 'cell-muted'}">${qcHTML}</td>
      <td class="${app > 0 ? 'cell-warning' : 'cell-muted'}">${appHTML}</td>
      <td>${totHTML}</td>
    </tr>`;
  }).join('');

  const totTotal = totCurr + totQc + totApp;
  const base0 = `./index.html?status=published`;
  const totalsRow = `<tr class="dash-totals-row">
    <td class="cell-label">Total</td>
    <td class="cell-success"><a href="${base0}&lifecycle=current" class="dash-owner-link">${totCurr}</a></td>
    <td class="${totQc > 0 ? 'cell-warning' : 'cell-muted'}">${totQc > 0 ? `<a href="${base0}&lifecycle=under-qc" class="dash-owner-link">${totQc}</a>` : '—'}</td>
    <td class="${totApp > 0 ? 'cell-warning' : 'cell-muted'}">${totApp > 0 ? `<a href="${base0}&lifecycle=in-approvals" class="dash-owner-link">${totApp}</a>` : '—'}</td>
    <td><a href="${base0}" class="dash-owner-link">${totTotal}</a></td>
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
    const dimParam = groupBy === 'business' ? 'business' : 'domain';
    const base     = `./index.html?status=published&${dimParam}=${encodeURIComponent(group)}`;
    const ovHTML   = ov > 0 ? `<a href="${base}&review=overdue" class="dash-owner-link">${ov}</a>` : '—';
    const cdHTML   = cd > 0 ? `<a href="${base}&review=coming-due" class="dash-owner-link">${cd}</a>` : '—';
    const okHTML   = ok > 0 ? `<a href="${base}&review=ok" class="dash-owner-link">${ok}</a>` : '—';
    const totHTML  = `<a href="${base}" class="dash-owner-link">${total}</a>`;
    return `<tr>
      <td class="cell-label"><a href="${base}" class="dash-owner-link">${esc(labelFn(group))}</a></td>
      <td class="${ov > 0 ? 'cell-danger' : 'cell-muted'}">${ovHTML}</td>
      <td class="${cd > 0 ? 'cell-warning' : 'cell-muted'}">${cdHTML}</td>
      <td class="cell-success">${okHTML}</td>
      <td>${totHTML}</td>
    </tr>`;
  }).join('');

  const base0 = `./index.html?status=published`;
  const totalsRow = `<tr class="dash-totals-row">
    <td class="cell-label">Total</td>
    <td class="${totOv > 0 ? 'cell-danger' : 'cell-muted'}">${totOv > 0 ? `<a href="${base0}&review=overdue" class="dash-owner-link">${totOv}</a>` : '—'}</td>
    <td class="${totCd > 0 ? 'cell-warning' : 'cell-muted'}">${totCd > 0 ? `<a href="${base0}&review=coming-due" class="dash-owner-link">${totCd}</a>` : '—'}</td>
    <td class="cell-success"><a href="${base0}&review=ok" class="dash-owner-link">${totOk}</a></td>
    <td><a href="${base0}" class="dash-owner-link">${totTotal}</a></td>
  </tr>`;

  document.getElementById('domainTbody').innerHTML = rows + totalsRow;
}

function renderTierBreakdown(docs) {
  const published = docs.filter(d => d.status === 'published');
  const labels = { 1: 'Board-approved', 2: 'Committee-approved', 3: 'Owner-approved' };

  document.getElementById('tierCards').innerHTML = [1,2,3].map(tier => {
    const group = published.filter(d => d.tier == tier);
    const total = group.length;
    const ov    = group.filter(d => ['overdue','pending-review','overdue-past-extension'].includes(d.review_status)).length;
    const cd    = group.filter(d => ['due-soon','extension-coming-due'].includes(d.review_status)).length;
    const base  = `./index.html?status=published&tier=${tier}`;
    const ovHTML = ov > 0 ? `<a href="${base}&review=overdue" class="tier-card-alert-link tier-card-alert-link--danger">${ov} overdue</a>` : '';
    const cdHTML = cd > 0 ? `<a href="${base}&review=coming-due" class="tier-card-alert-link tier-card-alert-link--warn">${cd} coming due</a>` : '';
    const alerts = [ovHTML, cdHTML].filter(Boolean).join(' · ');
    const alertHTML = alerts ? ` · ${alerts}` : '';
    return `<div class="tier-card">
      <a href="${base}" class="tier-card-link-block">
        <div class="tier-card-label">Tier ${tier}</div>
        <div class="tier-card-value">${total}</div>
      </a>
      <div class="tier-card-sub">${esc(labels[tier])}${alertHTML}</div>
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
    const href = `./index.html?status=published&review=${encodeURIComponent(keys[0])}`;
    return `<tr>
      <td class="cell-label"><a href="${href}" class="dash-owner-link">${esc(label)}</a></td>
      <td class="${cls}"><a href="${href}" class="dash-owner-link">${count}</a></td>
    </tr>`;
  }).join('');

  const totalsRow = `<tr class="dash-totals-row">
    <td class="cell-label">Total</td>
    <td><a href="./index.html?status=published" class="dash-owner-link">${total}</a></td>
  </tr>`;

  document.getElementById('statusRows').innerHTML = rows + totalsRow;
}

function renderOwnershipBreakdown(docs, docType) {
  const published = docs.filter(d => d.status === 'published' && (!docType || d.doc_type === docType));

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

  // Sort: overdue desc → coming-due desc → total desc
  const allOwners = Object.keys(ownerMap).sort((a, b) => {
    const A = ownerMap[a], B = ownerMap[b];
    return (B.ov - A.ov) || (B.cd - A.cd) || (B.total - A.total);
  });

  const atRisk  = allOwners.filter(o => ownerMap[o].ov > 0 || ownerMap[o].cd > 0);
  const onTrack = allOwners.filter(o => ownerMap[o].ov === 0 && ownerMap[o].cd === 0);
  const visible = _ownershipExpanded ? allOwners : atRisk;

  function ownerRow(owner) {
    const { total, ov, cd, ok } = ownerMap[owner];
    const isUnassigned = owner === 'Unassigned';
    const nameCls  = isUnassigned ? 'cell-warning' : 'cell-label';
    const base     = `./index.html?status=published&owner=${encodeURIComponent(owner)}`;
    const nameHTML = isUnassigned
      ? esc(owner)
      : `<a href="${base}" class="dash-owner-link">${esc(owner)}</a>`;
    const totalHTML = `<a href="${base}" class="dash-owner-link">${total}</a>`;
    const ovHTML    = ov > 0 ? `<a href="${base}&review=overdue" class="dash-owner-link">${ov}</a>` : '—';
    const cdHTML    = cd > 0 ? `<a href="${base}&review=coming-due" class="dash-owner-link">${cd}</a>` : '—';
    const okHTML    = ok > 0 ? `<a href="${base}&review=ok" class="dash-owner-link">${ok}</a>` : '—';
    return `<tr>
      <td class="${nameCls}">${nameHTML}</td>
      <td>${totalHTML}</td>
      <td class="${ov > 0 ? 'cell-danger' : 'cell-muted'}">${ovHTML}</td>
      <td class="${cd > 0 ? 'cell-warning' : 'cell-muted'}">${cdHTML}</td>
      <td class="cell-success">${okHTML}</td>
    </tr>`;
  }

  const rows = visible.map(ownerRow).join('');

  // Expand / collapse row
  let expandRow = '';
  if (onTrack.length > 0) {
    const label = _ownershipExpanded
      ? '▲ Show fewer'
      : `▼ Show ${onTrack.length} more owner${onTrack.length !== 1 ? 's' : ''} (on track)`;
    expandRow = `<tr class="ownership-expand-row">
      <td colspan="5"><button class="ownership-expand-btn" id="ownershipExpandBtn">${label}</button></td>
    </tr>`;
  }

  // Totals always reflect the full filtered set
  let totTotal = 0, totOv = 0, totCd = 0, totOk = 0;
  for (const o of allOwners) {
    totTotal += ownerMap[o].total; totOv += ownerMap[o].ov;
    totCd += ownerMap[o].cd;      totOk += ownerMap[o].ok;
  }
  const totalsRow = `<tr class="dash-totals-row">
    <td class="cell-label">Total</td>
    <td>${totTotal}</td>
    <td class="${totOv > 0 ? 'cell-danger' : 'cell-muted'}">${totOv > 0 ? totOv : '—'}</td>
    <td class="${totCd > 0 ? 'cell-warning' : 'cell-muted'}">${totCd > 0 ? totCd : '—'}</td>
    <td class="cell-success">${totOk}</td>
  </tr>`;

  document.getElementById('ownershipTbody').innerHTML = rows + expandRow + totalsRow;

  const expandBtn = document.getElementById('ownershipExpandBtn');
  if (expandBtn) {
    expandBtn.addEventListener('click', () => {
      _ownershipExpanded = !_ownershipExpanded;
      renderOwnershipBreakdown(_docs, document.getElementById('ownershipDocType').value);
    });
  }
}

// ── CSV export ────────────────────────────────────────────────────────────────

function downloadCSV(filename, rows) {
  const csv = rows.map(row =>
    row.map(cell => {
      const s = String(cell ?? '');
      return /[,"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    }).join(',')
  ).join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}

function exportCoverageCSV() {
  const groupBy  = document.getElementById('coverageGroupBy').value;
  const published = _docs.filter(d => d.status === 'published');
  const keyFn    = d => groupBy === 'business' ? d.business : d.domain;
  const labelFn  = groupBy === 'business' ? s => s : domainLabel;
  const groups   = [...new Set(published.map(keyFn).filter(Boolean))].sort();
  const colLabel = groupBy === 'business' ? 'Business' : 'Domain';
  const rows = [[colLabel, 'Overdue', 'Coming Due', 'On Track', 'Total']];
  for (const group of groups) {
    const items = published.filter(d => keyFn(d) === group);
    const total = items.length;
    const ov    = items.filter(d => ['overdue','pending-review','overdue-past-extension'].includes(d.review_status)).length;
    const cd    = items.filter(d => ['due-soon','extension-coming-due'].includes(d.review_status)).length;
    rows.push([labelFn(group), ov, cd, total - ov - cd, total]);
  }
  downloadCSV(`block-compliance-coverage-by-${groupBy}-${today()}.csv`, rows);
}

function exportOwnershipCSV() {
  const docType   = document.getElementById('ownershipDocType').value;
  const published = _docs.filter(d => d.status === 'published' && (!docType || d.doc_type === docType));
  const ownerMap  = {};
  for (const d of published) {
    const owner = d.owner || 'Unassigned';
    if (!ownerMap[owner]) ownerMap[owner] = { total: 0, ov: 0, cd: 0, ok: 0 };
    ownerMap[owner].total++;
    const rs = d.review_status || '';
    if (['overdue','pending-review','overdue-past-extension'].includes(rs)) ownerMap[owner].ov++;
    else if (['due-soon','extension-coming-due'].includes(rs))             ownerMap[owner].cd++;
    else                                                                   ownerMap[owner].ok++;
  }
  const owners = Object.keys(ownerMap).sort((a, b) => (ownerMap[b].ov - ownerMap[a].ov) || (ownerMap[b].cd - ownerMap[a].cd) || (ownerMap[b].total - ownerMap[a].total));
  const rows = [['Owner', 'Documents', 'Overdue', 'Coming Due', 'On Track']];
  for (const owner of owners) {
    const { total, ov, cd, ok } = ownerMap[owner];
    rows.push([owner, total, ov, cd, ok]);
  }
  const suffix = docType ? `-${docType.toLowerCase()}` : '';
  downloadCSV(`block-compliance-ownership${suffix}-${today()}.csv`, rows);
}

function exportPolicyRegisterCSV() {
  const published = _docs.filter(d => d.status === 'published');
  const rows = [['ID','Title','Domain','Tier','Owner','Business','Legal Entity','Effective Date','Next Review','Review Status','Extension Status','Retention (yrs)']];
  for (const d of published.sort((a, b) => a.doc_id.localeCompare(b.doc_id))) {
    rows.push([
      d.doc_id, d.title, domainLabel(d.domain), d.tier,
      d.owner || 'Unassigned', d.business || '', d.legal_entity || '',
      d.effective_date || '', d.next_review_date || '',
      d.review_status || '', d.extension_status || '',
      d.retention_years || '',
    ]);
  }
  downloadCSV(`block-compliance-policy-register-${today()}.csv`, rows);
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function esc(s) {
  return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

document.addEventListener('DOMContentLoaded', init);
