(() => {
  'use strict';

  const notes = new Map();
  let activeMode = 'default'; // default | timeline
  let filterRange = 'all';    // all | 3m | 6m | year | custom
  let filterFrom = '';        // YYYY-MM-DD
  let filterTo = '';          // YYYY-MM-DD
  let $originalGrid = null;
  let $customRoot = null;
  let $panel = null;
  let urlChangeDebounce = null;
  let timelineVisibleCount = 40;
  let timelineObserver = null;
  let profileLinkObserver = null;
  let profileLinkSyncTimer = null;
  let panelObserver = null;
  let panelRestoreTimer = null;
  const profileLinks = new Map();
  const profileSourceLinks = new Map();
  const isProfilePage = () => /^\/user\/profile\//.test(location.pathname);
  const isNoteDetailPage = () => /^\/explore\//.test(location.pathname);
  const profileKey = () => location.pathname.match(/^\/user\/profile\/([^/]+)/)?.[1] || '';
  let activeProfileKey = profileKey();

  function findOriginalGrid() {
    const profileFeed = document.querySelector('#userPostedFeeds, .feeds-container');
    if (profileFeed && profileFeed.querySelector('.note-item')) return profileFeed;

    const links = Array.from(document.querySelectorAll('a[href*="/explore/"], a[href*="/search_result/"]')).filter(
      (a) => !($customRoot && $customRoot.contains(a))
    );
    if (!links.length) return null;

    const candidates = new Map();
    for (const a of links) {
      let el = a.parentElement;
      let depth = 0;
      while (el && el !== document.body && depth < 12) {
        const count = el.querySelectorAll(':scope a[href*="/explore/"], :scope a[href*="/search_result/"]').length;
        if (count >= 3) {
          candidates.set(el, (candidates.get(el) || 0) + count);
        }
        el = el.parentElement;
        depth++;
      }
    }

    let best = null;
    let bestScore = 0;
    for (const [el, score] of candidates) {
      const rect = el.getBoundingClientRect();
      const area = rect.width * rect.height;
      if (area < 200) continue;
      if (score > bestScore) {
        bestScore = score;
        best = el;
      }
    }
    return best;
  }

  function createPanel() {
    if ($panel) return $panel;
    const div = document.createElement('div');
    div.className = 'xhs-layout-panel';
    div.innerHTML = `
      <div class="xhs-layout-title">小红书时间线</div>
      <div class="xhs-layout-btns">
        <button data-mode="default" title="恢复默认网格">网格</button>
        <button data-mode="timeline" title="按发布时间排序">时间线</button>
      </div>
      <div class="xhs-layout-filter">
        <div class="xhs-filter-row">
          <span class="xhs-filter-label">时间</span>
          <select id="xhs-range">
            <option value="all">全部时间</option>
            <option value="3m">近3个月</option>
            <option value="6m">近6个月</option>
            <option value="year">今年</option>
            <option value="custom">自定义…</option>
          </select>
        </div>
        <div class="xhs-filter-custom hide" id="xhs-custom">
          <input type="date" id="xhs-from" /> <span class="xhs-tilde">~</span> <input type="date" id="xhs-to" />
        </div>
      </div>
      <div class="xhs-layout-count">已识别 <span id="xhs-note-count">0</span> 篇</div>
    `;
    div.querySelectorAll('.xhs-layout-btns button').forEach((btn) => {
      btn.addEventListener('click', () => setMode(btn.dataset.mode));
    });
    const rangeSel = div.querySelector('#xhs-range');
    const customBox = div.querySelector('#xhs-custom');
    rangeSel.addEventListener('change', () => {
      filterRange = rangeSel.value;
      customBox.classList.toggle('hide', filterRange !== 'custom');
      if (activeMode !== 'default') {
        timelineVisibleCount = 40;
        render();
      }
    });
    div.querySelector('#xhs-from').addEventListener('change', (e) => {
      filterFrom = e.target.value;
      if (activeMode !== 'default') {
        timelineVisibleCount = 40;
        render();
      }
    });
    div.querySelector('#xhs-to').addEventListener('change', (e) => {
      filterTo = e.target.value;
      if (activeMode !== 'default') {
        timelineVisibleCount = 40;
        render();
      }
    });
    document.body.appendChild(div);
    $panel = div;
    $panel.dataset.mode = activeMode;
    return div;
  }

  function ensurePanelPresence() {
    if ((!isProfilePage() && !isNoteDetailPage()) || !document.body) return;
    if (!$panel || !document.documentElement.contains($panel)) {
      $panel = null;
      createPanel();
      updatePanel();
    }
  }

  function createCustomRoot() {
    if ($customRoot) return $customRoot;
    const root = document.createElement('div');
    root.className = 'xhs-layout-root';
    root.id = 'xhs-layout-root';
    root.addEventListener('click', (event) => {
      const card = event.target.closest('.xhs-note-card[data-note-id]');
      if (!card) return;

      // 时间线卡片绝不能自己执行 href 的默认跳转，否则会离开个人主页。
      event.preventDefault();
      const noteId = card.dataset.noteId;
      const findSourceLink = () => {
        const sourceCard = Array.from(document.querySelectorAll('#userPostedFeeds .note-item, .feeds-container .note-item'))
          .find((item) => item.getAttribute('data-note-id') === noteId);
        return sourceCard?.querySelector('a.cover[href], a.title[href]') || profileSourceLinks.get(noteId);
      };
      let sourceLink = findSourceLink();
      if (!sourceLink) {
        syncDomMetadata();
        sourceLink = findSourceLink();
      }
      if (!sourceLink) return;

      // 只触发小红书原卡片的 Vue 点击处理器。dispatchEvent 不会触发锚点
      // 的浏览器默认导航，因此处理器失效时也不会把主页变成发现页。
      sourceLink.dispatchEvent(new MouseEvent('click', {
        bubbles: true,
        cancelable: true,
        view: window
      }));
    });
    return root;
  }

  function updatePanel() {
    if (!$panel) return;
    const countEl = $panel.querySelector('#xhs-note-count');
    if (countEl) countEl.textContent = String(notes.size);
    $panel.querySelectorAll('.xhs-layout-btns button').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.mode === activeMode);
    });
  }

  function getNoteDate(note) {
    if (!note.time) return null;
    const t = note.time;
    if (typeof t === 'number') return new Date(t > 1e11 ? t : t * 1000);
    const s = String(t).trim();
    if (/^\d{13}$/.test(s)) return new Date(Number(s));
    if (/^\d{10}$/.test(s)) return new Date(Number(s) * 1000);
    if (/^\d{4}-\d{2}-\d{2}/.test(s)) return new Date(s.replace(/-/g, '/'));
    
    // 兼容 MM-DD 格式，如 "08-15" 或 "4-23" 或 "04-23"
    const mmddMatch = s.match(/^(\d{1,2})-(\d{1,2})$/);
    if (mmddMatch) {
      const currentYear = new Date().getFullYear();
      return new Date(currentYear, parseInt(mmddMatch[1], 10) - 1, parseInt(mmddMatch[2], 10));
    }
    
    // 兼容 "X天前" 格式，如 "7天前" 或 "4天前"
    const daysAgoMatch = s.match(/^(\d+)\s*天前$/);
    if (daysAgoMatch) {
      const d = new Date();
      d.setDate(d.getDate() - parseInt(daysAgoMatch[1], 10));
      return d;
    }

    const d = new Date(s);
    return isNaN(d.getTime()) ? null : d;
  }

  function formatDate(date) {
    if (!date) return '未知时间';
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  }

  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] || c)
    );
  }

  // ---- 筛选逻辑 ----
  function inRange(date) {
    if (filterRange === 'all') return true;
    if (!date) return false; // 选了时间范围但笔记无时间，则排除
    const now = new Date();
    if (filterRange === '3m') {
      const d = new Date(now);
      d.setMonth(d.getMonth() - 3);
      return date >= d;
    }
    if (filterRange === '6m') {
      const d = new Date(now);
      d.setMonth(d.getMonth() - 6);
      return date >= d;
    }
    if (filterRange === 'year') {
      return date.getFullYear() === now.getFullYear();
    }
    if (filterRange === 'custom') {
      if (filterFrom && date < new Date(filterFrom + 'T00:00:00')) return false;
      if (filterTo && date > new Date(filterTo + 'T23:59:59')) return false;
      return true;
    }
    return true;
  }

  function getFilteredNotes() {
    const out = [];
    for (const n of notes.values()) {
      const date = getNoteDate(n);
      if (!inRange(date)) continue;
      out.push(n);
    }
    return out;
  }

  function renderItem(note) {
    const date = getNoteDate(note);
    const link = getProfileNoteLink(note);
    return `
      <a class="xhs-note-card" data-note-id="${escapeHtml(note.id)}" href="${escapeHtml(link)}">
        <div class="xhs-note-cover" style="background-image:url('${escapeHtml(note.cover || '')}')"></div>
        <div class="xhs-note-body">
          <div class="xhs-note-title">${escapeHtml(note.title || note.desc.slice(0, 40) || '无标题')}</div>
          <div class="xhs-note-desc">${escapeHtml(note.desc.slice(0, 120))}${note.desc.length > 120 ? '…' : ''}</div>
          <div class="xhs-note-meta">
            <span>${formatDate(date)}</span>
            <span>♥ ${Number(note.likes || 0).toLocaleString()}</span>
          </div>
        </div>
      </a>
    `;
  }

  function getProfileNoteLink(note) {
    const cards = document.querySelectorAll('#userPostedFeeds .note-item, .feeds-container .note-item');
    for (const card of cards) {
      if (card.getAttribute('data-note-id') !== String(note.id)) continue;
      const link = card.querySelector('a.cover[href], a.title[href]')?.href;
      if (link) {
        profileLinks.set(String(note.id), link);
        return link;
      }
    }
    return profileLinks.get(String(note.id)) || note.link;
  }

  function getTimelineNotes() {
    const list = getFilteredNotes();
    return list
      .map((n) => ({ ...n, _date: getNoteDate(n) }))
      .sort((a, b) => (b._date ? b._date.getTime() : 0) - (a._date ? a._date.getTime() : 0));
  }

  function renderTimeline() {
    const sorted = getTimelineNotes();
    const visibleNotes = sorted.slice(0, timelineVisibleCount);

    const groups = new Map();
    for (const note of visibleNotes) {
      const key = note._date ? `${note._date.getFullYear()}年${note._date.getMonth() + 1}月` : '未知时间';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(note);
    }

    let html = '';
    for (const [month, list2] of groups) {
      html += `<div class="xhs-group">
        <div class="xhs-group-title">${escapeHtml(month)} <small>(${list2.length})</small></div>
        <div class="xhs-list">${list2.map(renderItem).join('')}</div>
      </div>`;
    }
    if (!html) return '<div class="xhs-empty">当前筛选条件下没有笔记</div>';
    if (visibleNotes.length < sorted.length) {
      html += '<div class="xhs-timeline-sentinel" aria-hidden="true"></div>';
    }
    return html;
  }

  function observeTimelineEnd() {
    timelineObserver?.disconnect();
    const sentinel = $customRoot?.querySelector('.xhs-timeline-sentinel');
    if (!sentinel || !('IntersectionObserver' in window)) return;
    timelineObserver = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      timelineObserver.disconnect();
      requestAnimationFrame(() => {
        timelineVisibleCount += 40;
        render();
      });
    }, { rootMargin: '600px 0px' });
    timelineObserver.observe(sentinel);
  }

  function render() {
    if (!$customRoot) return;
    if (activeMode === 'default') {
      timelineObserver?.disconnect();
      $customRoot.style.display = 'none';
      restoreOriginalGrid();
      return;
    }
    $customRoot.style.display = '';
    if ($originalGrid) $originalGrid.classList.add('xhs-layout-grid-hidden');
    $customRoot.innerHTML = renderTimeline();
    observeTimelineEnd();
  }

  function restoreOriginalGrid() {
    if (!$originalGrid) return;
    const grid = $originalGrid;
    grid.classList.remove('xhs-layout-grid-hidden');
    requestAnimationFrame(() => {
      window.dispatchEvent(new Event('resize'));
      const scroller = grid.closest('.tab-content-item');
      scroller?.dispatchEvent(new Event('scroll'));
    });
  }

  function ensureLayout() {
    createPanel();
    if (!$customRoot) {
      $customRoot = createCustomRoot();
      const grid = findOriginalGrid();
      if (grid && grid.parentElement) {
        $originalGrid = grid;
        grid.parentElement.insertBefore($customRoot, grid.nextSibling);
      } else {
        document.body.appendChild($customRoot);
      }
    }
    render();
  }

  function setMode(mode) {
    if (mode === 'timeline') timelineVisibleCount = 40;
    activeMode = mode;
    if ($panel) $panel.dataset.mode = mode;
    ensureLayout();
    updatePanel();
  }

  function mergeNotes(newNotes) {
    if (!Array.isArray(newNotes)) return;
    let changed = false;
    for (const n of newNotes) {
      if (!n || !n.id) continue;
      const existing = notes.get(n.id);
      if (!existing) {
        notes.set(n.id, n);
        changed = true;
      } else {
        const merged = { ...existing, ...n };
        if (JSON.stringify(merged) !== JSON.stringify(existing)) {
          notes.set(n.id, merged);
          changed = true;
        }
      }
    }
    if (changed) {
      syncDomMetadata();
      updatePanel();
      if (activeMode !== 'default') {
        timelineVisibleCount = 40;
        render();
      }
    }
  }

  // 个人主页 SSR 列表把 noteCard.id 脱敏为空，但 DOM 仍保留真实 data-note-id。
  // 用标题和卡片顺序补回 ID，保证图文/视频都能打开原笔记。
  function syncDomMetadata() {
    const cards = Array.from(document.querySelectorAll('#userPostedFeeds .note-item, .feeds-container .note-item'));
    if (!cards.length) return;
    const byTitle = new Map();
    for (const card of cards) {
      const id = card.getAttribute('data-note-id');
      const title = card.querySelector('a.title')?.textContent?.trim();
      const link = card.querySelector('a.cover[href], a.title[href]')?.href || `https://www.xiaohongshu.com/explore/${id}`;
      if (id && title) byTitle.set(title, { id, link });
      if (id && link) profileLinks.set(String(id), link);
      const sourceLink = card.querySelector('a.cover[href], a.title[href]');
      if (id && sourceLink) profileSourceLinks.set(String(id), sourceLink);
    }
    const replacements = [];
    for (const [key, note] of notes) {
      const meta = byTitle.get(note.title || note.displayTitle);
      if (!meta) continue;
      replacements.push([key, meta.id, { ...note, id: meta.id, link: meta.link }]);
    }
    for (const [oldKey, newKey, note] of replacements) {
      notes.delete(oldKey);
      notes.set(newKey, note);
    }
  }

  function resetOnUrlChange(nextProfileKey = profileKey()) {
    // 帖子详情弹窗/详情路由仍属于当前主页会话，不清空笔记和浮窗。
    if (nextProfileKey && nextProfileKey === activeProfileKey) {
      if (isProfilePage()) {
        createPanel();
        syncDomMetadata();
      } else if (isNoteDetailPage()) {
        createPanel();
      }
      return;
    }
    if (isNoteDetailPage() && activeProfileKey) {
      createPanel();
      return;
    }
    notes.clear();
    profileLinks.clear();
    profileSourceLinks.clear();
    timelineObserver?.disconnect();
    timelineVisibleCount = 40;
    restoreOriginalGrid();
    $originalGrid = null;
    activeMode = 'default';
    activeProfileKey = nextProfileKey;
    if ($customRoot) {
      $customRoot.remove();
      $customRoot = null;
    }
    if (!isProfilePage() && $panel) {
      $panel.remove();
      $panel = null;
    }
    if (!isProfilePage()) {
      profileLinkObserver?.disconnect();
      profileLinkObserver = null;
      clearTimeout(profileLinkSyncTimer);
      panelObserver?.disconnect();
      panelObserver = null;
      clearTimeout(panelRestoreTimer);
    }
    updatePanel();
    if (isProfilePage()) init();
  }

  function init() {
    if (!isProfilePage()) return;
    activeProfileKey = profileKey();
    createPanel();
    window.postMessage({ source: 'xhs-layout-ext', type: 'REQUEST_NOTES' }, '*');
    syncDomMetadata();
    profileLinkObserver?.disconnect();
    profileLinkObserver = new MutationObserver(() => {
      clearTimeout(profileLinkSyncTimer);
      profileLinkSyncTimer = setTimeout(() => {
        profileLinkSyncTimer = null;
        syncDomMetadata();
      }, 300);
    });
    profileLinkObserver.observe(document.body, { childList: true, subtree: true });
    panelObserver?.disconnect();
    panelObserver = new MutationObserver(() => {
      if (panelRestoreTimer) return;
      panelRestoreTimer = setTimeout(() => {
        panelRestoreTimer = null;
        ensurePanelPresence();
      }, 100);
    });
    panelObserver.observe(document.documentElement, { childList: true, subtree: true });
    ensurePanelPresence();
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.source !== 'xhs-layout-ext') return;

    if (data.type === 'NOTES_DATA') {
      mergeNotes(data.data?.notes);
    } else if (data.type === 'URL_CHANGE') {
      clearTimeout(urlChangeDebounce);
      const nextKey = profileKey();
      urlChangeDebounce = setTimeout(() => resetOnUrlChange(nextKey), 300);
    }
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
