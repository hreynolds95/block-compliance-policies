// Quincy — Block Compliance Policy Chatbot
// Calls the Anthropic API via the Cloudflare Worker proxy (proxy/worker.js).
// Set PROXY_URL to your deployed worker URL before going live.

(function () {
  'use strict';

  const PROXY_URL = 'https://quincy-proxy.hmreynolds95.workers.dev/v1/messages';
  const MODEL     = 'claude-opus-4-6';

  let chatHistory   = [];
  let systemPrompt  = null;
  let isStreaming   = false;
  let searchIndex   = null;   // Map<doc_id, text> — loaded once on first open
  let indexState    = 'idle'; // 'idle' | 'loading' | 'ready' | 'failed'

  // ── Bootstrap ─────────────────────────────────────────────────────────────────

  function init(docs) {
    systemPrompt = buildSystemPrompt(docs);
    injectHTML();
    wireEvents();
  }

  // ── HTML injection ────────────────────────────────────────────────────────────

  function injectHTML() {
    document.body.insertAdjacentHTML('beforeend', `
      <button class="q-fab" id="qFab" aria-label="Open Quincy compliance assistant">
        <svg class="q-fab-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
        </svg>
        <span class="q-fab-label">Ask Quincy</span>
      </button>

      <div class="q-overlay" id="qOverlay" style="display:none;" aria-hidden="true">
        <div class="q-popup" role="dialog" aria-label="Quincy compliance assistant">
          <div class="q-header">
            <div class="q-header-left">
              <div class="q-avatar">Q</div>
              <div>
                <div class="q-name">Quincy</div>
                <div class="q-tagline">Compliance Policy Assistant</div>
              </div>
            </div>
            <button class="q-close" id="qClose" aria-label="Close Quincy">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round">
                <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
              </svg>
            </button>
          </div>

          <div class="q-messages" id="qMessages">
            <div class="q-msg q-msg--bot">
              <div class="q-bubble">Hi, I'm Quincy. Ask me anything about Block's compliance policies — owners, tiers, review status, domains, or which documents cover a given topic.</div>
            </div>
          </div>

          <div class="q-input-area">
            <textarea class="q-textarea" id="qInput" placeholder="Ask about a policy…" rows="1" autocomplete="off" spellcheck="false"></textarea>
            <button class="q-send" id="qSend" aria-label="Send message">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                <line x1="22" y1="2" x2="11" y2="13"/>
                <polygon points="22 2 15 22 11 13 2 9 22 2"/>
              </svg>
            </button>
          </div>

        </div>
      </div>
    `);
  }

  // ── Events ────────────────────────────────────────────────────────────────────

  function wireEvents() {
    document.getElementById('qFab').addEventListener('click', togglePopup);
    document.getElementById('qClose').addEventListener('click', closePopup);
    document.getElementById('qSend').addEventListener('click', sendMessage);

    const textarea = document.getElementById('qInput');
    textarea.addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
    });
    textarea.addEventListener('input', () => {
      textarea.style.height = 'auto';
      textarea.style.height = Math.min(textarea.scrollHeight, 120) + 'px';
    });

    document.addEventListener('keydown', e => {
      if (e.key === 'Escape' && document.getElementById('qOverlay').style.display !== 'none') {
        closePopup();
      }
    });
  }

  // ── Popup ─────────────────────────────────────────────────────────────────────

  function togglePopup() {
    if (document.getElementById('qOverlay').style.display === 'none') openPopup();
    else closePopup();
  }

  function openPopup() {
    const overlay = document.getElementById('qOverlay');
    overlay.style.display = '';
    overlay.removeAttribute('aria-hidden');
    document.getElementById('qFab').classList.add('q-fab--open');
    ensureSearchIndex();
    setTimeout(() => document.getElementById('qInput').focus(), 100);
  }

  // ── Search index ──────────────────────────────────────────────────────────────

  function ensureSearchIndex() {
    if (indexState !== 'idle') return;
    indexState = 'loading';
    fetch('./search-index.json')
      .then(r => r.ok ? r.json() : Promise.reject('not ok'))
      .then(data => {
        searchIndex = new Map(Object.entries(data.documents || {}));
        // Only keep docs that have actual content
        for (const [k, v] of searchIndex) {
          if (!v) searchIndex.delete(k);
        }
        indexState = 'ready';
        console.log(`Quincy: search index loaded — ${searchIndex.size} docs with content`);
      })
      .catch(() => { indexState = 'failed'; });
  }

  /**
   * Score each doc in the search index against the query.
   * Returns up to topN docs sorted by relevance with a short excerpt.
   */
  function retrieveRelevantDocs(query, topN = 4) {
    if (indexState !== 'ready' || !searchIndex) return [];

    const terms = query.toLowerCase()
      .replace(/[^\w\s]/g, ' ')
      .split(/\s+/)
      .filter(t => t.length > 2);
    if (!terms.length) return [];

    const scored = [];
    for (const [docId, content] of searchIndex) {
      const lower = content.toLowerCase();
      let score = 0;
      for (const term of terms) {
        // Count occurrences (capped at 5 per term to avoid one-word docs dominating)
        let pos = 0, count = 0;
        while ((pos = lower.indexOf(term, pos)) !== -1 && count < 5) { score++; count++; pos++; }
      }
      if (score > 0) {
        // Find the best excerpt: a 600-char window around the first term hit
        const firstHit = lower.indexOf(terms[0]);
        const start    = Math.max(0, firstHit - 100);
        const excerpt  = content.slice(start, start + 600).trim();
        scored.push({ docId, score, excerpt });
      }
    }

    return scored.sort((a, b) => b.score - a.score).slice(0, topN);
  }

  function closePopup() {
    const overlay = document.getElementById('qOverlay');
    overlay.style.display = 'none';
    overlay.setAttribute('aria-hidden', 'true');
    document.getElementById('qFab').classList.remove('q-fab--open');
  }

  // ── Chat ──────────────────────────────────────────────────────────────────────

  async function sendMessage() {
    const input = document.getElementById('qInput');
    const text  = input.value.trim();
    if (!text || isStreaming) return;

    input.value = '';
    input.style.height = 'auto';

    appendMessage('user', text);

    // Augment with retrieved policy content if available
    const hits = retrieveRelevantDocs(text);
    let userContent = text;
    if (hits.length > 0) {
      const context = hits.map(h =>
        `[${h.docId} excerpt]\n${h.excerpt}`
      ).join('\n\n');
      userContent = `${text}\n\n---\nRelevant policy content retrieved from the library:\n${context}`;
    }

    chatHistory.push({ role: 'user', content: userContent });

    const botEl  = appendMessage('bot', '');
    const bubble = botEl.querySelector('.q-bubble');
    bubble.innerHTML = '<span class="q-cursor"></span>';

    isStreaming = true;
    document.getElementById('qSend').disabled = true;

    try {
      const res = await fetch(PROXY_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model:      MODEL,
          max_tokens: 1024,
          system: [{
            type:          'text',
            text:          systemPrompt,
            cache_control: { type: 'ephemeral' },
          }],
          messages: chatHistory,
          stream:   true,
        }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error?.message || `API error ${res.status}`);
      }

      let fullText = '';
      const reader  = res.body.getReader();
      const decoder = new TextDecoder();
      let   buffer  = '';
      const messagesEl = document.getElementById('qMessages');

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop(); // hold incomplete line
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const payload = line.slice(6).trim();
          if (payload === '[DONE]') continue;
          try {
            const evt = JSON.parse(payload);
            if (evt.type === 'content_block_delta' && evt.delta?.type === 'text_delta') {
              fullText += evt.delta.text;
              bubble.innerHTML = md(fullText) + '<span class="q-cursor"></span>';
              messagesEl.scrollTop = messagesEl.scrollHeight;
            }
          } catch (_) {}
        }
      }

      bubble.innerHTML = md(fullText);
      chatHistory.push({ role: 'assistant', content: fullText });
      document.getElementById('qMessages').scrollTop = 999999;

    } catch (err) {
      bubble.innerHTML = `<span class="q-error">Error: ${esc(err.message)}</span>`;
      // Remove the failed user message from history so the next send isn't confused
      chatHistory.pop();
    }

    isStreaming = false;
    document.getElementById('qSend').disabled = false;
    document.getElementById('qInput').focus();
  }

  function appendMessage(role, text) {
    const messagesEl = document.getElementById('qMessages');
    const div = document.createElement('div');
    div.className = `q-msg q-msg--${role}`;
    div.innerHTML = `<div class="q-bubble">${role === 'user' ? esc(text) : md(text)}</div>`;
    messagesEl.appendChild(div);
    messagesEl.scrollTop = 999999;
    return div;
  }

  // ── Minimal Markdown renderer ─────────────────────────────────────────────────
  // Supports: paragraphs, unordered/ordered lists, bold, inline code, doc-ID links.

  function md(raw) {
    const lines = raw.split('\n');
    let html = '';
    let inUl = false;
    let inOl = false;

    function closeList() {
      if (inUl) { html += '</ul>'; inUl = false; }
      if (inOl) { html += '</ol>'; inOl = false; }
    }

    for (const line of lines) {
      const t = line.trim();
      if (!t) { closeList(); html += '<div class="q-spacer"></div>'; continue; }

      if (/^[-*]\s+/.test(t)) {
        if (inOl) { html += '</ol>'; inOl = false; }
        if (!inUl) { html += '<ul>'; inUl = true; }
        html += `<li>${inline(t.replace(/^[-*]\s+/, ''))}</li>`;
        continue;
      }

      if (/^\d+\.\s+/.test(t)) {
        if (inUl) { html += '</ul>'; inUl = false; }
        if (!inOl) { html += '<ol>'; inOl = true; }
        html += `<li>${inline(t.replace(/^\d+\.\s+/, ''))}</li>`;
        continue;
      }

      closeList();

      if (/^#{1,3}\s/.test(t)) {
        html += `<p class="q-md-h">${inline(t.replace(/^#{1,3}\s+/, ''))}</p>`;
      } else {
        html += `<p>${inline(t)}</p>`;
      }
    }

    closeList();
    return html;
  }

  function inline(s) {
    s = esc(s);
    s = s.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/`(.+?)`/g, '<code>$1</code>');
    // Turn doc IDs (CP-001, EE-023, FC-011, GOV-042) into clickable links
    s = s.replace(/\b([A-Z]{2,3}-\d{3})\b/g,
      '<a href="#" class="q-doc-link" data-doc-id="$1" onclick="return quincyGoToDoc(\'$1\')">$1</a>');
    return s;
  }

  // ── Doc citation navigation ───────────────────────────────────────────────────

  window.quincyGoToDoc = function (docId) {
    const searchInput = document.getElementById('searchInput');
    if (searchInput) {
      searchInput.value = docId;
      searchInput.dispatchEvent(new Event('input'));
    }
    closePopup();
    setTimeout(() => {
      const row = document.querySelector(`.doc-row[data-doc-id="${CSS.escape(docId)}"]`);
      if (row) {
        row.scrollIntoView({ behavior: 'smooth', block: 'center' });
        row.classList.add('quincy-row-flash');
        setTimeout(() => row.classList.remove('quincy-row-flash'), 2000);
      }
    }, 220);
    return false;
  };

  // ── System prompt ─────────────────────────────────────────────────────────────

  function buildSystemPrompt(docs) {
    const context = JSON.stringify(docs.map(d => ({
      doc_id:           d.doc_id,
      title:            d.title,
      domain:           d.domain,
      tier:             d.tier,
      status:           d.status,
      owner:            d.owner,
      approval_type:    d.approval_type,
      business:         d.business         || null,
      legal_entity:     d.legal_entity     || null,
      effective_date:   d.effective_date   || null,
      next_review_date: d.next_review_date || null,
      review_status:    d.review_status,
      retention_years:  d.retention_years  || null,
      extension_status: d.extension_status || null,
      extended_due_date:d.extended_due_date|| null,
    })));

    return `You are Quincy, Block Inc.'s compliance policy assistant. Block is the parent company of Square, Cash App, Afterpay, TIDAL, and Spiral.

You have full access to the Block Compliance Policy Library (${docs.length} documents).

POLICY LIBRARY DATA:
${context}

DOMAIN PREFIX CODES:
- consumer-protection → CP-NNN
- ethics-and-employee-conduct → EE-NNN
- financial-crimes → FC-NNN
- governance → GOV-NNN

TIER DEFINITIONS:
- Tier 1: Board-approved (highest governance, enterprise-wide)
- Tier 2: Committee-approved
- Tier 3: Owner-approved (operational level)

RESPONSE GUIDELINES:
- Always cite document IDs (e.g. CP-001, GOV-015) when referencing specific policies
- Be precise about status (published/draft/in-review/retired), tier, owner, and review dates
- review_status "overdue" = past next_review_date; "due-soon" = within 30 days; "ok" = on track
- Intake docs (draft/in-review) may be overdue due to regulatory deadline drivers — this is intentional
- Retired docs exist in the data but are hidden from the library by default
- When the user's question matches policy content, relevant excerpts from the actual PDF text will be appended to their message — use that content to answer specifically and accurately
- If no excerpts are provided for a question, answer from metadata only and say the full policy text was not retrieved for that query
- Do not say you lack access to PDF content — you have extracted text from 156 published policies available via retrieval
- Keep answers professional, accurate, and concise
- When listing multiple documents, use a bulleted list`;
  }

  // ── Utilities ─────────────────────────────────────────────────────────────────

  function esc(s) {
    return String(s ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // ── Expose init for app.js ────────────────────────────────────────────────────

  window.quincyInit = init;
})();
