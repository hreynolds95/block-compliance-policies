// Quincy — Block Compliance Policy Chatbot
// Calls the Anthropic API via the Cloudflare Worker proxy (proxy/worker.js).
// Set PROXY_URL to your deployed worker URL before going live.

(function () {
  'use strict';

  const PROXY_URL = 'https://quincy-proxy.hmreynolds95.workers.dev/v1/messages';
  const MODEL     = 'claude-opus-4-6';

  let chatHistory   = [];       // sent to API (user turns contain RAG-augmented content)
  let userQueries   = [];       // raw user text only — used for context-aware retrieval
  let systemPrompt  = null;
  let isStreaming   = false;
  let searchIndex   = null;   // Map<doc_id, text> — loaded once on first open
  let indexState    = 'idle'; // 'idle' | 'loading' | 'ready' | 'failed'
  let processIndex  = null;   // Map<proc_id, {title, description, text}> — process procedures
  let procState     = 'idle'; // 'idle' | 'loading' | 'ready' | 'failed'
  let docMeta       = new Map(); // doc_id → { title, published_pdf } for download formatting

  // ── Bootstrap ─────────────────────────────────────────────────────────────────

  function init(docs) {
    systemPrompt = buildSystemPrompt(docs);
    docs.forEach(d => docMeta.set(d.doc_id, { title: d.title, published_pdf: d.published_pdf || null }));
    injectHTML();
    wireEvents();
  }

  // ── HTML injection ────────────────────────────────────────────────────────────

  const STARTERS = [
    'What policies are overdue or coming due right now?',
    'How do I submit a policy exception in LogicGate?',
    'What AML policies apply to Cash App?',
    'Who owns Block\'s Tier 1 governance policies?',
  ];

  function welcomeHTML() {
    const chips = STARTERS.map(q =>
      `<button class="q-starter" type="button">${esc(q)}</button>`
    ).join('');
    return `
      <div class="q-msg q-msg--bot">
        <div class="q-bubble">Hi, I'm Quincy. Ask me anything about Block's compliance policies — owners, tiers, review status, domains, or which documents cover a given topic.</div>
      </div>
      <div class="q-starters" id="qStarters">${chips}</div>`;
  }

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
            <button class="q-new-chat" id="qNewChat" aria-label="Start new conversation" style="display:none;">New chat</button>
            <button class="q-close" id="qClose" aria-label="Close Quincy">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round">
                <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
              </svg>
            </button>
          </div>

          <div class="q-messages" id="qMessages">
            ${welcomeHTML()}
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
    document.getElementById('qNewChat').addEventListener('click', resetConversation);
    document.getElementById('qSend').addEventListener('click', sendMessage);

    document.getElementById('qMessages').addEventListener('click', e => {
      const btn = e.target.closest('.q-starter');
      if (!btn) return;
      const input = document.getElementById('qInput');
      input.value = btn.textContent;
      input.style.height = 'auto';
      input.style.height = Math.min(input.scrollHeight, 120) + 'px';
      sendMessage();
    });

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
    ensureProcessIndex();
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
        for (const [k, v] of searchIndex) {
          if (!v) searchIndex.delete(k);
        }
        indexState = 'ready';
        console.log(`Quincy: search index loaded — ${searchIndex.size} docs with content`);
      })
      .catch(() => { indexState = 'failed'; });
  }

  function ensureProcessIndex() {
    if (procState !== 'idle') return;
    procState = 'loading';
    fetch('./process-index.json')
      .then(r => r.ok ? r.json() : Promise.reject('not ok'))
      .then(data => {
        processIndex = new Map(
          Object.entries(data.documents || {}).filter(([, v]) => v.text)
        );
        procState = 'ready';
        console.log(`Quincy: process index loaded — ${processIndex.size} procedures with content`);
      })
      .catch(() => { procState = 'failed'; });
  }

  /**
   * Score each doc in the search index against the query.
   * Returns up to topN docs sorted by relevance with a short excerpt.
   */
  /**
   * Returns { top: [{docId, excerpt}], additional: [docId, ...] }
   * top: up to 8 highest-scoring docs with a 1500-char excerpt each
   * additional: all further matching doc IDs (no excerpt) so Claude knows they exist
   */
  function scoreIndex(indexMap, terms) {
    const scored = [];
    for (const [id, entry] of indexMap) {
      const text  = typeof entry === 'string' ? entry : entry.text || '';
      const lower = text.toLowerCase();
      let score = 0;
      for (const term of terms) {
        let pos = 0, count = 0;
        while ((pos = lower.indexOf(term, pos)) !== -1 && count < 5) { score++; count++; pos++; }
      }
      if (score > 0) scored.push({ id, score, text });
    }
    return scored.sort((a, b) => b.score - a.score);
  }

  function retrieveRelevantDocs(query) {
    const terms = query.toLowerCase()
      .replace(/[^\w\s]/g, ' ')
      .split(/\s+/)
      .filter(t => t.length > 2);
    if (!terms.length) return { top: [], additional: [], procedures: [] };

    // Score policies
    const policyScored = indexState === 'ready' && searchIndex
      ? scoreIndex(searchIndex, terms) : [];
    const top        = policyScored.slice(0, 4).map(d => ({ docId: d.id, excerpt: d.text }));
    const additional = policyScored.slice(4).map(d => d.id);

    // Score process procedures
    const procScored = procState === 'ready' && processIndex
      ? scoreIndex(processIndex, terms) : [];
    const procedures = procScored.slice(0, 2).map(d => {
      const meta = processIndex.get(d.id) || {};
      return { procId: d.id, title: meta.title || d.id, excerpt: d.text };
    });

    return { top, additional, procedures };
  }

  function closePopup() {
    const overlay = document.getElementById('qOverlay');
    overlay.style.display = 'none';
    overlay.setAttribute('aria-hidden', 'true');
    document.getElementById('qFab').classList.remove('q-fab--open');
  }

  function resetConversation() {
    chatHistory = [];
    userQueries = [];
    document.getElementById('qMessages').innerHTML = welcomeHTML();
    document.getElementById('qNewChat').style.display = 'none';
    document.getElementById('qInput').focus();
  }

  // ── Context-aware retrieval query ─────────────────────────────────────────────

  function buildRetrievalQuery(currentQuery) {
    // Blend last 2 raw user queries with the current one so follow-up questions
    // (e.g. "which ones apply to Cash App?") carry forward prior topic context.
    const context = userQueries.slice(-2).join(' ');
    return context ? `${context} ${currentQuery}` : currentQuery;
  }

  // ── Chat ──────────────────────────────────────────────────────────────────────

  async function sendMessage() {
    const input = document.getElementById('qInput');
    const text  = input.value.trim();
    if (!text || isStreaming) return;

    input.value = '';
    input.style.height = 'auto';

    appendMessage('user', text);
    userQueries.push(text);
    document.getElementById('qNewChat').style.display = '';
    const starters = document.getElementById('qStarters');
    if (starters) starters.remove();

    // Augment with retrieved policy content — use blended query for context-aware scoring
    const { top, additional, procedures } = retrieveRelevantDocs(buildRetrievalQuery(text));
    let userContent = text;
    const sections = [];
    if (top.length > 0) {
      const excerpts = top.map(h => `[${h.docId}]\n${h.excerpt}`).join('\n\n');
      const extra    = additional.length
        ? `\nAdditional policies also matched (metadata only): ${additional.join(', ')}`
        : '';
      sections.push(`POLICY LIBRARY — top ${top.length} matches (full indexed text):\n${excerpts}${extra}`);
    }
    if (procedures.length > 0) {
      const procText = procedures.map(p => `[${p.procId}] ${p.title}\n${p.excerpt}`).join('\n\n');
      sections.push(`PROCESS PROCEDURES — top ${procedures.length} matches (full text):\n${procText}`);
    }
    if (sections.length > 0) {
      userContent = `${text}\n\n---\n${sections.join('\n\n---\n')}`;
    }

    chatHistory.push({ role: 'user', content: userContent });

    // Keep retrieved context for the download file
    const retrievedForDownload = top;

    const botEl  = appendMessage('bot', '');
    const bubble = botEl.querySelector('.q-bubble');
    bubble.innerHTML = '<span class="q-cursor"></span>';

    // Add download button immediately — it will capture whatever is generated
    // even if the response is later truncated
    addDownloadButton(botEl, text, () => fullText, retrievedForDownload);

    isStreaming = true;
    document.getElementById('qSend').disabled = true;

    let fullText = '';  // declared here so the download button closure can read it

    try {
      const res = await fetch(PROXY_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model:      MODEL,
          max_tokens: 16384,
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

      const reader  = res.body.getReader();
      const decoder = new TextDecoder();
      let   buffer  = '';
      let   truncated = false;
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
            if (evt.type === 'message_delta' && evt.delta?.stop_reason === 'max_tokens') {
              truncated = true;
            }
          } catch (_) {}
        }
      }

      bubble.innerHTML = md(fullText);
      if (truncated) {
        bubble.innerHTML += `<p class="q-truncated">Response reached the length limit — the download below contains everything generated.</p>`;
      }
      chatHistory.push({ role: 'assistant', content: fullText });
      document.getElementById('qMessages').scrollTop = 999999;

    } catch (err) {
      bubble.innerHTML = `<span class="q-error">Error: ${esc(err.message)}</span>`;
      // Remove the failed turn from history so the next send isn't confused
      chatHistory.pop();
      userQueries.pop();
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

  // ── Download response ─────────────────────────────────────────────────────────

  function addDownloadButton(msgEl, question, responseTextOrFn, retrieved) {
    const btn = document.createElement('button');
    btn.className = 'q-download-btn';
    btn.title = 'Download response as Markdown';
    btn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>`;
    btn.addEventListener('click', () => {
      const text = typeof responseTextOrFn === 'function' ? responseTextOrFn() : responseTextOrFn;
      downloadResponse(question, text, retrieved);
    });
    msgEl.appendChild(btn);
  }

  function downloadResponse(question, responseText, retrieved) {
    const dateStr = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
    const slug    = question.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 50).replace(/-$/, '');

    let out = `# Quincy — Compliance Policy Response\n\n`;
    out += `**Date:** ${dateStr}  \n`;
    out += `**Question:** ${question}\n\n`;
    out += `---\n\n`;
    out += `## Response\n\n`;
    out += responseText;

    if (retrieved && retrieved.length > 0) {
      out += `\n\n---\n\n## Source Policy Content\n\n`;
      out += `*Policy text retrieved from the Block Compliance Policy Library and used to generate the response above.*\n\n`;

      for (const { docId, excerpt } of retrieved) {
        const meta  = docMeta.get(docId) || {};
        const title = meta.title || docId;
        const pdf   = meta.published_pdf || null;

        // Section heading: doc ID + full title
        out += `### ${docId} — ${title}\n\n`;

        // PDF link if available
        if (pdf) out += `**Published PDF:** [View document](${pdf})\n\n`;

        // Bullet each sentence for scannability
        out += `**Referenced content:**\n\n`;
        out += sentenceBullets(excerpt);
        out += `\n\n`;
      }
    }

    out += `---\n\n*Generated by Quincy, Block Compliance Policy Assistant*\n`;

    const blob = new Blob([out], { type: 'text/markdown' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = `quincy-${slug}.md`;
    a.click();
    URL.revokeObjectURL(url);
  }

  /**
   * Split policy text into sentence-level bullet points for human review.
   * The search index collapses all whitespace so we split on sentence boundaries.
   */
  function sentenceBullets(text) {
    // Split at ". " followed by a capital letter, number, or common list starters
    const sentences = text
      .split(/(?<=\.)\s+(?=[A-Z0-9"(])/)
      .map(s => s.trim())
      .filter(s => s.length > 20); // drop fragments shorter than a meaningful clause

    return sentences.map(s => `- ${s}${s.endsWith('.') || s.endsWith(':') ? '' : '.'}`).join('\n');
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

    const today = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });

    return `You are Quincy, Block Inc.'s compliance policy assistant. Block is the parent company of Square, Cash App, Afterpay, TIDAL, and Spiral.

TODAY'S DATE: ${today}

You have full access to the Block Compliance Policy Library (${docs.length} documents) and a set of process procedure documents that explain how to use LogicGate for the compliance policy lifecycle.

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
- Use TODAY'S DATE to answer any time-sensitive questions (what's overdue, what's coming due this month, days until review, etc.)
- review_status "overdue" = past next_review_date; "due-soon" = within 30 days; "ok" = on track; "pending-review" = in active review; "extension-coming-due" = extended deadline within 30 days; "overdue-past-extension" = past extended deadline
- Intake docs (draft/in-review) may be overdue due to regulatory deadline drivers — this is intentional
- Retired docs exist in the data but are hidden from the library by default
- You have two content sources: (1) POLICY LIBRARY — the 169 compliance policies/standards; (2) PROCESS PROCEDURES — step-by-step guides for using LogicGate (annual review, document management, approval workflows, exception management). When a question is about how to do something in LogicGate, prioritize process procedure content. When a question is about what a policy says or requires, prioritize policy library content.
- Process document IDs: PROC-NNN (procedures), DTP-NNN (desktop procedures), TRN-NNN (training guides)
- This is a multi-turn conversation. Use prior messages in the thread to understand follow-up questions and resolve pronouns or references (e.g. "those docs", "the ones you mentioned", "that policy")
- For each message, the top 4 most relevant policies (by keyword match against your query + recent context) have their full indexed text appended; any further matches are listed by doc ID only
- Answer from the appended policy text directly and confidently — do not hedge or say text was "partially retrieved"
- For additionally listed doc IDs, describe them using the metadata in your system prompt (title, owner, tier, status, domain)
- If a specific detail is genuinely absent from all retrieved content, say it is not specified in the policy library
- Never use framing like "based on the retrieved content" or "from what I can see" — just answer directly
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
