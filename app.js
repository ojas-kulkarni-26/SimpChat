(function () {
  'use strict';

  if (!CONFIG.SUPABASE_URL || !CONFIG.SUPABASE_ANON_KEY) {
    document.body.innerHTML = '<div style="padding:40px;text-align:center;font-family:sans-serif"><h2>Config Required</h2><p>Edit <code>config.js</code> with your Supabase URL and anon key.</p></div>';
    return;
  }

  const SELF = localStorage.getItem('chat_self_name');
  const FRIEND = CONFIG.FRIEND_NAME;
  let MY_NAME = SELF;
  const TYPING_IDLE_MS = 3000;
  const MAX_MESSAGES = 1000;
  const DECAY_BATCH = 100;
  const PAGE_SIZE = 50;

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
    isSending: false,
    ready: false,
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

  const supabase = window.supabase.createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY);
  let presenceChannel = null;

  function formatTime(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '';
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
    if (prepend && els.msgList.firstChild) {
      els.msgList.insertBefore(el, els.msgList.firstChild);
    } else {
      els.msgList.appendChild(el);
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
    if (prepend && els.msgList.firstChild) {
      els.msgList.insertBefore(frag, els.msgList.firstChild);
    } else {
      els.msgList.appendChild(frag);
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

  async function signInAnonymously() {
    const { data: { session } } = await supabase.auth.signInAnonymously();
    return session;
  }

  function setupRealtime() {
    presenceChannel = supabase.channel('chat');

    presenceChannel
      .on('presence', { event: 'sync' }, () => {
        const presences = presenceChannel.presenceState();
        let friendOnline = false;
        let friendTyping = false;
        for (const key of Object.keys(presences)) {
          for (const p of presences[key]) {
            if (p.name === FRIEND) {
              friendOnline = true;
              if (p.is_typing) friendTyping = true;
            }
          }
        }
        updateStatus(friendOnline);
        if (friendTyping && friendOnline) showTyping(FRIEND);
        else hideTyping();
      })
      .subscribe(async (status) => {
        if (status === 'SUBSCRIBED') {
          await presenceChannel.track({
            name: MY_NAME,
            is_typing: false,
            online: true,
          });
        }
      });

    supabase
      .channel('messages-insert')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages' }, (payload) => {
        const msg = payload.new;
        if (msg.sender === FRIEND && msg.id > state.lastKnownId) {
          msg.reactions = typeof msg.reactions === 'string' ? msg.reactions : JSON.stringify(msg.reactions);
          state.messages.push(msg);
          state.msgMap.set(msg.id, msg);
          state.lastKnownId = Math.max(state.lastKnownId, msg.id);
          renderMessage(msg);
          if (state.isAtBottom) {
            scrollToBottom(true);
          } else {
            state.unreadCount++;
            updateUnreadCount();
            showToast();
          }
        }
      })
      .subscribe();

    supabase
      .channel('read-state-updates')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'read_state', filter: 'name=eq.' + FRIEND }, (payload) => {
        const friendLastRead = payload.new.last_read_id || 0;
        updateReadStatus(friendLastRead);
      })
      .subscribe();
  }

  function updateReadStatus(friendLastRead) {
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

  async function loadInitialMessages() {
    const { data, error } = await supabase
      .from('messages')
      .select('*')
      .order('id', { ascending: false })
      .limit(PAGE_SIZE);
    if (error) throw error;
    const rows = (data || []).reverse();
    rows.forEach(row => {
      row.read = false;
      row._optimistic = false;
      row.reactions = typeof row.reactions === 'string' ? row.reactions : JSON.stringify(row.reactions);
      state.messages.push(row);
      state.msgMap.set(row.id, row);
      if (row.id > state.lastKnownId && row.sender === FRIEND) state.lastKnownId = row.id;
    });
    batchRender(rows);
    state.hasMore = rows.length >= PAGE_SIZE;
    scrollToBottom(false);

    const { data: rd } = await supabase
      .from('read_state')
      .select('last_read_id')
      .eq('name', FRIEND)
      .maybeSingle();
    if (rd) updateReadStatus(rd.last_read_id);
  }

  async function fetchOlderMessages() {
    if (state.loadingMore || !state.hasMore) return;
    state.loadingMore = true;
    try {
      const oldest = state.messages.length > 0 ? state.messages[0].id : 9999999;
      const { data, error } = await supabase
        .from('messages')
        .select('*')
        .lt('id', oldest)
        .order('id', { ascending: false })
        .limit(PAGE_SIZE);
      if (error) throw error;
      const rows = (data || []).reverse();
      if (rows.length < PAGE_SIZE) state.hasMore = false;
      if (rows.length === 0) { state.loadingMore = false; return; }
      for (const row of rows) {
        row.read = false;
        row._optimistic = false;
        row.reactions = typeof row.reactions === 'string' ? row.reactions : JSON.stringify(row.reactions);
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
      created_at: new Date().toISOString(),
      edited_at: null, is_deleted: false, _optimistic: true, read: false,
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
      const { data, error } = await supabase
        .from('messages')
        .insert({
          sender: MY_NAME,
          content: content || '',
          msg_type: msgType || 'text',
          reply_to: replyToId && replyToId > 0 ? replyToId : null,
          reactions: {},
        })
        .select();
      if (error) throw error;
      const realId = data[0].id;
      const idx = state.messages.findIndex(m => m.id === tempId);
      if (idx !== -1) {
        state.messages[idx].id = realId;
        state.msgMap.set(realId, state.messages[idx]);
        state.msgMap.delete(tempId);
        state.messages[idx]._optimistic = false;
        const el = q('[data-id="' + tempId + '"]');
        if (el) { el.dataset.id = realId; updateMsgEl(el, state.messages[idx]); }
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
      const { count, error } = await supabase
        .from('messages')
        .select('*', { count: 'exact', head: true });
      if (error) throw error;
      if (count > MAX_MESSAGES) {
        const { data: oldest } = await supabase
          .from('messages')
          .select('id')
          .order('id', { ascending: true })
          .limit(DECAY_BATCH);
        if (oldest && oldest.length > 0) {
          await supabase.from('messages').delete().in('id', oldest.map(r => r.id));
        }
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
      const { error } = await supabase
        .from('messages')
        .update({ content: newContent, edited_at: new Date().toISOString() })
        .eq('id', id)
        .eq('sender', MY_NAME);
      if (error) throw error;
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
      const { error } = await supabase
        .from('messages')
        .update({ is_deleted: true })
        .eq('id', id)
        .eq('sender', MY_NAME);
      if (error) throw error;
      const msg = state.msgMap.get(id);
      if (msg) {
        msg.is_deleted = true;
        const el = q('[data-id="' + id + '"]');
        if (el) updateMsgEl(el, msg);
      }
    } catch (e) { console.error('Delete error:', e); }
  }

  async function toggleReaction(msgId, emoji) {
    try {
      const { data, error } = await supabase
        .from('messages')
        .select('reactions')
        .eq('id', msgId)
        .maybeSingle();
      if (error || !data) return;
      let reactions = data.reactions || {};
      const users = reactions[emoji] || [];
      const idx = users.indexOf(MY_NAME);
      if (idx > -1) {
        users.splice(idx, 1);
        if (users.length === 0) delete reactions[emoji];
        else reactions[emoji] = users;
      } else {
        reactions[emoji] = [...users, MY_NAME];
      }
      await supabase.from('messages').update({ reactions }).eq('id', msgId);
      const msg = state.msgMap.get(msgId);
      if (msg) {
        msg.reactions = JSON.stringify(reactions);
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
        await supabase
          .from('read_state')
          .upsert({ name: MY_NAME, last_read_id: maxId }, { onConflict: 'name' });
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
      await signInAnonymously();
    } catch (e) {
      console.error('Auth error:', e);
    }
    try {
      setupRealtime();
      await loadInitialMessages();
    } catch (e) {
      console.error('Load messages error:', e);
      els.msgList.innerHTML = '<div style="padding:20px;text-align:center;color:var(--danger)">Database connection failed. Check your Supabase credentials in config.js</div>';
      return;
    }
    state.ready = true;
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
      if (presenceChannel) {
        presenceChannel.track({ name: MY_NAME, is_typing: true, online: true });
      }
      state.typingTimer = setTimeout(() => {
        if (presenceChannel) {
          presenceChannel.track({ name: MY_NAME, is_typing: false, online: true });
        }
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
      if (document.hidden && presenceChannel) {
        presenceChannel.track({ name: MY_NAME, is_typing: false, online: false });
      } else if (!document.hidden && presenceChannel) {
        presenceChannel.track({ name: MY_NAME, is_typing: false, online: true });
      }
    });
  }

  document.addEventListener('DOMContentLoaded', init);
})();
