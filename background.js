/* ==================================================================== *
 *  Cookie Bouncer — service worker
 *  - dedupes multi-frame reports
 *  - badge + stats
 * ==================================================================== */

const DEDUPE_MS = 3000;
const recent = new Map(); // `${tabId}|${host}` -> timestamp

function setBadge(tabId, text, color) {
  try {
    chrome.action.setBadgeBackgroundColor({ color });
    chrome.action.setBadgeText({ tabId, text });
  } catch { /* tab gone */ }
}

function bumpStats(host) {
  chrome.storage.local.get({ stats: { total: 0, hosts: {} } }, ({ stats }) => {
    stats.total = (stats.total || 0) + 1;
    stats.hosts = stats.hosts || {};
    stats.hosts[host] = (stats.hosts[host] || 0) + 1;
    chrome.storage.local.set({ stats });
  });
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type !== 'COOKIE_REJECTED') {
    sendResponse({ ok: false });
    return;
  }

  const tabId = sender.tab?.id;
  const host = msg.host;
  if (tabId == null || !host) {
    sendResponse({ ok: false });
    return;
  }

  const key = `${tabId}|${host}`;
  const now = Date.now();

  if (now - (recent.get(key) || 0) < DEDUPE_MS) {
    sendResponse({ ok: true, duplicate: true });
    return;
  }

  recent.set(key, now);
  if (recent.size > 500) {
    for (const [k, t] of recent) {
      if (now - t > 60000) recent.delete(k);
    }
  }

  bumpStats(host);
  setBadge(tabId, '✓', '#16a34a');
  setTimeout(() => setBadge(tabId, '', '#16a34a'), 4000);

  sendResponse({ ok: true });
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.sync.get({ enabled: true, pausedHosts: [] }, (s) => {
    chrome.storage.sync.set({
      enabled: s.enabled !== false,
      pausedHosts: Array.isArray(s.pausedHosts) ? s.pausedHosts : []
    });
  });

  chrome.storage.local.get({ stats: { total: 0, hosts: {} } }, (s) => {
    const stats = s.stats || { total: 0, hosts: {} };
    const next = { total: stats.total || 0, hosts: stats.hosts || {} };
    chrome.storage.local.set({ stats: next });
  });
});
