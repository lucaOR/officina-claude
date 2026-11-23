// Adapted from superpowers (MIT), Copyright (c) 2025 Jesse Vincent
// The plan page's browser client. It binds to the markup lib/page.mjs renders and holds no plan
// state: every action is a same-origin JSON POST to /api/, and the WebSocket only pushes "reload".
// The page keeps view state (open tab, scroll, open threads) in sessionStorage across a reload.
(function () {
  'use strict';
  const CLIENT_MARKER = 'planning-page-client-v1';
  const VIEW_KEY = 'planning-view';
  const MIN_RECONNECT_MS = 500;
  const MAX_RECONNECT_MS = 30000;
  const PAUSED_AFTER_MS = 15000; // show the "paused" overlay after this long disconnected
  const HIGHLIGHT_MS = 1500;
  const PRESETS = ['Why this option?', 'What happens at scale?', 'Where does the data come from?', 'Explain it like I\'m new'];

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  const esc = value => (window.CSS && CSS.escape ? CSS.escape(value) : String(value).replace(/["\\]/g, '\\$&'));

  function el(tag, props = {}, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(props)) {
      if (key === 'class') node.className = value;
      else if (key === 'text') node.textContent = value;
      else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
      else node.setAttribute(key, value);
    }
    for (const child of children.flat()) if (child) node.append(child);
    return node;
  }

  // ---- talking to the server ---------------------------------------------------------------

  /** POST a JSON body to /api/<name>; resolves to { status, ok, data } and never throws on HTTP errors. */
  async function api(name, body) {
    let response;
    try {
      response = await fetch('/api/' + name, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify(body || {}),
      });
    } catch (err) {
      return { status: 0, ok: false, data: { error: 'The plan server cannot be reached (' + err.message + ').' } };
    }
    let data = {};
    try { data = await response.json(); } catch { /* an error page without a JSON body */ }
    return { status: response.status, ok: response.ok, data };
  }

  /** The text to show for a failed response: 422 diagnostics, 409 conflict, or the server's error. */
  function describe(res) {
    const d = res.data || {};
    if (Array.isArray(d.diagnostics) && d.diagnostics.length) return d.diagnostics.map(x => (x.path ? x.path + ': ' : '') + x.message).join('\n');
    if (d.error) return d.error;
    if (res.status === 409) return 'That conflicts with a later change.';
    if (res.status === 403) return 'The server refused the request. Reopen the page from the full URL your coding agent gave you.';
    return 'The request failed (HTTP ' + res.status + ').';
  }

  // ---- toast ---------------------------------------------------------------------------------

  let toastBox = null;
  function toast(message, kind = 'info') {
    if (!toastBox) {
      toastBox = el('div', { class: 'pl-toasts' });
      document.body.append(toastBox);
    }
    const item = el('div', { class: 'pl-toast ' + kind, role: kind === 'error' ? 'alert' : 'status' }, el('span', { text: message }),
      el('button', { type: 'button', 'aria-label': 'Dismiss', text: 'Close', onclick: () => item.remove() }));
    toastBox.append(item);
    if (kind !== 'error') setTimeout(() => item.remove(), 5000);
  }

  // ---- dialog --------------------------------------------------------------------------------

  /** A modal with a title, paragraphs, an optional list and buttons; resolves to the clicked value (null on Escape). */
  function askDialog({ title, paragraphs = [], items = [], footer = '', buttons }) {
    return new Promise(resolve => {
      const dlg = el('dialog', { class: 'pl-dialog' });
      const done = value => { dlg.close(); dlg.remove(); resolve(value); };
      dlg.append(el('h3', { text: title }), ...paragraphs.map(text => el('p', { text })));
      if (items.length) dlg.append(el('ul', {}, items.map(text => el('li', { text }))));
      if (footer) dlg.append(el('p', { text: footer }));
      dlg.append(el('div', { class: 'pl-actions' }, buttons.map(b => el('button', {
        type: 'button', class: b.primary ? 'primary' : '', text: b.label, onclick: () => done(b.value),
      }))));
      dlg.addEventListener('cancel', event => { event.preventDefault(); done(null); });
      document.body.append(dlg);
      dlg.showModal();
    });
  }

  // ---- tabs, jumps ---------------------------------------------------------------------------

  const panels = () => $$('[data-tab-panel]');
  let currentTab = 'overview';

  function showTab(id) {
    if (!panels().some(p => p.dataset.tabPanel === id)) return false;
    currentTab = id;
    for (const p of panels()) p.hidden = p.dataset.tabPanel !== id;
    for (const a of $$('a[data-tab]')) a.classList.toggle('on', a.dataset.tab === id);
    return true;
  }

  function highlight(target) {
    target.classList.add('hl');
    setTimeout(() => target.classList.remove('hl'), HIGHLIGHT_MS);
  }

  /** Jump to the element with this id: switch to its tab, open what hides it, scroll, highlight for 1.5 s. */
  function jump(id) {
    const target = document.getElementById(id);
    if (!target) return false;
    const panel = target.closest('[data-tab-panel]');
    if (panel) showTab(panel.dataset.tabPanel);
    for (let d = target.closest('details'); d; d = d.parentElement?.closest('details')) d.open = true;
    target.scrollIntoView({ block: 'center' });
    highlight(target);
    return true;
  }

  function route(hash) {
    const id = decodeURIComponent(String(hash || '').replace(/^#/, ''));
    if (!id) return false;
    return showTab(id) || jump(id);
  }

  // ---- diagram <-> card linking --------------------------------------------------------------
  // Adapted and modified from Archify explainer/reader.js (the `spotlight` and `linkTerms`
  // functions), licensed Apache-2.0; see vendor/archify/LICENSE and NOTICE.

  // The named nodes stay lit and the rest of the diagram dims.
  function spotlight(figure, nodes = []) {
    const svgHost = $('.pl-diagram', figure);
    if (!svgHost) return;
    let matched = false;
    for (const node of $$('[data-node-id]', svgHost)) {
      const hit = nodes.includes(node.dataset.nodeId);
      matched ||= hit;
      node.classList.toggle('hl', hit);
    }
    svgHost.classList.toggle('focusing', matched);
  }

  const figuresIn = panel => $$('figure[data-diagram]', panel || document);
  const cardsFor = (panel, nodeId) => $$('[data-nodes]', panel).filter(c => c.dataset.nodes.split(/\s+/).includes(nodeId));

  let lit = null;
  function clearLit() {
    if (!lit) return;
    for (const figure of figuresIn()) spotlight(figure, []);
    for (const card of $$('.lit')) card.classList.remove('lit');
    for (const term of $$('.term-lit')) term.classList.remove('term-lit');
    lit = null;
  }

  function lightFrom(source) {
    const panel = source.closest('[data-tab-panel]');
    if (source.matches('[data-node-id]')) {
      const id = source.dataset.nodeId;
      for (const card of cardsFor(panel, id)) card.classList.add('lit');
      for (const term of $$('.term', panel)) term.classList.toggle('term-lit', term.dataset.node === id && term.dataset.diagram === source.closest('figure')?.dataset.diagram);
      return;
    }
    const nodes = source.matches('.term') ? [source.dataset.node] : (source.dataset.nodes || '').split(/\s+/).filter(Boolean);
    for (const figure of figuresIn(panel)) {
      if (!source.matches('.term') || figure.dataset.diagram === source.dataset.diagram) spotlight(figure, nodes);
    }
  }

  function onHover(event) {
    const source = event.target.closest?.('[data-node-id],[data-nodes],.term');
    if (source === lit) return;
    clearLit();
    if (!source) return;
    lit = source;
    lightFrom(source);
  }

  // A name in the text that is also a node label becomes a hover link to that node, once per panel.
  function linkTerms() {
    const word = /[\p{L}\p{N}_]/u;
    for (const panel of panels()) {
      const terms = new Map();
      for (const figure of figuresIn(panel)) {
        for (const node of $$('[data-node-id][data-node-label]', figure)) {
          const label = node.dataset.nodeLabel.trim();
          if (label.length >= 3 && !terms.has(label.toLowerCase())) terms.set(label.toLowerCase(), { diagram: figure.dataset.diagram, node: node.dataset.nodeId });
        }
      }
      if (!terms.size) continue;
      const pattern = new RegExp([...terms.keys()].sort((a, b) => b.length - a.length).map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'giu');
      const walker = document.createTreeWalker(panel, NodeFilter.SHOW_TEXT, {
        acceptNode: text => (text.parentElement.closest('figure,pre,code,a,button,svg,script,style,.term,.thread,.tag,.did,summary,thead,textarea') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
      });
      const texts = [];
      while (walker.nextNode()) texts.push(walker.currentNode);
      const seen = new Set();
      for (const text of texts) {
        const value = text.nodeValue;
        const parts = [];
        let last = 0;
        for (const match of value.matchAll(pattern)) {
          const before = value[match.index - 1];
          const after = value[match.index + match[0].length];
          if (seen.has(match[0].toLowerCase()) || (before && word.test(before)) || (after && word.test(after))) continue;
          seen.add(match[0].toLowerCase());
          parts.push(value.slice(last, match.index), match[0]);
          last = match.index + match[0].length;
        }
        if (!parts.length) continue;
        const fragment = document.createDocumentFragment();
        parts.forEach((part, i) => {
          if (i % 2 === 0) { fragment.append(part); return; }
          const target = terms.get(part.toLowerCase());
          fragment.append(el('span', { class: 'term', 'data-diagram': target.diagram, 'data-node': target.node, text: part }));
        });
        fragment.append(value.slice(last));
        text.replaceWith(fragment);
      }
    }
  }

  // ---- the Ask popover -----------------------------------------------------------------------

  let pop = null;
  let reloadDeferred = false;

  // A popover holding typed text survives reloads, outside clicks and other Ask clicks; only Cancel,
  // Escape and Send close it.
  const popoverHasText = () => Boolean(pop && $('textarea', pop.root)?.value.trim());

  function closePopover() {
    if (!pop) return;
    pop.root.remove();
    pop = null;
    if (reloadDeferred) reloadPage();
  }

  /** The element a target code belongs to: the figure for node:<diagram>.<node>, else its data-ask-target. */
  function askElement(target) {
    const node = /^node:([^.]+)\./.exec(target);
    if (node) return $(`figure[data-diagram="${esc(node[1])}"]`);
    return $(`[data-ask-target="${esc(target)}"]`);
  }

  /** Mark an element as waiting for Claude until the next reload (the server renders it after one). */
  function markWaiting(target, threadEl) {
    const host = threadEl || askElement(target);
    if (!host) return;
    host.setAttribute('data-pending', '');
    const scope = threadEl || (() => {
      let notes = $(':scope > .notes', host);
      if (!notes) { notes = el('div', { class: 'notes' }); host.append(notes); }
      return notes;
    })();
    if ($('.wait', scope)) return;
    const wait = el('div', { class: 'wait', text: 'Waiting for Claude.' });
    const actions = $(':scope > .tactions', scope);
    if (actions) scope.insertBefore(wait, actions); else scope.append(wait);
  }

  function openPopover(anchor, target, label) {
    if (popoverHasText()) { $('textarea', pop.root).focus(); return; } // keep the half-written question
    closePopover();
    let kind = 'comment';
    const text = el('textarea', { rows: '4', 'aria-label': 'Your note', placeholder: 'Write a comment or describe the change you want' });
    const status = el('div', { class: 'pl-status', role: 'alert' });
    const send = el('button', { type: 'button', class: 'primary', text: 'Send', disabled: '' });
    const toggles = ['comment', 'change'].map(k => el('button', {
      type: 'button', 'aria-pressed': String(k === kind), 'data-kind': k, text: k === 'comment' ? 'Comment' : 'Change request',
      onclick: () => { kind = k; toggles.forEach(b => b.setAttribute('aria-pressed', String(b.dataset.kind === kind))); },
    }));
    const presets = PRESETS.map(p => el('button', { type: 'button', class: 'preset', text: p, onclick: () => { text.value = p; sync(); text.focus(); } }));
    const sync = () => { if (text.value.trim()) send.removeAttribute('disabled'); else send.setAttribute('disabled', ''); };
    text.addEventListener('input', sync);

    async function submit() {
      if (!text.value.trim()) return;
      send.setAttribute('disabled', '');
      status.textContent = '';
      const res = await api('ask', { kind, target, text: text.value.trim() });
      if (!res.ok) { status.textContent = describe(res); sync(); return; }
      markWaiting(target);
      closePopover();
    }
    send.addEventListener('click', submit);
    text.addEventListener('keydown', event => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); submit(); } });

    const root = el('div', { class: 'pl-pop', role: 'dialog', 'aria-label': 'Ask about ' + label },
      el('div', { class: 'pl-pop-head', text: label }),
      el('div', { class: 'pl-toggle' }, toggles),
      el('div', { class: 'pl-presets' }, presets), text, status,
      el('div', { class: 'pl-actions' }, el('button', { type: 'button', text: 'Cancel', onclick: closePopover }), send));
    document.body.append(root);
    const box = anchor.getBoundingClientRect();
    const left = Math.max(8, Math.min(window.scrollX + box.left, window.scrollX + document.documentElement.clientWidth - root.offsetWidth - 8));
    root.style.left = left + 'px';
    root.style.top = (window.scrollY + box.bottom + 6) + 'px';
    pop = { root, anchor };
    text.focus();
  }

  const nodeLabel = node => node.dataset.nodeLabel || node.dataset.nodeId;

  function askAboutNode(node) {
    const figure = node.closest('figure[data-diagram]');
    if (!figure) return;
    openPopover(node, `node:${figure.dataset.diagram}.${node.dataset.nodeId}`, nodeLabel(node));
  }

  // ---- actions -------------------------------------------------------------------------------

  async function withBusy(button, work) {
    button.disabled = true;
    try { await work(); } finally { button.disabled = false; }
  }

  async function doPick(button) {
    const target = button.dataset.pick;
    const res = await api('pick', { target, option: button.dataset.option });
    if (!res.ok) { toast(describe(res), 'error'); return; }
    markWaiting(target);
    toast('Picked. Claude will check what it affects.');
  }

  async function doResolve(button) {
    const res = await api('resolve', { thread: button.closest('[data-thread]').dataset.thread });
    if (!res.ok) { toast(describe(res), 'error'); return; }
    toast('Thread resolved.');
  }

  async function doToChange(button) {
    const thread = button.closest('[data-thread]');
    const res = await api('to-change', { thread: thread.dataset.thread });
    if (!res.ok) { toast(describe(res), 'error'); return; }
    markWaiting(null, thread);
    toast('Sent as a change request.');
  }

  async function doUndo(button) {
    const row = button.closest('[data-change]');
    const change = row.dataset.change;
    const summary = row.querySelector('b')?.textContent.trim();
    const subject = summary ? '"' + summary + '"' : 'this change';
    // A dry run first: a plain undo gets a one-line confirm, a conflicting one the dialog below.
    let res = await api('undo', { change, dryRun: true });
    if (res.ok) {
      const go = await askDialog({
        title: 'Undo ' + subject + '?',
        paragraphs: ['Its elements go back to how they were before it, and later edits to them are lost too.'],
        buttons: [{ label: 'Cancel', value: false }, { label: 'Undo', value: true, primary: true }],
      });
      if (!go) return;
      res = await api('undo', { change });
    }
    if (res.status === 409 && Array.isArray(res.data.conflict)) {
      const later = res.data.conflict;
      const choice = await askDialog({
        title: 'Undo ' + subject + ' and later changes?',
        paragraphs: [
          'These later changes touch the same elements as ' + subject + ', so undoing it means undoing them too:',
        ],
        items: later.map(c => c.summary),
        footer: 'Undo puts those elements back as they were before ' + subject + '. Edits made to them after that change are lost too.',
        buttons: [{ label: 'Cancel', value: false }, { label: 'Undo both', value: true, primary: true }],
      });
      if (!choice) return;
      res = await api('undo', { change, withLater: true });
    }
    if (!res.ok) { toast(describe(res), 'error'); return; }
    toast('Undone. The elements are back as they were before the change.');
  }

  async function doUpdateReal(button) {
    const label = button.textContent.trim();
    const choice = await askDialog({
      title: label + '?',
      paragraphs: ['This saves the plan as it stands now as the real plan and empties the list of changes.'],
      buttons: [{ label: 'Cancel', value: false }, { label, value: true, primary: true }],
    });
    if (!choice) return;
    const res = await api('update-real', {});
    if (!res.ok) { toast(describe(res), 'error'); return; }
    toast('The real plan is up to date.');
  }

  function flowTabFor(segment) {
    const figure = segment.closest('figure[data-diagram="flow"]');
    if (!figure) return null;
    const index = Number(segment.dataset.segmentId);
    const links = $$('.phases .phase-link', figure.closest('[data-tab-panel]') || document);
    return links[index]?.dataset.tabLink || null;
  }

  function onClick(event) {
    const t = event.target;
    if (!(t instanceof Element)) return;
    if (pop && !pop.root.contains(t) && !t.closest('button.ask,[data-node-id]') && !popoverHasText()) closePopover();

    const tabLinkEl = t.closest('a[data-tab-link]');
    if (tabLinkEl) { event.preventDefault(); showTab(tabLinkEl.dataset.tabLink); window.scrollTo(0, 0); return; }
    const tabEl = t.closest('a[data-tab]');
    if (tabEl) { event.preventDefault(); showTab(tabEl.dataset.tab); return; }
    const codeEl = t.closest('a[data-code]');
    if (codeEl) { event.preventDefault(); jump(codeEl.dataset.code); return; }

    const ask = t.closest('button.ask');
    if (ask) {
      const host = ask.closest('[data-ask-target]');
      if (host) openPopover(ask, host.dataset.askTarget, host.dataset.askLabel || host.dataset.askTarget);
      return;
    }
    const button = t.closest('button[data-action],button.pickbtn');
    if (button) {
      const action = button.dataset.action;
      const work = button.matches('.pickbtn') ? doPick : { resolve: doResolve, 'to-change': doToChange, undo: doUndo, 'update-real': doUpdateReal }[action];
      if (work) withBusy(button, () => work(button));
      return;
    }
    const segment = t.closest('[data-segment-id]');
    if (segment) {
      const tab = flowTabFor(segment);
      if (tab) showTab(tab);
      return;
    }
    const node = t.closest('[data-node-id]');
    if (node) { askAboutNode(node); return; }
    const tile = t.closest('.tile');
    if (tile && !t.closest('a,button')) $('a[data-tab-link]', tile)?.click();
  }

  function onKeydown(event) {
    if (event.key === 'Escape' && pop) { closePopover(); return; }
    if (event.key !== 'Enter' && event.key !== ' ') return;
    const node = event.target.closest?.('[data-node-id]');
    if (!node) return;
    event.preventDefault();
    askAboutNode(node);
  }

  // ---- view state across a reload ------------------------------------------------------------

  function saveView() {
    try {
      sessionStorage.setItem(VIEW_KEY, JSON.stringify({
        tab: currentTab,
        scroll: window.scrollY,
        threads: $$('details[data-thread][open]').map(d => d.dataset.thread),
      }));
    } catch { /* storage unavailable: the page just opens on the Overview */ }
  }

  function restoreView() {
    let view = null;
    try { view = JSON.parse(sessionStorage.getItem(VIEW_KEY) || 'null'); } catch { /* ignore */ }
    if (!view) return;
    if (view.tab) showTab(view.tab);
    for (const id of view.threads || []) {
      const thread = $(`details[data-thread="${esc(id)}"]`);
      if (thread) thread.open = true;
    }
    if (typeof view.scroll === 'number') requestAnimationFrame(() => window.scrollTo(0, view.scroll));
  }

  function reloadPage() {
    saveView();
    window.location.reload();
  }

  // ---- live connection (reconnect backoff and paused overlay) ----

  let ws = null;
  let reconnectDelay = MIN_RECONNECT_MS;
  let reconnectTimer = null;
  let disconnectedSince = null;
  let paused = null;

  function showPaused() {
    if (paused) return;
    paused = el('div', { class: 'pl-paused', role: 'alert' }, el('div', {},
      el('h2', { text: 'Plan page paused' }),
      el('p', { text: 'The plan server has stopped. Ask your coding agent to start it again, and this page will reconnect on its own.' })));
    document.body.append(paused);
  }

  function connect() {
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    ws = new WebSocket('ws' + (location.protocol === 'https:' ? 's' : '') + '://' + location.host + '/ws');

    ws.onopen = () => {
      const recovered = Boolean(paused);
      disconnectedSince = null;
      reconnectDelay = MIN_RECONNECT_MS;
      if (paused) { paused.remove(); paused = null; }
      if (recovered) reloadPage(); // the server came back: the page may be stale
    };

    ws.onmessage = msg => {
      let data;
      try { data = JSON.parse(msg.data); } catch { return; }
      if (data.type !== 'reload') return;
      if (popoverHasText()) { reloadDeferred = true; return; } // keep an unsent note
      reloadPage();
    };

    ws.onclose = () => {
      ws = null;
      if (disconnectedSince === null) disconnectedSince = Date.now();
      if (Date.now() - disconnectedSince >= PAUSED_AFTER_MS) showPaused();
      reconnectTimer = setTimeout(connect, reconnectDelay);
      reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_MS);
    };

    // Let onclose own reconnection so it is not scheduled twice.
    ws.onerror = () => { try { ws.close(); } catch { /* already closed */ } };
  }

  // ---- start ---------------------------------------------------------------------------------

  function start() {
    try { history.scrollRestoration = 'manual'; } catch { /* not supported */ }
    document.addEventListener('click', onClick);
    document.addEventListener('keydown', onKeydown);
    document.addEventListener('mouseover', onHover);
    document.documentElement.addEventListener('mouseleave', clearLit);
    document.addEventListener('focusin', onHover);
    window.addEventListener('hashchange', () => route(location.hash));
    window.addEventListener('pagehide', saveView);
    linkTerms();
    if (!route(location.hash)) restoreView(); // a hash in the address wins over the saved view
    connect();
  }

  start();
  window.__planningClient = CLIENT_MARKER;
})();
