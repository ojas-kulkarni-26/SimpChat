(function () {
  'use strict';

  if (!CONFIG.DB_URL || CONFIG.DB_URL.includes('your-database')) {
    document.body.innerHTML = '<div style="padding:40px;text-align:center;font-family:sans-serif"><h2>Config Required</h2><p>Edit <code>config.js</code> with your Turso DB URL, token, and friend\'s name.</p></div>';
    return;
  }

  const SELF = localStorage.getItem('chat_self_name');
  const FRIEND = CONFIG.FRIEND_NAME;
  let MY_NAME = SELF;
  const POLL_MS = 10000;
  const TYPING_IDLE_MS = 3000;
  const MAX_MESSAGES = 1000;
  const DECAY_BATCH = 100;
  const PAGE_SIZE = 50;
  const ONLINE_WINDOW_MS = 15000;

  let state = {
    messages: [],
    msgMap: new Map(),
    lastKnownId: 0,
    replyTo: null,
    editId: null,
    typingTimer: null,
    lastReadId: parseInt(localStorage.getItem('chat_lastReadId') || '0'),
    hasMore: true,
    loadingMore: false,
    isAtBottom: true,
    unreadCount: 0,
    pollTimer: null,
    tabVisible: true,
    isSending: false,
  };

  const els = {};

  function q(sel) { return document.querySelector(sel); }

  function cacheEls() {
    els.app = q('#app');
    els.nameModal = q('#name-modal');
    els.nameInput = q('#name-input');
    els.nameSubmit = q('#name-submit');
    els.friendName = q('#friend-name');
    els.statusDot = q('#status-dot');
    els.statusText = q('#status-text');
    els.themeToggle = q('#theme-toggle');
    els.msgContainer = q('#messages-container');
    els.msgList = q('#messages-list');
    els.typingIndicator = q('#typing-indicator');
    els.typingText = q('#typing-text');
    els.newMsgToast = q('#new-msg-toast');
    els.replyBar = q('#reply-bar');
    els.replySender = q('#reply-sender');
    els.replyContent = q('#reply-content');
    els.replyClose = q('#reply-close');
    els.input = q('#message-input');
    els.sendBtn = q('#send-btn');
    els.imageBtn = q('#image-btn');
    els.imageUpload = q('#image-upload');
    els.formatToolbar = q('#format-toolbar');
    els.reactionPicker = q('#reaction-picker');
  }

  const API_URL = CONFIG.DB_URL.replace(/\/+$/, '') + '/v2/pipeline';

  function norm(v) {
    if (v === null || v === undefined) return { type: 'null' };
    if (typeof v === 'number') {
      return Number.isInteger(v)
        ? { type: 'integer', value: String(v) }
        : { type: 'float', value: v };
    }
    return { type: 'text', value: String(v) };
  }

  function parseVal(v) {
    if (!v || v.type === 'null') return null;
    if (v.type === 'integer') return parseInt(v.value, 10);
    if (v.type === 'float') return parseFloat(v.value);
    return v.value;
  }

  function parseRes(result) {
    if (!result) return { rows: [], cols: [], last_insert_rowid: null, affected_row_count: 0 };
    const names = (result.cols || []).map(c => c.name);
    return {
      rows: (result.rows || []).map(row =>
        Object.fromEntries(names.map((n, i) => [n, parseVal(row[i])]))
      ),
      cols: names,
      last_insert_rowid: result.last_insert_rowid != null
        ? (typeof result.last_insert_rowid === 'object' ? parseVal(result.last_insert_rowid) : result.last_insert_rowid)
        : null,
      affected_row_count: result.affected_row_count || 0,
    };
  }

  async function db(requests) {
    const resp = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + CONFIG.DB_TOKEN,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ requests }),
    });
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    const data = await resp.json();
    for (const r of data.results) {
      if (r.type === 'error') throw new Error(r.error ? r.error.message : 'SQL error');
    }
    return data;
  }

  async function exec(sql, args) {
    const data = await db([
      { type: 'execute', stmt: { sql, args: args ? args.map(norm) : [] } },
      { type: 'close' },
    ]);
    return parseRes(data.results[0].response.result);
  }

  async function execBatch(stmts) {
    const requests = [
      ...stmts.map(s => ({
        type: 'execute',
        stmt: { sql: s.sql, args: (s.args || []).map(norm) },
      })),
      { type: 'close' },
    ];
    const data = await db(requests);
    return data.results.slice(0, -1).map(r => parseRes(r.response.result));
  }

  async function initSchema() {
    await exec('CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT, sender TEXT NOT NULL, content TEXT NOT NULL DEFAULT "", msg_type TEXT NOT NULL DEFAULT "text", reply_to INTEGER, reactions TEXT NOT NULL DEFAULT "{}", created_at TEXT NOT NULL DEFAULT (datetime("now")), edited_at TEXT, is_deleted INTEGER NOT NULL DEFAULT 0)');
    await exec('CREATE TABLE IF NOT EXISTS presence (name TEXT PRIMARY KEY, is_online INTEGER NOT NULL DEFAULT 0, is_typing INTEGER NOT NULL DEFAULT 0, last_seen TEXT)');
    await exec('CREATE TABLE IF NOT EXISTS read_state (name TEXT PRIMARY KEY, last_read_id INTEGER NOT NULL DEFAULT 0)');
    await exec('CREATE INDEX IF NOT EXISTS idx_messages_id ON messages(id)');
    await exec('CREATE INDEX IF NOT EXISTS idx_messages_sender ON messages(sender)');
  }

  function formatTime(iso) {
    if (!iso) return '';
    const d = new Date(iso + (iso.endsWith('Z') ? '' : 'Z').replace(' ', 'T'));
    if (isNaN(d.getTime())) {
      const parts = iso.split(/[-: ]/);
      if (parts.length >= 5) return parts[3] + ':' + parts[4];
      return '';
    }
    const h = d.getHours(), m = d.getMinutes();
    const ampm = h >= 12 ? 'PM' : 'AM';
    const h12 = h % 12 || 12;
    return h12 + ':' + String(m).padStart(2, '0') + ' ' + ampm;
  }

  function escapeHtml(text) {
    const d = document.createElement('div');
    d.textContent = text;
    return d.innerHTML;
  }

  function renderMarkdown(text) {
    let t = escapeHtml(text);
    t = t.replace(/==([^=]+)==/g, '<mark>$1</mark>');
    t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    t = t.replace(/\*([^*]+)\*/g, '<em>$1</em>');
    t = t.replace(/~~([^~]+)~~/g, '<s>$1</s>');
    t = t.replace(/\n/g, '<br>');
    return t;
  }

  function msgBubbleHTML(msg) {
    if (msg.is_deleted) {
      return '<div class="message-bubble" style="font-style:italic;opacity:0.6">Message deleted</div>';
    }

    let replyHTML = '';
    if (msg.reply_to) {
      const parent = state.msgMap.get(msg.reply_to);
      if (parent) {
        replyHTML = '<div class="reply-preview"><span class="reply-preview-sender">' + escapeHtml(parent.sender) + '</span><span class="reply-preview-content">' + escapeHtml(parent.content.substring(0, 80)) + '</span></div>';
      }
    }

    let contentHTML = '';
    if (msg.msg_type === 'image') {
      contentHTML = '<img src="' + msg.content + '" class="message-image" loading="lazy">';
    } else if (msg.content) {
      contentHTML = renderMarkdown(msg.content);
    }

    let reactionsHTML = '';
    if (msg.reactions) {
      try {
        const r = typeof msg.reactions === 'string' ? JSON.parse(msg.reactions) : msg.reactions;
        const entries = Object.entries(r);
        if (entries.length > 0) {
          reactionsHTML = '<div class="reactions-bar">' + entries.map(([emoji, users]) => '<span class="reaction-badge" data-emoji="' + escapeHtml(emoji) + '">' + emoji + '</span>').join('') + '</div>';
        }
      } catch (e) {}
    }

    const timeStr = formatTime(msg.created_at);
    const isSelf = msg.sender === MY_NAME;
    const edited = msg.edited_at ? ' <span style="font-size:10px;opacity:0.5">edited</span>' : '';

    return '<div class="message-bubble">'
      + replyHTML
      + contentHTML
      + '<span class="message-time">' + timeStr
      + (isSelf ? '<span class="message-status ' + (msg.read ? 'read' : 'sent') + '">' + (msg._optimistic ? '🕐' : (msg.read ? '✓✓' : '✓')) + '</span>' : '')
      + edited
      + '</span>'
      + '</div>'
      + reactionsHTML;
  }

  function createMsgEl(msg) {
    const isSelf = msg.sender === MY_NAME;
    const div = document.createElement('div');
    div.className = 'message ' + (isSelf ? 'self' : 'friend');
    div.dataset.id = msg.id;
    div.dataset.sender = msg.sender;
    div.innerHTML = '<div class="message-actions">'
      + '<button class="action-reply" title="Reply">↩️</button>'
      + '<button class="action-react" title="React">😊</button>'
      + (isSelf ? '<button class="action-edit own-only" title="Edit">✏️</button><button class="action-delete own-only" title="Delete">🗑️</button>' : '')
      + '</div>'
      + msgBubbleHTML(msg);
    div._msg = msg;
    return div;
  }

  function updateMsgEl(el, msg) {
    const newEl = createMsgEl(msg);
    if (el.parentNode) el.parentNode.replaceChild(newEl, el);
    return newEl;
  }

  function renderMessage(msg, prepend) {
    const existing = q('[data-id="' + msg.id + '"]');
    if (existing) return updateMsgEl(existing, msg);
    const el = createMsgEl(msg);
    if (prepend && state.msgList.firstChild) {
      state.msgList.insertBefore(el, state.msgList.firstChild);
    } else {
      state.msgList.appendChild(el);
    }
    return el;
  }

  function batchRender(messages, prepend) {
    const frag = document.createDocumentFragment();
    let count = 0;
    messages.forEach(msg => {
      if (!q('[data-id="' + msg.id + '"]')) {
        frag.appendChild(createMsgEl(msg));
        count++;
      }
    });
    if (count === 0) return;
    if (prepend && state.msgList.firstChild) {
      state.msgList.insertBefore(frag, state.msgList.firstChild);
    } else {
      state.msgList.appendChild(frag);
    }
  }

  function scrollToBottom(smooth) {
    els.msgContainer.scrollTo({
      top: els.msgContainer.scrollHeight,
      behavior: smooth ? 'smooth' : 'auto',
    });
    state.isAtBottom = true;
    hideToast();
  }

  function isNearBottom() {
    const c = els.msgContainer;
    return c.scrollHeight - c.scrollTop - c.clientHeight < 80;
  }

  function showToast() { els.newMsgToast.classList.remove('hidden'); }

  function hideToast() { els.newMsgToast.classList.add('hidden'); }

  function updateUnreadCount() {
    document.title = state.unreadCount > 0 ? '(' + state.unreadCount + ') Chat' : 'Chat';
  }

  function showTyping(name) {
    els.typingText.textContent = name + ' is typing...';
    els.typingIndicator.classList.remove('hidden');
  }

  function hideTyping() { els.typingIndicator.classList.add('hidden'); }

  function updateStatus(online) {
    els.statusDot.className = 'status-dot' + (online ? ' online' : '');
    els.statusText.textContent = online ? 'online' : 'offline';
  }

  async function doCombinedPoll() {
    if (!state.tabVisible) return;
    try {
      const stmts = [
        { sql: 'SELECT * FROM messages WHERE id > ? AND sender = ? ORDER BY id ASC', args: [state.lastKnownId, FRIEND] },
        { sql: 'UPDATE presence SET is_online = 1, last_seen = datetime("now") WHERE name = ?', args: [MY_NAME] },
        { sql: 'SELECT * FROM presence WHERE name = ?', args: [FRIEND] },
        { sql: 'SELECT last_read_id FROM read_state WHERE name = ?', args: [FRIEND] },
      ];
      const results = await execBatch(stmts);
      const newMsgs = results[0];
      const hbResult = results[1];
      const presenceData = results[2];
      const readData = results[3];

      if (!MY_NAME) return;
      if (hbResult.affected_row_count === 0) {
        await exec('INSERT OR REPLACE INTO presence (name, is_online, is_typing, last_seen) VALUES (?, 1, 0, datetime("now"))', [MY_NAME]);
      }

      if (newMsgs.rows.length > 0) {
        for (const row of newMsgs.rows) {
          row.read = false;
          row._optimistic = false;
          state.messages.push(row);
          state.msgMap.set(row.id, row);
          state.lastKnownId = Math.max(state.lastKnownId, row.id);
        }
        batchRender(newMsgs.rows);
        if (state.isAtBottom) {
          scrollToBottom(true);
        } else {
          state.unreadCount += newMsgs.rows.length;
          updateUnreadCount();
          showToast();
        }
      }

      if (presenceData.rows.length > 0) {
        const p = presenceData.rows[0];
        const isOnline = p.is_online == 1;
        let online = false;
        if (isOnline && p.last_seen) {
          const last = new Date(p.last_seen + 'Z');
          online = (Date.now() - last.getTime()) < ONLINE_WINDOW_MS;
        }
        updateStatus(online);
        if (p.is_typing == 1 && online) showTyping(FRIEND);
        else hideTyping();
      } else {
        updateStatus(false);
        hideTyping();
      }

      if (readData.rows.length > 0) {
        const friendLastRead = readData.rows[0].last_read_id || 0;
        let changed = false;
        for (const msg of state.messages) {
          if (msg.sender === MY_NAME && !msg.read && msg.id > 0 && msg.id <= friendLastRead) {
            msg.read = true;
            changed = true;
          }
        }
        if (changed) {
          for (const msg of state.messages) {
            if (msg.sender === MY_NAME && msg.read) {
              const el = q('[data-id="' + msg.id + '"]');
              if (el) {
                const st = el.querySelector('.message-status');
                if (st) { st.className = 'message-status read'; st.textContent = '✓✓'; }
              }
            }
          }
        }
      }
    } catch (e) {
      console.error('Combined poll error:', e);
    }
  }

  async function fetchOlderMessages() {
    if (state.loadingMore || !state.hasMore) return;
    state.loadingMore = true;
    try {
      const oldest = state.messages.length > 0 ? state.messages[0].id : 9999999;
      const result = await exec('SELECT * FROM messages WHERE id < ? ORDER BY id DESC LIMIT ?', [oldest, PAGE_SIZE]);
      const rows = result.rows.reverse();
      if (rows.length < PAGE_SIZE) state.hasMore = false;
      if (rows.length === 0) { state.loadingMore = false; return; }
      for (const row of rows) {
        row.read = false;
        row._optimistic = false;
        state.messages.unshift(row);
        state.msgMap.set(row.id, row);
      }
      const prevScrollHeight = els.msgContainer.scrollHeight;
      const prevScrollTop = els.msgContainer.scrollTop;
      batchRender(rows, true);
      requestAnimationFrame(() => {
        els.msgContainer.scrollTop = els.msgContainer.scrollHeight - prevScrollHeight + prevScrollTop;
        state.loadingMore = false;
      });
    } catch (e) {
      console.error('Load older error:', e);
      state.loadingMore = false;
    }
  }

  async function sendMessage(content, msgType) {
    if (!content && msgType !== 'image') return;
    if (state.isSending) return;
    state.isSending = true;
    const tempId = -Date.now();
    const replyToId = state.replyTo ? state.replyTo.id : null;
    const optimistic = {
      id: tempId, sender: MY_NAME, content: content || '',
      msg_type: msgType || 'text', reply_to: replyToId,
      reactions: '{}',
      created_at: new Date().toISOString().replace('T', ' ').slice(0, 19),
      edited_at: null, is_deleted: 0, _optimistic: true, read: false,
    };
    state.messages.push(optimistic);
    state.msgMap.set(tempId, optimistic);
    renderMessage(optimistic);
    scrollToBottom(true);
    clearReply();
    els.input.value = '';
    els.input.style.height = 'auto';
    els.sendBtn.disabled = true;
    els.sendBtn.style.opacity = '0.4';

    try {
      const result = await exec('INSERT INTO messages (sender, content, msg_type, reply_to, reactions) VALUES (?, ?, ?, ?, ?)', [
        MY_NAME, content || '', msgType || 'text', replyToId, '{}',
      ]);
      const realIdVal = result.last_insert_rowid;
      if (realIdVal) {
        const idx = state.messages.findIndex(m => m.id === tempId);
        if (idx !== -1) {
          state.messages[idx].id = realIdVal;
          state.msgMap.set(realIdVal, state.messages[idx]);
          state.msgMap.delete(tempId);
          state.messages[idx]._optimistic = false;
          const el = q('[data-id="' + tempId + '"]');
          if (el) { el.dataset.id = realIdVal; updateMsgEl(el, state.messages[idx]); }
        }
      }
      await checkDecay();
    } catch (e) {
      console.error('Send error:', e);
      const el = q('[data-id="' + tempId + '"]');
      if (el) {
        const st = el.querySelector('.message-status');
        if (st) { st.textContent = '✗'; st.style.color = 'var(--danger)'; }
      }
    } finally {
      state.isSending = false;
      els.sendBtn.disabled = false;
      els.sendBtn.style.opacity = '1';
    }
  }

  async function checkDecay() {
    try {
      const countResult = await exec('SELECT COUNT(*) as cnt FROM messages');
      const count = countResult.rows[0]?.cnt || 0;
      if (count > MAX_MESSAGES) {
        await exec('DELETE FROM messages WHERE id IN (SELECT id FROM messages ORDER BY id ASC LIMIT ?)', [DECAY_BATCH]);
        const deletedIds = state.messages.slice(0, DECAY_BATCH).map(m => m.id);
        state.messages.splice(0, DECAY_BATCH);
        deletedIds.forEach(id => {
          state.msgMap.delete(id);
          const el = q('[data-id="' + id + '"]');
          if (el) el.remove();
        });
      }
    } catch (e) { console.error('Decay error:', e); }
  }

  async function editMessage(id, newContent) {
    try {
      await exec('UPDATE messages SET content = ?, edited_at = datetime("now") WHERE id = ? AND sender = ?', [newContent, id, MY_NAME]);
      const msg = state.msgMap.get(id);
      if (msg) {
        msg.content = newContent;
        msg.edited_at = new Date().toISOString();
        const el = q('[data-id="' + id + '"]');
        if (el) updateMsgEl(el, msg);
      }
      state.editId = null;
    } catch (e) { console.error('Edit error:', e); }
  }

  async function deleteMessage(id) {
    try {
      await exec('UPDATE messages SET is_deleted = 1 WHERE id = ? AND sender = ?', [id, MY_NAME]);
      const msg = state.msgMap.get(id);
      if (msg) {
        msg.is_deleted = 1;
        const el = q('[data-id="' + id + '"]');
        if (el) updateMsgEl(el, msg);
      }
    } catch (e) { console.error('Delete error:', e); }
  }

  async function toggleReaction(msgId, emoji) {
    try {
      const result = await exec('SELECT reactions FROM messages WHERE id = ?', [msgId]);
      if (!result.rows.length) return;
      let reactions = {};
      try { reactions = JSON.parse(result.rows[0].reactions || '{}'); } catch (e) {}
      const users = reactions[emoji] || [];
      const idx = users.indexOf(MY_NAME);
      if (idx > -1) {
        users.splice(idx, 1);
        if (users.length === 0) delete reactions[emoji];
        else reactions[emoji] = users;
      } else {
        reactions[emoji] = [...users, MY_NAME];
      }
      const newReactions = JSON.stringify(reactions);
      await exec('UPDATE messages SET reactions = ? WHERE id = ?', [newReactions, msgId]);
      const msg = state.msgMap.get(msgId);
      if (msg) {
        msg.reactions = newReactions;
        const el = q('[data-id="' + msgId + '"]');
        if (el) updateMsgEl(el, msg);
      }
    } catch (e) { console.error('Reaction error:', e); }
  }

  async function sendImage(file) {
    if (!file) return;
    const img = await compressImage(file);
    await sendMessage(img, 'image');
  }

  function compressImage(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = (e) => {
        const img = new Image();
        img.onload = () => {
          const canvas = document.createElement('canvas');
          let w = img.width, h = img.height;
          const maxSize = 1200;
          if (w > maxSize || h > maxSize) {
            if (w > h) { h = h * maxSize / w; w = maxSize; }
            else { w = w * maxSize / h; h = maxSize; }
          }
          canvas.width = w;
          canvas.height = h;
          const ctx = canvas.getContext('2d');
          ctx.drawImage(img, 0, 0, w, h);
          resolve(canvas.toDataURL('image/jpeg', 0.75));
        };
        img.onerror = reject;
        img.src = e.target.result;
      };
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }

  async function updateTyping(isTyping) {
    try {
      await exec('UPDATE presence SET is_typing = ?, last_seen = datetime("now") WHERE name = ?', [isTyping ? 1 : 0, MY_NAME]);
    } catch (e) {}
  }

  async function updateMyReadState() {
    if (state.messages.length === 0) return;
    let maxId = 0;
    for (const msg of state.messages) {
      if (msg.id > 0 && msg.sender === FRIEND && msg.id > maxId) maxId = msg.id;
    }
    if (maxId > state.lastReadId) {
      state.lastReadId = maxId;
      localStorage.setItem('chat_lastReadId', String(maxId));
      try {
        await exec('INSERT OR REPLACE INTO read_state (name, last_read_id) VALUES (?, ?)', [MY_NAME, maxId]);
      } catch (e) {}
    }
  }

  let readStateThrottle = null;

  function onScroll() {
    state.isAtBottom = isNearBottom();
    if (state.isAtBottom) {
      hideToast();
      if (state.unreadCount > 0) {
        state.unreadCount = 0;
        updateUnreadCount();
      }
    }
    if (els.msgContainer.scrollTop < 50 && state.hasMore) {
      fetchOlderMessages();
    }
    if (!readStateThrottle) {
      readStateThrottle = setTimeout(() => {
        readStateThrottle = null;
        updateMyReadState();
      }, 500);
    }
  }

  function startPolling() {
    stopPolling();
    doCombinedPoll();
    state.pollTimer = setInterval(doCombinedPoll, POLL_MS);
  }

  function stopPolling() {
    if (state.pollTimer) { clearInterval(state.pollTimer); state.pollTimer = null; }
  }

  function showFormatToolbar() {
    const ta = els.input;
    if (document.activeElement === ta && ta.selectionStart !== ta.selectionEnd) {
      const rect = ta.getBoundingClientRect();
      const tbar = els.formatToolbar;
      const left = Math.max(8, rect.left + rect.width / 2 - tbar.offsetWidth / 2);
      const top = rect.top - tbar.offsetHeight - 8;
      tbar.style.left = left + 'px';
      tbar.style.top = (top > 0 ? top : rect.bottom + 8) + 'px';
      tbar.classList.remove('hidden');
    } else {
      els.formatToolbar.classList.add('hidden');
    }
  }

  function applyFormat(format) {
    const ta = els.input;
    const start = ta.selectionStart;
    const end = ta.selectionEnd;
    if (start === end) { els.formatToolbar.classList.add('hidden'); return; }
    const text = ta.value;
    const selected = text.substring(start, end);
    let wrapped;
    switch (format) {
      case 'bold': wrapped = '**' + selected + '**'; break;
      case 'italic': wrapped = '*' + selected + '*'; break;
      case 'strikethrough': wrapped = '~~' + selected + '~~'; break;
      case 'highlight': wrapped = '==' + selected + '=='; break;
      default: return;
    }
    ta.value = text.substring(0, start) + wrapped + text.substring(end);
    ta.focus();
    ta.selectionStart = start;
    ta.selectionEnd = start + wrapped.length;
    ta.dispatchEvent(new Event('input'));
    els.formatToolbar.classList.add('hidden');
  }

  function setReply(msgId, sender, content) {
    state.replyTo = { id: msgId, sender, content: content.substring(0, 100) };
    els.replySender.textContent = sender;
    els.replyContent.textContent = content.substring(0, 100);
    els.replyBar.classList.remove('hidden');
    els.input.focus();
  }

  function clearReply() {
    state.replyTo = null;
    els.replyBar.classList.add('hidden');
  }

  function startEdit(msgId, content) {
    state.editId = msgId;
    els.input.value = content;
    els.input.focus();
    els.input.setSelectionRange(content.length, content.length);
    els.input.dispatchEvent(new Event('input'));
  }

  function parseArgs() {
    const args = new URLSearchParams(window.location.search);
    const name = args.get('name');
    if (name) {
      MY_NAME = name.trim();
      localStorage.setItem('chat_self_name', MY_NAME);
      window.history.replaceState({}, '', window.location.pathname);
    }
  }

  async function init() {
    cacheEls();
    parseArgs();

    const saved = localStorage.getItem('chat_self_name');
    if (saved) {
      MY_NAME = saved;
      els.nameModal.classList.add('hidden');
      els.app.classList.remove('hidden');
    } else {
      els.nameModal.classList.remove('hidden');
      els.app.classList.add('hidden');
      els.nameInput.focus();
    }

    const theme = localStorage.getItem('chat_theme') || 'dark';
    document.documentElement.dataset.theme = theme;
    els.themeToggle.textContent = theme === 'dark' ? '🌙' : '☀️';

    els.friendName.textContent = FRIEND;

    setupEvents();

    if (saved) {
      await startApp();
    } else {
      els.nameSubmit.addEventListener('click', onNameSubmit);
      els.nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') onNameSubmit(); });
    }
  }

  async function onNameSubmit() {
    const name = els.nameInput.value.trim();
    if (!name) return;
    MY_NAME = name;
    localStorage.setItem('chat_self_name', MY_NAME);
    els.nameModal.classList.add('hidden');
    els.app.classList.remove('hidden');
    await startApp();
  }

  async function startApp() {
    try {
      await initSchema();
    } catch (e) {
      console.error('Schema init error:', e);
      els.msgList.innerHTML = '<div style="padding:20px;text-align:center;color:var(--danger)">Database connection failed. Check your Turso credentials in config.js</div>';
      return;
    }
    try {
      const result = await exec('SELECT * FROM messages ORDER BY id DESC LIMIT ?', [PAGE_SIZE]);
      const rows = result.rows.reverse();
      rows.forEach(row => {
        row.read = false;
        row._optimistic = false;
        state.messages.push(row);
        state.msgMap.set(row.id, row);
        if (row.id > state.lastKnownId && row.sender === FRIEND) state.lastKnownId = row.id;
      });
      batchRender(rows);
      state.hasMore = rows.length >= PAGE_SIZE;
      scrollToBottom(false);

      await exec('INSERT OR REPLACE INTO presence (name, is_online, is_typing, last_seen) VALUES (?, 1, 0, datetime("now"))', [MY_NAME]);
      await updateMyReadState();
    } catch (e) {
      console.error('Load messages error:', e);
    }
    startPolling();
  }

  function setupEvents() {
    els.themeToggle.addEventListener('click', () => {
      const current = document.documentElement.dataset.theme;
      const next = current === 'dark' ? 'light' : 'dark';
      document.documentElement.dataset.theme = next;
      localStorage.setItem('chat_theme', next);
      els.themeToggle.textContent = next === 'dark' ? '🌙' : '☀️';
    });

    els.msgContainer.addEventListener('scroll', onScroll, { passive: true });

    els.newMsgToast.addEventListener('click', () => {
      scrollToBottom(true);
      state.unreadCount = 0;
      updateUnreadCount();
    });

    els.replyClose.addEventListener('click', clearReply);

    els.input.addEventListener('input', () => {
      els.input.style.height = 'auto';
      els.input.style.height = Math.min(els.input.scrollHeight, 120) + 'px';
      clearTimeout(state.typingTimer);
      updateTyping(true);
      state.typingTimer = setTimeout(() => {
        updateTyping(false);
      }, TYPING_IDLE_MS);
    });

    els.input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        const text = els.input.value.trim();
        if (state.editId) {
          if (text) editMessage(state.editId, text);
          else deleteMessage(state.editId);
          state.editId = null;
          els.input.value = '';
          els.input.style.height = 'auto';
        } else if (text) {
          sendMessage(text, 'text');
        }
      }
      if (e.key === 'Escape') {
        clearReply();
        state.editId = null;
      }
    });

    els.input.addEventListener('mouseup', showFormatToolbar);
    els.input.addEventListener('keyup', showFormatToolbar);
    document.addEventListener('click', (e) => {
      if (!els.formatToolbar.contains(e.target)) {
        els.formatToolbar.classList.add('hidden');
      }
      if (!els.reactionPicker.contains(e.target) && !e.target.closest('.action-react')) {
        els.reactionPicker.classList.add('hidden');
      }
    });

    els.sendBtn.addEventListener('click', () => {
      const text = els.input.value.trim();
      if (state.editId) {
        if (text) editMessage(state.editId, text);
        state.editId = null;
        els.input.value = '';
        els.input.style.height = 'auto';
      } else if (text) {
        sendMessage(text, 'text');
      }
    });

    els.imageBtn.addEventListener('click', () => els.imageUpload.click());
    els.imageUpload.addEventListener('change', (e) => {
      if (e.target.files[0]) sendImage(e.target.files[0]);
      e.target.value = '';
    });

    document.addEventListener('paste', (e) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      for (const item of items) {
        if (item.type.startsWith('image/')) {
          e.preventDefault();
          sendImage(item.getAsFile());
          return;
        }
      }
    });

    els.msgContainer.addEventListener('dragenter', (e) => e.preventDefault());
    els.msgContainer.addEventListener('dragover', (e) => e.preventDefault());
    els.msgContainer.addEventListener('drop', (e) => {
      e.preventDefault();
      const file = e.dataTransfer?.files?.[0];
      if (file && file.type.startsWith('image/')) sendImage(file);
    });

    els.formatToolbar.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-format]');
      if (btn) applyFormat(btn.dataset.format);
    });

    els.msgList.addEventListener('click', (e) => {
      const badge = e.target.closest('.reaction-badge');
      if (badge) {
        const msgEl = badge.closest('.message');
        const msgId = parseInt(msgEl.dataset.id);
        if (msgId) toggleReaction(msgId, badge.dataset.emoji);
        return;
      }

      const img = e.target.closest('.message-image');
      if (img) { window.open(img.src); return; }

      const btn = e.target.closest('button');
      if (!btn) { els.reactionPicker.classList.add('hidden'); return; }
      const msgEl = e.target.closest('.message');
      if (!msgEl) return;
      const msgId = parseInt(msgEl.dataset.id);
      const msg = state.msgMap.get(msgId);
      if (!msg) return;

      if (btn.classList.contains('action-reply')) {
        setReply(msgId, msg.sender, msg.is_deleted ? '[deleted]' : msg.content);
      }
      if (btn.classList.contains('action-react')) {
        const rect = btn.getBoundingClientRect();
        els.reactionPicker.style.left = Math.max(4, rect.left + rect.width / 2 - 120) + 'px';
        els.reactionPicker.style.top = (rect.top - 52) + 'px';
        els.reactionPicker.dataset.msgId = msgId;
        els.reactionPicker.classList.remove('hidden');
      }
      if (btn.classList.contains('action-edit')) {
        if (msg.is_deleted) return;
        startEdit(msgId, msg.content);
      }
      if (btn.classList.contains('action-delete')) {
        if (confirm('Delete this message?')) deleteMessage(msgId);
      }
    });

    els.reactionPicker.addEventListener('click', (e) => {
      const btn = e.target.closest('button');
      if (!btn) return;
      const msgId = parseInt(els.reactionPicker.dataset.msgId);
      if (msgId) toggleReaction(msgId, btn.textContent);
      els.reactionPicker.classList.add('hidden');
    });

    document.addEventListener('visibilitychange', () => {
      state.tabVisible = !document.hidden;
      if (state.tabVisible) {
        startPolling();
        doCombinedPoll();
      } else {
        stopPolling();
      }
    });
  }

  document.addEventListener('DOMContentLoaded', init);
})();
