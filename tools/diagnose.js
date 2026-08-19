// ===== 小红书布局助手 · 数据诊断脚本（时间分布版）=====
// 用法：
//   1) 已登录 Chrome 打开你的小红书【个人主页】
//   2) F12 → Console，把整段粘进去回车
//   3) 刷新页面，并往下滚动（或点扩展里的「自动加载更多」）触发分页
//   4) 控制台会【每次接口响应后】打印累计的「按月时间分布」+ time 原始格式 + tag_list 统计
//   5) 把最后那段 [XHS诊断] === 累计 === 的月度分布发我，我就能判断：
//      - 是 7/8 月笔记根本没被抓到（数据不全）
//      - 还是 time 字段解析错了（时间戳格式问题）
//
// 重点看：
//   - 有没有 2026-08 / 2026-07 的篇数？没有 → 抓取不全
//   - time 原始值抽样：是 13 位毫秒戳 / 10 位秒戳 / 字符串？解析是否对
//   - 有 tag_list 的：应为 0（确认话题列表接口拿不到）

(function () {
  const collected = new Map();

  function jsonParse(t) { try { return JSON.parse(t); } catch (e) { return null; } }

  function extractAllNotes(obj, out, seen) {
    out = out || []; seen = seen || new WeakSet();
    if (!obj || typeof obj !== 'object' || seen.has(obj)) return out;
    seen.add(obj);
    if (obj.note_id || obj.id || obj.note_card) {
      const card = (obj.note_card && typeof obj.note_card === 'object') ? obj.note_card : obj;
      const id = card.note_id || card.id || obj.note_id || obj.id;
      if (id) {
        out.push({
          note_id: String(id),
          time: card.time != null ? card.time : obj.time,
          last_update_time: card.last_update_time != null ? card.last_update_time : obj.last_update_time,
          create_time: card.create_time != null ? card.create_time : obj.create_time,
          note_card: obj.note_card,
          tag_list: card.tag_list != null ? card.tag_list : obj.tag_list
        });
      }
    }
    if (Array.isArray(obj)) {
      for (const i of obj) extractAllNotes(i, out, seen);
    } else {
      for (const k of Object.keys(obj)) {
        if (k === 'note_card') continue;
        const v = obj[k];
        if (v && typeof v === 'object') extractAllNotes(v, out, seen);
      }
    }
    return out;
  }

  function parseDate(t) {
    if (t == null) return null;
    if (typeof t === 'number') return new Date(t > 1e11 ? t : t * 1000);
    const s = String(t).trim();
    if (/^\d{13}$/.test(s)) return new Date(Number(s));
    if (/^\d{10}$/.test(s)) return new Date(Number(s) * 1000);
    if (/^\d{4}-\d{2}-\d{2}/.test(s)) return new Date(s.replace(/-/g, '/'));
    const d = new Date(s);
    return isNaN(d.getTime()) ? null : d;
  }

  function collect(json, url) {
    if (!json) return;
    const notes = extractAllNotes(json);
    if (!notes.length) return;
    console.log('%c[XHS诊断] 接口 ' + url + ' 识别 ' + notes.length + ' 篇', 'color:#ff2442');
    for (const n of notes) {
      const rawTime = n.time != null ? n.time : (n.last_update_time != null ? n.last_update_time : (n.create_time != null ? n.create_time : '(无)'));
      const parsed = parseDate(rawTime);
      const card = (n.note_card && typeof n.note_card === 'object') ? n.note_card : n;
      const hasTag = !!(card.tag_list && card.tag_list.length) || !!(n.tag_list && n.tag_list.length);
      collected.set(n.note_id, { rawTime, parsed, hasTag });
    }
    report();
  }

  function report() {
    console.log('%c[XHS诊断] === 累计 ' + collected.size + ' 篇 ===', 'color:#07c160;font-weight:bold');
    const byMonth = {};
    let noTime = 0, withTag = 0;
    for (const v of collected.values()) {
      if (v.parsed) {
        const k = v.parsed.getFullYear() + '-' + String(v.parsed.getMonth() + 1).padStart(2, '0');
        byMonth[k] = (byMonth[k] || 0) + 1;
      } else noTime++;
      if (v.hasTag) withTag++;
    }
    const months = Object.keys(byMonth).sort();
    for (const m of months) console.log('   ' + m + ': ' + byMonth[m] + ' 篇');
    if (noTime) console.log('   无时间字段: ' + noTime + ' 篇');
    console.log('   有 tag_list 的(话题): ' + withTag + ' 篇');
    const samples = [...collected.values()].slice(0, 6);
    console.log('   time 原始值抽样: ' + samples.map(s => s.rawTime).join(' | '));
  }

  const origFetch = window.fetch;
  window.fetch = async function (...args) {
    const resp = await origFetch.apply(this, args);
    try {
      const url = (typeof args[0] === 'string' ? args[0] : (args[0] && args[0].url)) || resp.url;
      if (/xiaohongshu\.com.*\/api\//i.test(url)) {
        const clone = resp.clone();
        const txt = await clone.text();
        collect(jsonParse(txt), url);
      }
    } catch (e) {}
    return resp;
  };

  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (m, u, ...r) { this._u = u; return origOpen.call(this, m, u, ...r); };
  XMLHttpRequest.prototype.send = function (...a) {
    this.addEventListener('load', () => {
      try { if (this._u && /xiaohongshu\.com.*\/api\//i.test(this._u)) collect(jsonParse(this.responseText), this._u); } catch (e) {}
    });
    return origSend.apply(this, a);
  };

  console.log('%c[XHS诊断] 已安装 ✓ 刷新 + 滚动后，控制台会打印按月时间分布。把最后一段「=== 累计 ===」发我即可。', 'color:#07c160;font-weight:bold');
})();
