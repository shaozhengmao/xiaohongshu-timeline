(() => {
  'use strict';

  const FLAG = '__xhsLayoutExtInjected';
  if (window[FLAG]) return;
  window[FLAG] = true;

  const DEBUG = /[?&]xhsdebug(=1)?(&|$)/i.test(location.search);
  const isProfilePage = () => /^\/user\/profile\//.test(location.pathname);

  function post(type, data) {
    window.postMessage({ source: 'xhs-layout-ext', type, data }, '*');
  }

  function firstPresent(...values) {
    return values.find((value) => value !== undefined && value !== null && value !== '');
  }

  function isNoteCandidate(raw) {
    if (!raw || typeof raw !== 'object') return false;
    const card = raw.note_card || raw.noteCard || raw;
    if (raw.note_card || raw.noteCard) return true;
    const id = card.note_id || card.noteId || card.id || raw.note_id || raw.noteId;
    return Boolean(id && (
      card.note_url || card.noteUrl || card.display_title || card.displayTitle ||
      card.title || card.cover || card.time || card.publish_time || card.publishTime
    ));
  }

  // 从（可能嵌套 note_card / noteCard 的）原始对象里抽取一条归一化笔记
  function extractNoteData(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const card = (raw.note_card && typeof raw.note_card === 'object') ? raw.note_card :
      ((raw.noteCard && typeof raw.noteCard === 'object') ? raw.noteCard : raw);
    const id = firstPresent(card.note_id, card.noteId, card.id, raw.note_id, raw.noteId, raw.id,
      card.display_title && `${card.display_title}|${card.time || ''}`, card.displayTitle && `${card.displayTitle}|${card.time || ''}`);
    if (!id) return null;

    const interact = card.interact_info || card.interactInfo || card.counts || raw.interact_info || raw.interactInfo || {};
    const coverObj =
      card.cover || card.cover_info || card.coverInfo || card.image_info || card.imageInfo ||
      (Array.isArray(card.images_list) ? card.images_list[0] : null) ||
      (Array.isArray(card.imagesList) ? card.imagesList[0] : null) ||
      (Array.isArray(card.image_list) ? card.image_list[0] : null) ||
      (Array.isArray(card.imageList) ? card.imageList[0] : null) ||
      raw.cover || {};
    const cover =
      typeof coverObj === 'string'
        ? coverObj
        : (coverObj.url_default || coverObj.urlDefault || coverObj.url || coverObj.url_pre || coverObj.urlPre ||
          (Array.isArray(coverObj.infoList) && coverObj.infoList.find((item) => item.imageScene === 'WB_DFT')?.url) ||
          coverObj.file_id || coverObj.fileId || '');

    return {
      id: String(id),
      title: String(card.title || card.display_title || card.displayTitle || raw.title || raw.display_title || raw.displayTitle || '').trim(),
      displayTitle: String(card.display_title || card.displayTitle || card.title || '').trim(),
      desc: String(card.desc || card.description || raw.desc || raw.description || '').trim(),
      cover: String(cover || ''),
      link: card.note_url || card.noteUrl || raw.note_url || raw.noteUrl || `https://www.xiaohongshu.com/explore/${id}`,
      time: firstPresent(card.time, card.publish_time, card.publishTime, card.create_time, card.createTime,
        card.last_update_time, card.lastUpdateTime, raw.time, raw.publish_time, raw.publishTime,
        raw.create_time, raw.createTime, raw.last_update_time, raw.lastUpdateTime, ''),
      likes: Number(interact.liked_count || interact.likedCount || interact.likes || card.liked_count || card.likedCount || 0),
      author: (card.user || raw.user) ? String((card.user || raw.user).nickname || (card.user || raw.user).nickName ||
        (card.user || raw.user).user_id || (card.user || raw.user).userId || '') : ''
    };
  }

  // 递归扫描整棵响应树，对每个"可能是笔记"的对象尝试抽取
  function extractNotes(obj, out = new Map(), visited = new WeakSet()) {
    if (!obj || typeof obj !== 'object') return out;
    if (visited.has(obj)) return out;
    visited.add(obj);

    if (isNoteCandidate(obj)) {
      const note = extractNoteData(obj);
      if (note) out.set(note.id, note);
    }

    if (Array.isArray(obj)) {
      for (const item of obj) extractNotes(item, out, visited);
    } else {
      for (const k of Object.keys(obj)) {
        extractNotes(obj[k], out, visited);
      }
    }
    return out;
  }

  function dispatchNotesFromText(text, url) {
    if (!isProfilePage()) return;
    try {
      const json = JSON.parse(text);
      const map = extractNotes(json);
      if (map.size > 0) {
        const list = Array.from(map.values());
        if (DEBUG) console.log(`[XhsLayoutExt] Parsed ${list.length} notes from API: ${url}`, list);
        post('NOTES_DATA', { notes: list, url });
      }
    } catch (e) {
      // ignore
    }
  }

  function readInitialState() {
    if (!isProfilePage()) return;
    const scripts = Array.from(document.scripts);
    for (const script of scripts) {
      const text = script.textContent || '';
      const marker = text.indexOf('"notes":');
      if (marker < 0) continue;
      const start = text.indexOf('[', marker);
      if (start < 0) continue;
      let depth = 0;
      let quote = false;
      let escaped = false;
      for (let i = start; i < text.length; i++) {
        const ch = text[i];
        if (quote) {
          if (escaped) escaped = false;
          else if (ch === '\\') escaped = true;
          else if (ch === '"') quote = false;
          continue;
        }
        if (ch === '"') quote = true;
        else if (ch === '[') depth++;
        else if (ch === ']' && --depth === 0) {
          try {
            const map = extractNotes(JSON.parse(text.slice(start, i + 1)));
            if (map.size) post('NOTES_DATA', { notes: Array.from(map.values()), url: location.href });
          } catch (e) {}
          break;
        }
      }
    }
  }

  // ---- 拦截 fetch ----
  if (window.fetch) {
    const origFetch = window.fetch;
    window.fetch = async function (...args) {
      const response = await origFetch.apply(this, args);
      if (!isProfilePage()) return response;
      try {
        const requestUrl = (typeof args[0] === 'string' ? args[0] : args[0]?.url) || response.url;
        const isJson = (response.headers.get('content-type') || '').includes('application/json');
        if (/xiaohongshu\.com.*\/api\//i.test(requestUrl) || isJson) {
          response.clone().text().then((text) => dispatchNotesFromText(text, response.url));
        }
      } catch (err) {
        if (DEBUG) console.warn('[XhsLayoutExt] Failed clone/parse fetch:', err);
      }
      return response;
    };
  }

  // ---- 拦截 XMLHttpRequest ----
  if (window.XMLHttpRequest) {
    const origOpen = window.XMLHttpRequest.prototype.open;
    const origSend = window.XMLHttpRequest.prototype.send;

    window.XMLHttpRequest.prototype.open = function (method, url, ...args) {
      this.__url = url;
      return origOpen.call(this, method, url, ...args);
    };

    window.XMLHttpRequest.prototype.send = function (...args) {
      this.addEventListener('load', function () {
        try {
          if (isProfilePage() && this.responseText && /xiaohongshu\.com.*\/api\//i.test(String(this.__url))) {
            dispatchNotesFromText(this.responseText, this.__url);
          }
        } catch (err) {
          if (DEBUG) console.warn('[XhsLayoutExt] Failed parse XHR:', err);
        }
      });
      return origSend.apply(this, args);
    };
  }

  // ---- 监控 URL 变化 ----
  let lastUrl = location.href;
  const checkUrlChange = () => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      post('URL_CHANGE', { url: lastUrl });
    }
  };
  const origPushState = history.pushState;
  if (origPushState) {
    history.pushState = function (...args) {
      origPushState.apply(this, args);
      checkUrlChange();
    };
  }
  const origReplaceState = history.replaceState;
  if (origReplaceState) {
    history.replaceState = function (...args) {
      origReplaceState.apply(this, args);
      checkUrlChange();
    };
  }
  window.addEventListener('popstate', checkUrlChange);
  window.addEventListener('hashchange', checkUrlChange);
  window.addEventListener('message', (event) => {
    if (event.source === window && event.data?.source === 'xhs-layout-ext' && event.data.type === 'REQUEST_NOTES') {
      readInitialState();
    }
  });

  readInitialState();
  window.addEventListener('load', readInitialState, { once: true });

})();
