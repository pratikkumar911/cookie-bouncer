let currentHost = null;
let currentTabId = null;

function send(tabId, msg) {
  return new Promise((resolve) => {
    try {
      chrome.tabs.sendMessage(tabId, msg, () => { void chrome.runtime.lastError; resolve(); });
    } catch { resolve(); }
  });
}

async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  currentTabId = tab?.id ?? null;
  try { currentHost = new URL(tab.url).hostname; } catch { currentHost = null; }

  const { enabled, pausedHosts = [] } = await chrome.storage.sync.get({
    enabled: true,
    pausedHosts: []
  });

  document.getElementById('enabled').checked = enabled;

  const { stats } = await chrome.storage.local.get({ stats: { total: 0, hosts: {} } });
  document.getElementById('count').textContent = stats.total || 0;

  const pauseBtn = document.getElementById('pause');
  if (currentHost && pausedHosts.includes(currentHost)) {
    pauseBtn.textContent = 'Resume on this site';
  }

  document.getElementById('enabled').addEventListener('change', async (e) => {
    await chrome.storage.sync.set({ enabled: e.target.checked });
  });

  pauseBtn.addEventListener('click', async () => {
    if (!currentHost) return;
    const { pausedHosts: list = [] } = await chrome.storage.sync.get({ pausedHosts: [] });
    const next = list.includes(currentHost)
      ? list.filter((h) => h !== currentHost)
      : [...list, currentHost];
    await chrome.storage.sync.set({ pausedHosts: next });
    pauseBtn.textContent = next.includes(currentHost)
      ? 'Resume on this site'
      : 'Pause on this site';
    if (currentTabId != null) send(currentTabId, { type: 'RESCAN' });
  });

  document.getElementById('rescan').addEventListener('click', async () => {
    if (currentTabId != null) await send(currentTabId, { type: 'RESCAN' });
    window.close();
  });
}

init();