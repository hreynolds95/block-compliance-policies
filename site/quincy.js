// Quincy — Block Compliance Policy Chatbot
// Calls the Anthropic API via the Cloudflare Worker proxy (proxy/worker.js).
// Set PROXY_URL to your deployed worker URL before going live.

(function () {
  'use strict';

  const PROXY_URL          = 'https://quincy-proxy.hmreynolds95.workers.dev/v1/messages';
  const MODEL              = 'claude-opus-4-6';
  const MAX_HISTORY_TURNS  = 10; // max messages sent to API; older turns are dropped silently

  let chatHistory   = [];       // sent to API (user turns contain RAG-augmented content)
  let userQueries   = [];       // raw user text only — used for context-aware retrieval
  let systemPrompt  = null;
  let isStreaming   = false;

  // Sentinels Claude appends — extracted and stripped before display
  const FOLLOWUPS_RE    = /\[\[FOLLOWUPS:([\s\S]*?)\]\]/;
  const FILTER_RE       = /\[\[FILTER:([\s\S]*?)\]\]/;
  // Strip everything from the first sentinel onward during streaming
  const PARTIAL_STRIP_RE = /\[\[(FOLLOWUPS|FILTER)[\s\S]*$/;
  let searchIndex   = null;   // Map<doc_id, text> — loaded once on first open
  let indexState    = 'idle'; // 'idle' | 'loading' | 'ready' | 'failed'
  let processIndex  = null;   // Map<proc_id, {title, description, text}> — process procedures
  let procState     = 'idle'; // 'idle' | 'loading' | 'ready' | 'failed'
  let docMeta       = new Map(); // doc_id → { title, published_pdf } for download formatting
  let allDocMeta    = [];        // full metadata array for lightweight metadata searches
  let pageCtx           = 'library'; // 'library' | 'dashboard'
  let getContextFn      = null;      // callback returning current page filter context string
  let pageContextText   = null;      // most recent result of getContextFn()
  let starters          = [];        // data-driven starter questions
  let trimmingNoticeShown = false;   // true once the trim separator has been inserted

  // ── Bootstrap ─────────────────────────────────────────────────────────────────

  function init(docs, opts = {}) {
    pageCtx      = opts.page       || 'library';
    getContextFn = opts.getContext || null;
    starters     = buildStarters(docs, pageCtx);
    systemPrompt = buildSystemPrompt(docs, pageCtx);
    docs.forEach(d => docMeta.set(d.doc_id, { title: d.title, published_pdf: d.published_pdf || null }));
    allDocMeta = docs.map(d => ({
      doc_id:           d.doc_id,
      title:            d.title            || '',
      owner:            d.owner            || '',
      tier:             d.tier             || '',
      domain:           d.domain           || '',
      business:         d.business         || '',
      legal_entity:     d.legal_entity     || '',
      status:           d.status           || '',
      review_status:    d.review_status    || '',
      next_review_date: d.next_review_date || '',
      doc_type:         d.doc_type         || '',
      lifecycle_status: d.lifecycle_status || '',
    }));
    injectHTML();
    wireEvents();

    // Restore prior session if one exists (survives library ↔ dashboard navigation)
    if (loadSession()) {
      const messagesEl = document.getElementById('qMessages');
      messagesEl.innerHTML = '';
      restoreMessages(messagesEl);
      document.getElementById('qNewChat').style.display = '';
    }
  }

  // ── Session persistence ───────────────────────────────────────────────────────

  const SESSION_KEY = 'quincy_session';

  function saveSession() {
    try {
      sessionStorage.setItem(SESSION_KEY, JSON.stringify({
        history: chatHistory,
        queries: userQueries,
      }));
    } catch (_) {}
  }

  function loadSession() {
    try {
      const raw = sessionStorage.getItem(SESSION_KEY);
      if (!raw) return false;
      const { history, queries } = JSON.parse(raw);
      if (!Array.isArray(history) || !history.length) return false;
      chatHistory = history;
      userQueries = Array.isArray(queries) ? queries : [];
      return true;
    } catch (_) { return false; }
  }

  function clearSession() {
    try { sessionStorage.removeItem(SESSION_KEY); } catch (_) {}
  }

  function trimmedHistory() {
    if (chatHistory.length <= MAX_HISTORY_TURNS) return chatHistory;
    let slice = chatHistory.slice(-MAX_HISTORY_TURNS);
    // Ensure we start on a user turn (API requires messages[0].role === 'user')
    if (slice[0]?.role !== 'user') slice = slice.slice(1);
    return slice;
  }

  function restoreMessages(messagesEl) {
    // Reconstruct bubbles from chatHistory + userQueries (alternating user/bot turns)
    const botTurns = chatHistory.filter((_, i) => i % 2 === 1);
    for (let i = 0; i < botTurns.length; i++) {
      if (userQueries[i]) {
        const uDiv = document.createElement('div');
        uDiv.className = 'q-msg q-msg--user';
        uDiv.innerHTML = `<div class="q-bubble">${esc(userQueries[i])}</div>`;
        messagesEl.appendChild(uDiv);
      }
      const bDiv = document.createElement('div');
      bDiv.className = 'q-msg q-msg--bot';
      bDiv.innerHTML = `<div class="q-bubble">${md(botTurns[i].content)}</div>`;
      messagesEl.appendChild(bDiv);
    }
    // Edge case: trailing user turn with no bot response
    if (userQueries.length > botTurns.length) {
      const uDiv = document.createElement('div');
      uDiv.className = 'q-msg q-msg--user';
      uDiv.innerHTML = `<div class="q-bubble">${esc(userQueries[botTurns.length])}</div>`;
      messagesEl.appendChild(uDiv);
    }
    messagesEl.scrollTop = 999999;
  }

  // ── HTML injection ────────────────────────────────────────────────────────────

  function buildStarters(docs, page) {
    if (page === 'dashboard') {
      return [
        'Which owner has the most overdue policies?',
        'What is the review health across each business unit?',
        'Which financial crimes policies are coming due soon?',
        'How does Block\'s compliance posture compare across domains?',
      ];
    }
    // Library — tailor first starter to actual overdue count
    const pub = docs.filter(d => d.status === 'published');
    const n   = pub.filter(d => ['overdue','pending-review','overdue-past-extension'].includes(d.review_status)).length;
    return [
      n > 0 ? `What are the ${n} overdue policies right now?` : 'Which policies are coming due for review?',
      'What AML policies apply to Cash App?',
      'Who owns Block\'s Tier 1 governance policies?',
      'How do I submit a policy exception in LogicGate?',
    ];
  }

  function welcomeHTML() {
    const greeting = pageCtx === 'dashboard'
      ? 'Hi, I\'m Quincy. Ask me about the compliance metrics — overdue trends, ownership health, review schedules, or anything across Block\'s full policy library.'
      : 'Hi, I\'m Quincy. Ask me anything about Block\'s compliance policies — owners, tiers, review status, domains, or which documents cover a given topic.';
    const chips = starters.map(q =>
      `<button class="q-starter" type="button">${esc(q)}</button>`
    ).join('');
    return `
      <div class="q-msg q-msg--bot">
        <div class="q-bubble">${esc(greeting)}</div>
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
    if (getContextFn) pageContextText = getContextFn();
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

  // ── Metadata query detection & search ────────────────────────────────────────

  // Patterns that signal a question answerable from doc metadata alone
  const METADATA_SIGNALS = [
    /\bwho\s+(owns?|is\s+(the\s+)?owner)\b/i,
    /\bwhat\s+(tier|domain|owner|status)\b/i,
    /\bwhich\s+(tier|domain)\b/i,
    /\b(list|show)\s+(all|me|every)\b/i,
    /\bhow\s+many\b/i,
    /\b(all\s+)?(overdue|coming[\s-]due|due[\s-]soon|past[\s-]due)\b/i,
    /\breview\s+(date|status|deadline|schedule)\b/i,
    /\b(next|upcoming)\s+review\b/i,
    /\bdue\s+(date|in\b|by\b)/i,
    /\bwhen\s+is\b/i,
    /\btier\s*[123]\b/i,
    /\bextension\s+status\b/i,
    /\b(all\s+)?(policies|standards|procedures)\b/i,
    /\bdoc(ument)?\s+type\b/i,
    /\b(under\s+qc|in[\s-]approvals?|lifecycle\s+status)\b/i,
  ];

  function isMetadataQuery(query) {
    return METADATA_SIGNALS.some(p => p.test(query));
  }

  const META_STOP_WORDS = new Set([
    'the','and','for','are','that','this','with','what','who','which',
    'how','all','any','its','our','they','them','have','has','been',
    'will','from','about','show','list','tell','many','does','did',
    'owns','own','give','get','find','please','policy','policies',
  ]);

  function searchDocsMeta(query) {
    const terms = query.toLowerCase()
      .replace(/[^\w\s]/g, ' ')
      .split(/\s+/)
      .filter(t => t.length > 2 && !META_STOP_WORDS.has(t));
    if (!terms.length) return [];

    const scored = allDocMeta.map(doc => {
      const haystack = [
        doc.title, doc.owner, doc.domain, doc.business,
        doc.legal_entity, doc.tier, doc.review_status, doc.status,
        doc.doc_type, doc.lifecycle_status,
      ].join(' ').toLowerCase();
      let score = 0;
      for (const kw of terms) {
        if (haystack.includes(kw)) score++;
        if (doc.title.toLowerCase().includes(kw)) score += 2; // title match weighted higher
      }
      return { doc, score };
    });

    return scored
      .filter(s => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 20)
      .map(s => s.doc);
  }

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
    trimmingNoticeShown = false;
    clearSession();
    if (getContextFn) pageContextText = getContextFn();
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

    // Remove any follow-up chips and filter actions from the previous response before sending
    document.querySelectorAll('.q-followups, .q-filter-action').forEach(el => el.remove());

    // Show a one-time separator the first time earlier turns will be dropped
    if (!trimmingNoticeShown && chatHistory.length >= MAX_HISTORY_TURNS) {
      trimmingNoticeShown = true;
      const notice = document.createElement('div');
      notice.className = 'q-trim-notice';
      notice.textContent = 'Earlier messages not sent to Claude';
      document.getElementById('qMessages').appendChild(notice);
    }

    appendMessage('user', text);
    userQueries.push(text);
    document.getElementById('qNewChat').style.display = '';
    const starters = document.getElementById('qStarters');
    if (starters) starters.remove();

    // Augment with retrieved content — strategy depends on query intent
    const retrievalQuery = buildRetrievalQuery(text);
    let userContent = text;
    const sections = [];
    let retrievedDocs = [];  // full-text excerpts passed to download file

    if (isMetadataQuery(retrievalQuery)) {
      // Metadata question (owner, tier, status, review dates, counts) —
      // search the docs array directly and inject a compact metadata table.
      // Claude already has all metadata in its system prompt; this just narrows
      // the relevant docs so it doesn't have to scan all entries.
      const matches = searchDocsMeta(retrievalQuery);
      if (matches.length > 0) {
        const rows = matches.map(d => {
          let row = `${d.doc_id} | ${d.title} | Tier ${d.tier} | Owner: ${d.owner} | ${d.status} | review_status: ${d.review_status}`;
          if (d.next_review_date) row += ` | Next review: ${d.next_review_date}`;
          return row;
        }).join('\n');
        sections.push(`METADATA LOOKUP — ${matches.length} matching document(s):\n${rows}`);
      }
      // Also check process procedures for any "how do I" component
      const { procedures } = retrieveRelevantDocs(retrievalQuery);
      if (procedures.length > 0) {
        const procText = procedures.map(p => `[${p.procId}] ${p.title}\n${p.excerpt}`).join('\n\n');
        sections.push(`PROCESS PROCEDURES — top ${procedures.length} matches (full text):\n${procText}`);
      }
    } else {
      // Content question — use full-text RAG against policy and procedure indexes
      const { top, additional, procedures } = retrieveRelevantDocs(retrievalQuery);
      retrievedDocs = top;
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
    }

    if (sections.length > 0) {
      userContent = `${text}\n\n---\n${sections.join('\n\n---\n')}`;
    }

    // On the first message of a conversation, prepend active page context (not shown to user)
    if (chatHistory.length === 0 && pageContextText) {
      userContent = `[Page context: ${pageContextText}]\n\n${userContent}`;
    }

    chatHistory.push({ role: 'user', content: userContent });

    const botEl  = appendMessage('bot', '');
    const bubble = botEl.querySelector('.q-bubble');
    bubble.innerHTML = '<span class="q-typing"><span></span><span></span><span></span></span>';

    // Add download button immediately — it will capture whatever is generated
    // even if the response is later truncated
    addDownloadButton(botEl, text, () => fullText, retrievedDocs);

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
          messages: trimmedHistory(),
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
              const displayText = fullText.replace(PARTIAL_STRIP_RE, '').trimEnd();
              bubble.innerHTML = md(displayText) + '<span class="q-cursor"></span>';
              messagesEl.scrollTop = messagesEl.scrollHeight;
            }

            if (evt.type === 'message_delta' && evt.delta?.stop_reason === 'max_tokens') {
              truncated = true;
            }
          } catch (_) {}
        }
      }

      // Extract and strip sentinels before finalising display
      let filterAction = null;
      const filterMatch = fullText.match(FILTER_RE);
      if (filterMatch) {
        try { filterAction = JSON.parse(filterMatch[1]); } catch (_) {}
        fullText = fullText.replace(FILTER_RE, '').trimEnd();
      }

      let followups = [];
      const fuMatch = fullText.match(FOLLOWUPS_RE);
      if (fuMatch) {
        try { followups = JSON.parse(fuMatch[1]); } catch (_) {}
        fullText = fullText.replace(FOLLOWUPS_RE, '').trimEnd();
      }

      bubble.innerHTML = md(fullText);
      if (truncated) {
        bubble.innerHTML += `<p class="q-truncated">Response reached the length limit — the download below contains everything generated.</p>`;
      }
      chatHistory.push({ role: 'assistant', content: fullText });
      saveSession();
      document.getElementById('qMessages').scrollTop = 999999;

      // Render follow-ups first so the filter button lands above them (insertAdjacentElement afterend reverses)
      if (followups.length > 0) renderFollowups(botEl, followups);
      if (filterAction?.url && filterAction?.label) renderFilterAction(botEl, filterAction);

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

  function renderFilterAction(msgEl, { label, url }) {
    // Only allow relative query-string URLs to prevent open redirect
    if (typeof url !== 'string' || !url.startsWith('?')) return;
    const div = document.createElement('div');
    div.className = 'q-filter-action';
    div.innerHTML = `<a href="./index.html${esc(url)}" class="q-library-link">${esc(label)}&nbsp;→</a>`;
    msgEl.insertAdjacentElement('afterend', div);
    document.getElementById('qMessages').scrollTop = 999999;
  }

  function renderFollowups(msgEl, questions) {
    const div = document.createElement('div');
    div.className = 'q-starters q-followups';
    div.innerHTML = questions
      .filter(q => typeof q === 'string' && q.trim())
      .map(q => `<button class="q-starter" type="button">${esc(q.trim())}</button>`)
      .join('');
    msgEl.insertAdjacentElement('afterend', div);
    document.getElementById('qMessages').scrollTop = 999999;
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
    // Pre-group consecutive table rows into table segments so the line loop
    // doesn't have to deal with partial pipe-delimited lines mid-stream.
    const lines = raw.split('\n');
    const segments = [];
    let i = 0;
    while (i < lines.length) {
      const t = lines[i].trim();
      if (t.startsWith('|') && t.endsWith('|') && t.length > 2) {
        const tableLines = [];
        while (i < lines.length) {
          const tl = lines[i].trim();
          if (tl.startsWith('|') && tl.endsWith('|') && tl.length > 2) {
            tableLines.push(tl);
            i++;
          } else break;
        }
        segments.push({ type: 'table', lines: tableLines });
      } else {
        segments.push({ type: 'text', line: lines[i] });
        i++;
      }
    }

    let html = '';
    let inUl = false;
    let inOl = false;

    function closeList() {
      if (inUl) { html += '</ul>'; inUl = false; }
      if (inOl) { html += '</ol>'; inOl = false; }
    }

    for (const seg of segments) {
      if (seg.type === 'table') {
        closeList();
        html += renderTable(seg.lines);
        continue;
      }

      const line = seg.line;
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

  function renderTable(lines) {
    function cells(line) {
      return line.replace(/^\||\|$/g, '').split('|').map(c => c.trim());
    }
    // Separator rows contain only dashes, colons, and spaces in each cell
    function isSep(line) {
      return cells(line).every(c => /^[-:\s]+$/.test(c) && c.trim().length > 0);
    }

    const sepIdx = lines.findIndex(isSep);
    const headerRows = sepIdx > 0 ? lines.slice(0, sepIdx) : [];
    const bodyRows   = sepIdx >= 0 ? lines.slice(sepIdx + 1) : lines;

    let t = '<table class="q-table"><thead>';
    for (const row of headerRows) {
      t += '<tr>' + cells(row).map(c => `<th>${inline(c)}</th>`).join('') + '</tr>';
    }
    t += '</thead><tbody>';
    for (const row of bodyRows) {
      if (!row.trim()) continue;
      t += '<tr>' + cells(row).map(c => `<td>${inline(c)}</td>`).join('') + '</tr>';
    }
    t += '</tbody></table>';
    return t;
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

  // ── Message action buttons (copy + download) ─────────────────────────────────

  function addDownloadButton(msgEl, question, responseTextOrFn, retrieved) {
    const group = document.createElement('div');
    group.className = 'q-msg-actions';

    // Copy button
    const copyBtn = document.createElement('button');
    copyBtn.className = 'q-action-btn';
    copyBtn.title = 'Copy response';
    copyBtn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`;
    copyBtn.addEventListener('click', () => {
      const text = typeof responseTextOrFn === 'function' ? responseTextOrFn() : responseTextOrFn;
      navigator.clipboard.writeText(text).then(() => {
        copyBtn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`;
        copyBtn.style.color = 'var(--success)';
        copyBtn.style.borderColor = 'var(--success)';
        setTimeout(() => {
          copyBtn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`;
          copyBtn.style.color = '';
          copyBtn.style.borderColor = '';
        }, 2000);
      });
    });

    // Download button
    const dlBtn = document.createElement('button');
    dlBtn.className = 'q-action-btn';
    dlBtn.title = 'Download response as Markdown';
    dlBtn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>`;
    dlBtn.addEventListener('click', () => {
      const text = typeof responseTextOrFn === 'function' ? responseTextOrFn() : responseTextOrFn;
      downloadResponse(question, text, retrieved);
    });

    group.appendChild(copyBtn);
    group.appendChild(dlBtn);
    msgEl.appendChild(group);
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

  function buildSystemPrompt(docs, page) {
    const context = JSON.stringify(docs.map(d => ({
      doc_id:           d.doc_id,
      title:            d.title,
      domain:           d.domain,
      tier:             d.tier,
      status:           d.status,
      owner:            d.owner,
      approval_type:    d.approval_type,
      doc_type:         d.doc_type         || null,
      business:         d.business         || null,
      legal_entity:     d.legal_entity     || null,
      effective_date:   d.effective_date   || null,
      next_review_date: d.next_review_date || null,
      review_status:    d.review_status,
      lifecycle_status: d.lifecycle_status || null,
      retention_years:  d.retention_years  || null,
      extension_status: d.extension_status || null,
      extended_due_date:d.extended_due_date|| null,
    })));

    const today = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });

    const pageSection = page === 'dashboard'
      ? `CURRENT PAGE: Metrics Dashboard. The user is looking at compliance KPIs, trend charts, and breakdown tables — not browsing individual documents. Prioritize quantitative summaries, rankings, and "so what" insights. Lead with the number and what it means (e.g. "12 overdue — 4 legitimately past due, 8 still active in LogicGate pending retirement"). Avoid listing individual doc IDs unless explicitly asked.`
      : `CURRENT PAGE: Policy Library. The user is browsing or searching individual compliance documents. Prioritize specific policy content, requirements, applicability, ownership, and review deadlines. Cite doc IDs freely.`;

    return `You are Quincy, Block Inc.'s compliance policy assistant. Block is the parent company of Square, Cash App, Afterpay, TIDAL, and Spiral.

TODAY'S DATE: ${today}

${pageSection}

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
- Lead with a direct answer (1–2 sentences) — no preamble like "Great question!" or "Based on the data..."
- Always cite document IDs (e.g. CP-001, GOV-015) when referencing specific policies on the library page
- Be precise about status (published/draft/in-review/retired), tier, owner, and review dates
- Use TODAY'S DATE to answer any time-sensitive questions (what's overdue, what's coming due this month, days until review, etc.)
- review_status values: "overdue" = past next_review_date; "due-soon" = within 90 days; "ok" = on track; "pending-review" = in active review cycle; "extension-coming-due" = extended deadline within 90 days; "overdue-past-extension" = past extended deadline
- doc_type: "Policy" = top-level policy document; "Standard" = operational standard; "Procedure" = step-by-step procedure
- lifecycle_status (published docs only): "current" = active and up to date; "under-qc" = currently in QC review step; "in-approvals" = in the approvals and publication tollgate
- Intake docs (draft/in-review) may be overdue due to regulatory deadline drivers — this is intentional
- Retired docs exist in the data but are hidden from the library by default
- You have two content sources: (1) POLICY LIBRARY — the ${docs.length} compliance policies/standards; (2) PROCESS PROCEDURES — step-by-step guides for using LogicGate (annual review, document management, approval workflows, exception management). When a question is about how to do something in LogicGate, prioritize process procedure content. When a question is about what a policy says or requires, prioritize policy library content.
- Process document IDs: PROC-NNN (procedures), DTP-NNN (desktop procedures), TRN-NNN (training guides)
- This is a multi-turn conversation. Use prior messages in the thread to understand follow-up questions and resolve pronouns or references (e.g. "those docs", "the ones you mentioned", "that policy")
- For metadata questions (owner, tier, domain, status, review dates, counts), a METADATA LOOKUP table is appended with the most relevant documents — answer from that combined with POLICY LIBRARY DATA above
- For content questions (what does a policy say, what are the requirements), the top 4 matching policies have their full indexed text appended; additional matches are listed by doc ID only
- Answer directly and confidently — do not hedge or say text was "partially retrieved"
- For doc IDs not in the appended text, describe them using the metadata in POLICY LIBRARY DATA (title, owner, tier, status, domain)
- If a specific detail is genuinely absent from all retrieved content, say it is not specified in the policy library
- Never use framing like "based on the retrieved content" or "from what I can see" — just answer directly
- Keep answers professional, accurate, and concise
- When listing multiple documents, use a bulleted list
- When your response addresses a filterable subset of the policy library, append a filter action on its own line before [[FOLLOWUPS]]: [[FILTER:{"label":"View [description] in Library","url":"?param=value"}]]. Valid params and values — review: overdue|due-soon|ok|pending-review|extension-coming-due|overdue-past-extension; domain: consumer-protection|ethics-and-employee-conduct|financial-crimes|governance; status: published|draft|in-review|retired|not-published; business: Square|Block|Cash App|Afterpay|Clearpay; tier: 1|2|3; extension: active; doc_type: Policy|Standard|Procedure; lifecycle: current|under-qc|in-approvals. Only include when ONE clear filter maps to your entire answer. Omit for general, multi-filter, or narrative-only responses.
- At the very end of every response, on its own line, append exactly: [[FOLLOWUPS:["q1","q2","q3"]]] with 2–3 follow-up questions. Rules: (1) Each question must reference something specific from your response — a named owner, doc ID, domain, count, or metric, not a generic topic. (2) Each question must be a natural next step, not a restatement of what you already answered. (3) ${page === 'dashboard' ? 'On the dashboard: offer to slice the same data by a different dimension (e.g. domain → owner → tier), surface a specific outlier you mentioned, or compare two groups from your answer.' : 'On the library: suggest exploring a specific policy\'s requirements, other docs owned by the same person, related policies in the same domain, or a compliance action the user might need to take.'} (4) Never start with "Can you...", "Tell me more...", or "Are there any other...". (5) Must be a valid JSON array of strings. Do not introduce or label this block.`;
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
