(() => {
  'use strict';

  const statusEl = document.getElementById('status');
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const tab = tabs[0];
    if (!tab || !tab.url || !/xiaohongshu\.com/.test(tab.url)) {
      statusEl.textContent = '当前页面不是小红书';
      return;
    }
    statusEl.textContent = '已启用';
  });
})();
