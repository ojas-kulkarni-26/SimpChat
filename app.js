(function () {
  'use strict';

  if (!CONFIG.SUPABASE_URL || !CONFIG.SUPABASE_ANON_KEY) {
    document.body.innerHTML = '<div style="padding:40px;text-align:center;font-family:sans-serif"><h2>Config Required</h2><p>Edit <code>config.js</code> with your Supabase URL and anon key.</p></div>';
    return;
  }

  const PARTICIPANTS = ['Arnav', 'Ojas', 'Shaurya'];
  let MY_NAME = null;
  const TYPING_IDLE_MS = 3000;
  const MAX_MESSAGES = 1000;
  const DECAY_BATCH = 100;
  const PAGE_SIZE = 50;

  let tempIdCounter = 0;
  let reactingIds = new Set();
  let readStateThrottle = null;

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
    isTyping: false,
    ready: false,
    pollTimer: null,
    notificationsEnabled: localStorage.getItem('chat_notifications') !== 'false',
    mood: localStorage.getItem('chat_mood') || '',
  };

  const els = {};

  function q(sel) { return document.querySelector(sel); }

  function cacheEls() {
    els.app = q('#app');
    els.nameModal = q('#name-modal');
    els.btnArnav = q('#btn-arnav');
    els.btnOjas = q('#btn-ojas');
    els.btnShaurya = q('#btn-shaurya');
    els.passwordGroup = q('#password-group');
    els.passwordInput = q('#password-input');
    els.passwordSubmit = q('#password-submit');
    els.passwordError = q('#password-error');
    els.friendName = q('#friend-name');
    els.participantStatuses = q('#participant-statuses');
    els.themeToggle = q('#theme-toggle');
    els.moodBtn = q('#mood-btn');
    els.moodPicker = q('#mood-picker');
    els.notifToggle = q('#notif-toggle');
    els.clearChatBtn = q('#clear-chat-btn');
    els.msgContainer = q('#messages-container');
    els.msgList = q('#messages-list');
    els.typingIndicator = q('#typing-indicator');
    els.typingText = q('#typing-text');
    els.newMsgToast = q('#new-msg-toast');
    els.scrollBottomBtn = q('#scroll-bottom-btn');
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

  function formatTime(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    const h = d.getHours(), m = d.getMinutes();
    const ampm = h >= 12 ? 'PM' : 'AM';
    const h12 = h % 12 || 12;
    return h12 + ':' + String(m).padStart(2, '0') + ' ' + ampm;
  }

  function formatDate(iso) {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    const today = new Date();
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);
    if (d.toDateString() === today.toDateString()) return 'Today';
    if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: d.getFullYear() !== today.getFullYear() ? 'numeric' : undefined });
  }

  function isSameDay(a, b) {
    if (!a || !b) return false;
    return new Date(a).toDateString() === new Date(b).toDateString();
  }

  function createDateSeparator(iso) {
    const div = document.createElement('div');
    div.className = 'date-separator';
    div.innerHTML = '<span>' + formatDate(iso) + '</span>';
    return div;
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
    const isSelf = msg.sender === MY_NAME;
    let contentHTML = '';
    if (msg.msg_type === 'image') {
      contentHTML = (isSelf ? '' : '<div class="message-sender">' + escapeHtml(msg.sender) + '</div>') + '<img src="' + msg.content + '" class="message-image" loading="lazy" alt="Image shared by ' + escapeHtml(msg.sender) + '">';
    } else if (msg.content) {
      contentHTML = (isSelf ? '' : '<div class="message-sender">' + escapeHtml(msg.sender) + '</div>') + renderMarkdown(msg.content);
    }
    let reactionsHTML = '';
    if (msg.reactions) {
      try {
        const r = typeof msg.reactions === 'string' ? JSON.parse(msg.reactions) : msg.reactions;
        const entries = Object.entries(r);
        if (entries.length > 0) {
          reactionsHTML = '<div class="reactions-bar">' + entries.map(([emoji, users]) => {
            const count = users.length;
            const names = users.join(', ');
            return '<span class="reaction-badge" data-emoji="' + escapeHtml(emoji) + '" role="button" tabindex="0" aria-label="' + escapeHtml(emoji) + ' by ' + escapeHtml(names) + '">' + emoji + (count > 1 ? '<span class="reaction-count">' + count + '</span>' : '') + '</span>';
          }).join('') + '</div>';
        }
      } catch (e) {}
    }
    const timeStr = formatTime(msg.created_at);
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
    div.innerHTML = '<div class="message-actions" role="toolbar" aria-label="Message actions">'
      + '<button class="action-reply" title="Reply" aria-label="Reply to message">↩️</button>'
      + '<button class="action-react" title="React" aria-label="React to message">😊</button>'
      + (isSelf ? '<button class="action-edit own-only" title="Edit" aria-label="Edit message">✏️</button><button class="action-delete own-only" title="Delete" aria-label="Delete message">🗑️</button>' : '')
      + '</div>'
      + msgBubbleHTML(msg);
    div._msg = msg;
    const bubble = div.querySelector('.message-bubble');
    if (bubble) {
      bubble.addEventListener('click', function (e) {
        if (window.innerWidth <= 480) {
          const actions = div.querySelector('.message-actions');
          if (actions) { actions.classList.toggle('show'); }
        }
      });
    }
    return div;
  }

  function updateMsgEl(el, msg) {
    const newEl = createMsgEl(msg);
    if (el.parentNode) el.parentNode.replaceChild(newEl, el);
    return newEl;
  }

  function maybeInsertDateSep(prevMsg, nextMsg, parent, beforeEl) {
    if (prevMsg && nextMsg && !isSameDay(prevMsg.created_at, nextMsg.created_at)) {
      const sep = createDateSeparator(nextMsg.created_at);
      parent.insertBefore(sep, beforeEl);
    }
  }

  function renderMessage(msg, prepend) {
    const existing = q('[data-id="' + msg.id + '"]');
    if (existing) return updateMsgEl(existing, msg);
    const el = createMsgEl(msg);
    if (prepend && els.msgList.firstChild) {
      let firstMsgEl = els.msgList.firstChild;
      while (firstMsgEl && firstMsgEl.classList && firstMsgEl.classList.contains('date-separator')) {
        firstMsgEl = firstMsgEl.nextElementSibling;
      }
      const firstMsg = firstMsgEl && firstMsgEl._msg;
      maybeInsertDateSep(msg, firstMsg, els.msgList, firstMsgEl);
      els.msgList.insertBefore(el, els.msgList.firstChild);
    } else {
      let lastMsgEl = els.msgList.lastChild;
      while (lastMsgEl && lastMsgEl.classList && lastMsgEl.classList.contains('date-separator')) {
        lastMsgEl = lastMsgEl.previousElementSibling;
      }
      const lastMsg = lastMsgEl && lastMsgEl._msg ? lastMsgEl._msg : null;
      maybeInsertDateSep(lastMsg, msg, els.msgList, null);
      els.msgList.appendChild(el);
    }
    return el;
  }

  function batchRender(messages, prepend) {
    const frag = document.createDocumentFragment();
    let prevMsg = null;
    messages.forEach(msg => {
      if (!q('[data-id="' + msg.id + '"]')) {
        if (prevMsg && !isSameDay(prevMsg.created_at, msg.created_at)) {
          frag.appendChild(createDateSeparator(msg.created_at));
        }
        frag.appendChild(createMsgEl(msg));
        prevMsg = msg;
      }
    });
    if (frag.childNodes.length === 0) return;
    if (prepend && els.msgList.firstChild) {
      let firstMsgEl = els.msgList.firstChild;
      while (firstMsgEl && firstMsgEl.classList && firstMsgEl.classList.contains('date-separator')) {
        firstMsgEl = firstMsgEl.nextElementSibling;
      }
      const firstMsg = firstMsgEl && firstMsgEl._msg;
      if (firstMsg && prevMsg && !isSameDay(prevMsg.created_at, firstMsg.created_at)) {
        els.msgList.insertBefore(createDateSeparator(firstMsg.created_at), firstMsgEl);
      }
      els.msgList.insertBefore(frag, els.msgList.firstChild);
    } else {
      const lastChild = els.msgList.lastChild;
      const lastMsg = (lastChild && lastChild._msg) || null;
      if (lastMsg && messages.length > 0 && !isSameDay(lastMsg.created_at, messages[0].created_at)) {
        els.msgList.appendChild(createDateSeparator(messages[0].created_at));
      }
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
    updateScrollBtn();
  }

  function isNearBottom() {
    const c = els.msgContainer;
    return c.scrollHeight - c.scrollTop - c.clientHeight < 100;
  }

  function updateScrollBtn() {
    if (!els.scrollBottomBtn) return;
    els.scrollBottomBtn.classList.toggle('show', !isNearBottom());
  }

  function showToast() { els.newMsgToast.classList.remove('hidden'); }

  function hideToast() { els.newMsgToast.classList.add('hidden'); }

  function updateUnreadCount() {
    document.title = state.unreadCount > 0 ? '(' + state.unreadCount + ') SimpChat' : 'SimpChat';
  }

  function showTyping(name) {
    els.typingText.textContent = name + ' is typing...';
    els.typingIndicator.classList.remove('hidden');
  }

  function hideTyping() { els.typingIndicator.classList.add('hidden'); }

  function updateStatus(onlineNames) {
    els.participantStatuses.querySelectorAll('.participant-status').forEach(el => {
      const name = el.dataset.name;
      const dot = el.querySelector('.status-dot');
      dot.className = 'status-dot' + (onlineNames.includes(name) ? ' online' : '');
    });
  }

  function updateParticipantMood(name, mood) {
    const el = els.participantStatuses.querySelector('.participant-status[data-name="' + name + '"]');
    if (!el) return;
    let moodSpan = el.querySelector('.mood-text');
    if (mood) {
      if (!moodSpan) {
        moodSpan = document.createElement('span');
        moodSpan.className = 'mood-text';
        el.appendChild(moodSpan);
      }
      moodSpan.textContent = ' · ' + mood;
    } else if (moodSpan) {
      moodSpan.remove();
    }
  }

  function showBrowserNotification(msg) {
    if (!document.hidden) return;
    if (!('Notification' in window) || Notification.permission !== 'granted') return;
    const body = msg.msg_type === 'image' ? '📷 Image' : (msg.content || '');
    try {
      new Notification(msg.sender, {
        body: body.substring(0, 200),
        icon: 'icon.svg',
        tag: 'simpchat-message-' + msg.sender,
      });
    } catch (e) {}
  }

  async function updateMyPresence(online, isTyping) {
    try {
      await supabase
        .from('presence')
        .upsert({
          name: MY_NAME,
          is_online: online,
          is_typing: isTyping || false,
          mood: state.mood || '',
          last_seen: new Date().toISOString(),
        }, { onConflict: 'name' });
    } catch (e) {}
  }

  async function loadInitialPresence() {
    try {
      const { data } = await supabase
        .from('presence')
        .select('name, is_online, is_typing, mood')
        .in('name', PARTICIPANTS.filter(p => p !== MY_NAME));
      if (data) {
        const onlineNames = data.filter(r => r.is_online).map(r => r.name);
        updateStatus(onlineNames);
        data.filter(r => r.is_typing).forEach(r => typingUsers.add(r.name));
        if (typingUsers.size > 0) showTyping([...typingUsers][0]);
        data.forEach(r => updateParticipantMood(r.name, r.mood || ''));
      }
    } catch (e) {}
    await updateMyPresence(true, false);
  }

  const typingUsers = new Set();

  function setupRealtime() {
    supabase
      .channel('presence-changes')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'presence' }, (payload) => {
        const r = payload.new;
        if (r.name === MY_NAME) return;
        const el = els.participantStatuses.querySelector('.participant-status[data-name="' + r.name + '"]');
        if (el) {
          const dot = el.querySelector('.status-dot');
          dot.className = 'status-dot' + (r.is_online ? ' online' : '');
        }
        if (r.is_typing) typingUsers.add(r.name);
        else typingUsers.delete(r.name);
        if (typingUsers.size > 0) showTyping([...typingUsers][0]);
        else hideTyping();
        updateParticipantMood(r.name, r.mood || '');
      })
      .subscribe();

    supabase
      .channel('messages-insert')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages' }, (payload) => {
        const msg = payload.new;
        if (msg.sender !== MY_NAME && msg.id > state.lastKnownId) {
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
          showBrowserNotification(msg);
        }
      })
      .subscribe();

    supabase
      .channel('read-state-updates')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'read_state' }, (payload) => {
        const { name: friendName, last_read_id } = payload.new;
        if (friendName && friendName !== MY_NAME) {
          updateReadStatus(friendName, last_read_id || 0);
        }
      })
      .subscribe();

    supabase
      .channel('messages-changes')
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'messages' }, (payload) => {
        const msg = payload.new;
        const existing = state.msgMap.get(msg.id);
        if (existing) {
          existing.content = msg.content;
          existing.edited_at = msg.edited_at;
          existing.is_deleted = msg.is_deleted;
          existing.reactions = typeof msg.reactions === 'string' ? msg.reactions : JSON.stringify(msg.reactions);
          const el = q('[data-id="' + msg.id + '"]');
          if (el) updateMsgEl(el, existing);
        }
      })
      .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'messages' }, (payload) => {
        const oldId = payload.old.id;
        const idx = state.messages.findIndex(m => m.id === oldId);
        if (idx !== -1) {
          state.messages.splice(idx, 1);
          state.msgMap.delete(oldId);
          const el = q('[data-id="' + oldId + '"]');
          if (el) el.remove();
        }
      })
      .subscribe();
  }

  let lastProcessedFriendReads = {};
  let friendReadStates = {};

  function updateReadStatus(friendName, friendLastRead) {
    const lastProcessed = lastProcessedFriendReads[friendName] || 0;
    if (friendLastRead <= lastProcessed) return;
    lastProcessedFriendReads[friendName] = friendLastRead;
    friendReadStates[friendName] = friendLastRead;
    const otherUsers = PARTICIPANTS.filter(p => p !== MY_NAME);
    for (const msg of state.messages) {
      if (msg.sender !== MY_NAME) continue;
      const allRead = otherUsers.every(u => (friendReadStates[u] || 0) >= msg.id);
      if (allRead !== msg.read) {
        msg.read = allRead;
        const el = q('[data-id="' + msg.id + '"]');
        if (el) {
          const st = el.querySelector('.message-status');
          if (st) {
            st.className = 'message-status ' + (allRead ? 'read' : 'sent');
            st.textContent = allRead ? '✓✓' : '✓';
          }
        }
      }
    }
  }

  async function pollNewMessages() {
    if (!MY_NAME) return;
    try {
      const { data, error } = await supabase
        .from('messages')
        .select('*')
        .gt('id', state.lastKnownId)
        .neq('sender', MY_NAME)
        .order('id', { ascending: true });
      if (error) throw error;
      if (data && data.length > 0) {
        for (const row of data) {
          row.read = false;
          row._optimistic = false;
          row.reactions = typeof row.reactions === 'string' ? row.reactions : JSON.stringify(row.reactions);
          state.messages.push(row);
          state.msgMap.set(row.id, row);
          state.lastKnownId = Math.max(state.lastKnownId, row.id);
          renderMessage(row);
          if (state.isAtBottom) scrollToBottom(true);
          else { state.unreadCount++; updateUnreadCount(); showToast(); }
          showBrowserNotification(row);
        }
      }
    } catch (e) { console.error('Poll error:', e); }
  }

  function startFallbackPoll() {
    stopFallbackPoll();
    state.pollTimer = setInterval(pollNewMessages, 15000);
  }

  function stopFallbackPoll() {
    if (state.pollTimer) { clearInterval(state.pollTimer); state.pollTimer = null; }
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
      if (row.id > state.lastKnownId && row.sender !== MY_NAME) state.lastKnownId = row.id;
    });
    batchRender(rows);
    state.hasMore = rows.length >= PAGE_SIZE;
    scrollToBottom(false);

    lastProcessedFriendReads = {};
    const otherUsers = PARTICIPANTS.filter(p => p !== MY_NAME);
    const { data: allRd } = await supabase
      .from('read_state')
      .select('*')
      .in('name', otherUsers);
    if (allRd) {
      for (const rd of allRd) {
        updateReadStatus(rd.name, rd.last_read_id);
      }
    }
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
    if (msgType === 'text' && wordCount(content) > 3000) {
      showNotification('Message exceeds 3000 word limit');
      return;
    }
    state.isSending = true;
    const tempId = --tempIdCounter;
    const replyToId = state.replyTo ? state.replyTo.id : null;
    const optimistic = {
      id: tempId, sender: MY_NAME, content: content || '',
      msg_type: msgType || 'text', reply_to: replyToId,
      reactions: '{}',
      created_at: new Date().toISOString(),
      edited_at: null, is_deleted: false, _optimistic: true, read: false,
    };
    try {
      state.messages.push(optimistic);
      state.msgMap.set(tempId, optimistic);
      renderMessage(optimistic);
      scrollToBottom(true);
      clearReply();
      els.input.value = '';
      els.input.style.height = 'auto';
      els.sendBtn.disabled = true;
      els.sendBtn.classList.add('sending');

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
      els.sendBtn.classList.remove('sending');
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

  async function clearAllMessages() {
    if (MY_NAME !== 'Ojas') return;
    if (!confirm('Delete ALL messages from the database? This cannot be undone.')) return;
    try {
      const { error } = await supabase.from('messages').delete().gt('id', 0);
      if (error) throw error;
      state.messages = [];
      state.msgMap = new Map();
      state.lastKnownId = 0;
      els.msgList.innerHTML = '';
      showNotification('Chat cleared');
    } catch (e) {
      console.error('Clear error:', e);
      showNotification('Failed to clear chat');
    }
  }

  async function editMessage(id, newContent) {
    try {
      const { data, error } = await supabase
        .from('messages')
        .update({ content: newContent, edited_at: new Date().toISOString() })
        .eq('id', id)
        .eq('sender', MY_NAME)
        .select();
      if (error) throw error;
      if (!data || data.length === 0) throw new Error('No rows updated');
      state.editId = null;
      els.input.value = '';
      els.input.style.height = 'auto';
      const msg = state.msgMap.get(id);
      if (msg) {
        msg.content = newContent;
        msg.edited_at = data[0].edited_at;
        const el = q('[data-id="' + id + '"]');
        if (el) updateMsgEl(el, msg);
      }
    } catch (e) { console.error('Edit error:', e); }
  }

  async function deleteMessage(id) {
    try {
      const { data, error } = await supabase
        .from('messages')
        .update({ is_deleted: true })
        .eq('id', id)
        .eq('sender', MY_NAME)
        .select();
      if (error) throw error;
      if (!data || data.length === 0) throw new Error('No rows updated');
      if (state.replyTo && state.replyTo.id === id) clearReply();
      if (state.editId === id) { state.editId = null; els.input.value = ''; els.input.style.height = 'auto'; }
      const msg = state.msgMap.get(id);
      if (msg) {
        msg.is_deleted = true;
        const el = q('[data-id="' + id + '"]');
        if (el) updateMsgEl(el, msg);
      }
    } catch (e) { console.error('Delete error:', e); }
  }

  function showNotification(msg) {
    const old = q('#app-notification');
    if (old) old.remove();
    const div = document.createElement('div');
    div.id = 'app-notification';
    div.textContent = msg;
    document.body.appendChild(div);
    setTimeout(() => div.classList.add('show'), 10);
    setTimeout(() => { div.classList.remove('show'); setTimeout(() => div.remove(), 300); }, 3000);
  }

  function wordCount(text) {
    if (!text.trim()) return 0;
    return text.trim().split(/\s+/).length;
  }

  async function toggleReaction(msgId, emoji) {
    if (reactingIds.has(msgId)) return;
    reactingIds.add(msgId);
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
    finally { reactingIds.delete(msgId); }
  }

  async function sendImage(file) {
    if (!file) return;
    els.imageBtn.classList.add('uploading');
    els.imageBtn.disabled = true;
    try {
      const img = await compressImage(file);
      await sendMessage(img, 'image');
    } finally {
      els.imageBtn.classList.remove('uploading');
      els.imageBtn.disabled = false;
    }
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

  function urlBase64ToUint8Array(base64String) {
    const padding = '='.repeat((4 - base64String.length % 4) % 4);
    const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
    const rawData = window.atob(base64);
    return Uint8Array.from([].map.call(rawData, function (ch) { return ch.charCodeAt(0); }));
  }

  async function setupPushNotifications(preGranted) {
    console.log('Push: setup starting state:', { serviceWorker: 'serviceWorker' in navigator, PushManager: 'PushManager' in window, Notification: 'Notification' in window, vapid: CONFIG.VAPID_PUBLIC_KEY && CONFIG.VAPID_PUBLIC_KEY !== 'REPLACE_ME', enabled: state.notificationsEnabled, permission: Notification.permission, preGranted: preGranted });
    if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) return;
    if (!CONFIG.VAPID_PUBLIC_KEY || CONFIG.VAPID_PUBLIC_KEY === 'REPLACE_ME') {
      console.warn('Push: VAPID_PUBLIC_KEY not set in config.js');
      return;
    }
    if (!state.notificationsEnabled) return;
    if (preGranted !== 'granted' && Notification.permission !== 'granted') {
      console.warn('Push: notification permission ' + (Notification.permission) + '. Allow in browser site settings (lock icon), then reload.');
      return;
    }
    try {
      const swUrl = 'sw.js?url=' + encodeURIComponent(CONFIG.SUPABASE_URL) + '&key=' + encodeURIComponent(CONFIG.SUPABASE_ANON_KEY);
      const registration = await navigator.serviceWorker.register(swUrl);
      await navigator.serviceWorker.ready;
      let subscription = await registration.pushManager.getSubscription();
      if (!subscription) {
        subscription = await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(CONFIG.VAPID_PUBLIC_KEY),
        });
      }
      const { error } = await supabase
        .from('push_subscriptions')
        .upsert(
          { name: MY_NAME, subscription: subscription.toJSON(), updated_at: new Date().toISOString() },
          { onConflict: 'name' }
        );
      if (error) console.error('Push: DB upsert error:', error);
      else console.log('Push: subscription stored for', MY_NAME);
    } catch (e) {
      console.error('Push setup error:', e);
    }
  }

  async function disablePushNotifications() {
    try {
      const registration = await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.getSubscription();
      if (subscription) {
        await subscription.unsubscribe();
      }
      await supabase.from('push_subscriptions').delete().eq('name', MY_NAME);
    } catch (e) {
      console.error('Disable push error:', e);
    }
  }

  async function toggleNotifications() {
    state.notificationsEnabled = !state.notificationsEnabled;
    localStorage.setItem('chat_notifications', String(state.notificationsEnabled));
    updateNotifToggleUI();
    if (state.notificationsEnabled) {
      let perm = Notification.permission;
      if (perm === 'default') {
        perm = await Notification.requestPermission();
      }
      await setupPushNotifications(perm);
    } else {
      await disablePushNotifications();
    }
  }

  function updateNotifToggleUI() {
    if (!els.notifToggle) return;
    els.notifToggle.textContent = state.notificationsEnabled ? '🔔' : '🔕';
    els.notifToggle.title = state.notificationsEnabled ? 'Mute notifications' : 'Enable notifications';
  }

  async function updateMyReadState() {
    if (state.messages.length === 0) return;
    let maxId = 0;
    for (const msg of state.messages) {
      if (msg.id > 0 && msg.sender !== MY_NAME && msg.id > maxId) maxId = msg.id;
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

  function onScroll() {
    state.isAtBottom = isNearBottom();
    if (state.isAtBottom) {
      hideToast();
      if (state.unreadCount > 0) {
        state.unreadCount = 0;
        updateUnreadCount();
      }
    }
    updateScrollBtn();
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
      let left = Math.max(8, rect.left + rect.width / 2 - tbar.offsetWidth / 2);
      let top = rect.top - tbar.offsetHeight - 8;
      if (top < 8) top = rect.bottom + 8;
      if (left + tbar.offsetWidth > window.innerWidth - 8) {
        left = window.innerWidth - tbar.offsetWidth - 8;
      }
      tbar.style.left = left + 'px';
      tbar.style.top = top + 'px';
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
      window.history.replaceState({}, '', window.location.pathname);
    }
  }

  function positionPicker(btn) {
    const rect = btn.getBoundingClientRect();
    const picker = els.reactionPicker;
    const padding = 8;
    const pickerW = picker.offsetWidth || 260;
    const pickerH = picker.offsetHeight || 56;
    let left = rect.left + rect.width / 2 - pickerW / 2;
    let top = rect.top - pickerH - 8;
    if (left < padding) left = padding;
    if (left + pickerW > window.innerWidth - padding) {
      left = window.innerWidth - pickerW - padding;
    }
    if (top < padding) top = rect.bottom + 8;
    picker.style.left = left + 'px';
    picker.style.top = top + 'px';
  }

  function setIdentity(name) {
    MY_NAME = name;
    els.friendName.textContent = PARTICIPANTS.filter(p => p !== name).join(', ');
    els.participantStatuses.innerHTML = PARTICIPANTS.filter(p => p !== name).map(p =>
      '<span class="participant-status" data-name="' + escapeHtml(p) + '">'
      + '<span class="status-dot"></span> ' + escapeHtml(p)
      + '</span>'
    ).join('');
    if (els.clearChatBtn) {
      els.clearChatBtn.style.display = MY_NAME === 'Ojas' ? '' : 'none';
    }
  }

  const MOOD_EMOJIS = { '': '🎯', 'Free': '😊', 'Busy': '⏳', 'Studying': '📚' };

  function positionMoodPicker() {
    const rect = els.moodBtn.getBoundingClientRect();
    const picker = els.moodPicker;
    const padding = 8;
    const pickerW = picker.offsetWidth || 150;
    let left = rect.right - pickerW;
    let top = rect.bottom + 4;
    if (left < padding) left = padding;
    if (left + pickerW > window.innerWidth - padding) left = window.innerWidth - pickerW - padding;
    if (top + picker.offsetHeight > window.innerHeight - padding) top = rect.top - picker.offsetHeight - 4;
    picker.style.left = left + 'px';
    picker.style.top = top + 'px';
  }

  function setMood(mood) {
    state.mood = mood;
    localStorage.setItem('chat_mood', mood);
    els.moodBtn.textContent = MOOD_EMOJIS[mood] || '🎯';
    els.moodPicker.querySelectorAll('.mood-option').forEach(b => b.classList.toggle('selected', b.dataset.mood === mood));
    els.moodPicker.classList.add('hidden');
    updateMyPresence(true, state.isTyping);
  }

  function updateMoodUI() {
    els.moodBtn.textContent = MOOD_EMOJIS[state.mood] || '🎯';
    els.moodPicker.querySelectorAll('.mood-option').forEach(b => b.classList.toggle('selected', b.dataset.mood === state.mood));
  }

  const MOON = '🌙', SUN = '☀️';

  function applyTheme() {
    const theme = localStorage.getItem('chat_theme') || 'dark';
    document.documentElement.dataset.theme = theme;
    els.themeToggle.textContent = theme === 'dark' ? MOON : SUN;
  }

  async function init() {
    cacheEls();
    parseArgs();
    applyTheme();
    setupEvents();

    if (MY_NAME) {
      setIdentity(MY_NAME);
      els.nameModal.classList.add('hidden');
      els.app.classList.remove('hidden');
      startApp();
      return;
    }

    els.nameModal.classList.remove('hidden');
    els.app.classList.add('hidden');

    els.btnArnav.addEventListener('click', () => {
      setIdentity('Arnav');
      els.nameModal.classList.add('hidden');
      els.app.classList.remove('hidden');
      startApp();
    });

    els.btnShaurya.addEventListener('click', () => {
      setIdentity('Shaurya');
      els.nameModal.classList.add('hidden');
      els.app.classList.remove('hidden');
      startApp();
    });

    els.btnOjas.addEventListener('click', () => {
      els.passwordGroup.classList.remove('hidden');
      els.passwordInput.focus();
      els.passwordError.classList.add('hidden');
    });

    els.passwordSubmit.addEventListener('click', () => {
      if (els.passwordInput.value.length === 4 && els.passwordInput.value.charCodeAt(0) === 55 && els.passwordInput.value.charCodeAt(1) === 56 && els.passwordInput.value.charCodeAt(2) === 52 && els.passwordInput.value.charCodeAt(3) === 48) {
        setIdentity('Ojas');
        els.nameModal.classList.add('hidden');
        els.app.classList.remove('hidden');
        startApp();
      } else {
        els.passwordError.classList.remove('hidden');
        els.passwordInput.value = '';
        els.passwordInput.focus();
      }
    });

    els.passwordInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') els.passwordSubmit.click();
    });
  }

  async function startApp() {
    let notifPerm = 'default';
    if ('Notification' in window) {
      notifPerm = await Notification.requestPermission();
    }
    updateMoodUI();
    try {
      setupRealtime();
      await loadInitialPresence();
      await loadInitialMessages();
      await setupPushNotifications(notifPerm);
      updateNotifToggleUI();
    } catch (e) {
      console.error('Load messages error:', e);
      els.msgList.innerHTML = '<div style="padding:20px;text-align:center;color:var(--danger)">Database connection failed. Check your Supabase credentials in config.js</div>';
      return;
    }
    startFallbackPoll();
    state.ready = true;
  }

  function setupEvents() {
    els.themeToggle.addEventListener('click', () => {
      const current = document.documentElement.dataset.theme;
      const next = current === 'dark' ? 'light' : 'dark';
      document.documentElement.dataset.theme = next;
      localStorage.setItem('chat_theme', next);
      els.themeToggle.textContent = next === 'dark' ? MOON : SUN;
    });

    els.notifToggle.addEventListener('click', toggleNotifications);

    els.clearChatBtn.addEventListener('click', clearAllMessages);

    els.moodBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (els.moodPicker.classList.contains('hidden')) {
        positionMoodPicker();
        els.moodPicker.classList.remove('hidden');
      } else {
        els.moodPicker.classList.add('hidden');
      }
    });

    els.moodPicker.addEventListener('click', (e) => {
      const btn = e.target.closest('.mood-option');
      if (btn) setMood(btn.dataset.mood);
    });

    els.msgContainer.addEventListener('scroll', onScroll, { passive: true });

    els.newMsgToast.addEventListener('click', () => {
      scrollToBottom(true);
      state.unreadCount = 0;
      updateUnreadCount();
    });

    els.newMsgToast.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); els.newMsgToast.click(); }
    });

    els.scrollBottomBtn.addEventListener('click', () => scrollToBottom(true));
    els.scrollBottomBtn.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); scrollToBottom(true); }
    });

    els.replyClose.addEventListener('click', clearReply);

    els.input.addEventListener('input', () => {
      els.input.style.height = 'auto';
      els.input.style.height = Math.min(els.input.scrollHeight, 120) + 'px';
      clearTimeout(state.typingTimer);
      if (!state.isTyping) {
        state.isTyping = true;
        updateMyPresence(true, true);
      }
      state.typingTimer = setTimeout(() => {
        state.isTyping = false;
        updateMyPresence(true, false);
      }, TYPING_IDLE_MS);
    });

    els.input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        const text = els.input.value.trim();
        if (state.editId) {
          if (text) editMessage(state.editId, text);
          else deleteMessage(state.editId);
        } else if (text) {
          sendMessage(text, 'text');
        }
      }
      if (e.key === 'Escape') {
        clearReply();
        state.editId = null;
        els.input.value = '';
        els.input.style.height = 'auto';
        els.input.blur();
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
      if (!els.moodPicker.contains(e.target) && !e.target.closest('#mood-btn')) {
        els.moodPicker.classList.add('hidden');
      }
      if (!e.target.closest('.message-actions')) {
        document.querySelectorAll('.message-actions.show').forEach(el => el.classList.remove('show'));
      }
    });

    els.sendBtn.addEventListener('click', () => {
      const text = els.input.value.trim();
      if (state.editId) {
        if (text) editMessage(state.editId, text);
        else { state.editId = null; els.input.value = ''; els.input.style.height = 'auto'; }
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
        setReply(msgId, msg.sender, msg.is_deleted ? (msg.content || 'Message was deleted') : msg.content);
      }
      if (btn.classList.contains('action-react')) {
        positionPicker(btn);
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

    els.reactionPicker.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') els.reactionPicker.classList.add('hidden');
    });

    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        updateMyPresence(false, false);
      } else {
        updateMyPresence(true, false);
        startFallbackPoll();
        pollNewMessages();
      }
    });
  }

  document.addEventListener('DOMContentLoaded', init);
})();
