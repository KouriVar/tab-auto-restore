const STORAGE_KEYS = {
  lastSessionTabs: "lastSessionTabs",
  lastSessionSignature: "lastSessionSignature",
  restoreInProgress: "restoreInProgress",
  pendingAutoRestore: "pendingAutoRestore"
};

const SYNC_DEBOUNCE_MS = 650;
const RESTORE_SETTLE_MS = 1200;
const INVALID_URL_PREFIXES = [
  "chrome://",
  "chrome-extension://",
  "edge://",
  "brave://",
  "vivaldi://",
  "opera://",
  "about:",
  "devtools://"
];

let syncDebounceId;
let autoRestoreRunning = false;

chrome.runtime.onInstalled.addListener(async () => {
  await markPendingAutoRestore(false);
  await syncState();
});

chrome.runtime.onStartup.addListener(async () => {
  await markPendingAutoRestore(true);
  setTimeout(tryAutoRestoreToAnyNormalWindow, RESTORE_SETTLE_MS);
  scheduleStateSync();
});

chrome.tabs.onCreated.addListener(scheduleStateSync);
chrome.tabs.onUpdated.addListener((_tabId, changeInfo) => {
  if (changeInfo.url || changeInfo.status === "complete") {
    scheduleStateSync();
  }
});
chrome.tabs.onMoved.addListener(scheduleStateSync);
chrome.tabs.onAttached.addListener(scheduleStateSync);
chrome.tabs.onDetached.addListener(scheduleStateSync);
chrome.tabs.onRemoved.addListener(scheduleStateSync);

chrome.windows.onCreated.addListener((window) => {
  if (window.type !== "normal") {
    return;
  }

  scheduleStateSync();
  setTimeout(() => {
    maybeAttemptAutoRestoreInWindow(window.id);
  }, RESTORE_SETTLE_MS);
});

chrome.windows.onRemoved.addListener(async () => {
  scheduleStateSync();
  await handleWindowRemovedForAutoRestore();
});

scheduleStateSync();

function scheduleStateSync() {
  clearTimeout(syncDebounceId);
  syncDebounceId = setTimeout(() => {
    syncState().catch(() => {
      // Keep the background worker resilient on transient browser API errors.
    });
  }, SYNC_DEBOUNCE_MS);
}

async function syncState() {
  if (await isRestoreInProgress()) {
    return;
  }

  if (await isPendingAutoRestore()) {
    return;
  }

  const tabs = await queryValidTabs();
  if (!tabs.length) {
    return;
  }

  const signature = createSignature(tabs);
  const stored = await chrome.storage.local.get(STORAGE_KEYS.lastSessionSignature);
  if (stored[STORAGE_KEYS.lastSessionSignature] === signature) {
    return;
  }

  await chrome.storage.local.set({
    [STORAGE_KEYS.lastSessionTabs]: tabs,
    [STORAGE_KEYS.lastSessionSignature]: signature
  });
}

async function tryAutoRestoreToAnyNormalWindow() {
  const windows = await queryNormalWindows();
  if (!windows.length) {
    return;
  }

  await maybeAttemptAutoRestoreInWindow(windows[0].id);
}

async function maybeAttemptAutoRestoreInWindow(windowId) {
  if (autoRestoreRunning) {
    return;
  }

  const { [STORAGE_KEYS.pendingAutoRestore]: pendingAutoRestore } =
    await chrome.storage.session.get(STORAGE_KEYS.pendingAutoRestore);
  if (!pendingAutoRestore) {
    return;
  }

  autoRestoreRunning = true;
  try {
    const stored = await chrome.storage.local.get(STORAGE_KEYS.lastSessionTabs);
    const lastSessionTabs = filterValidTabs(stored[STORAGE_KEYS.lastSessionTabs] || []);
    if (!lastSessionTabs.length) {
      await markPendingAutoRestore(false);
      return;
    }

    const currentTabs = await queryValidTabs();
    if (hasAllTabs(currentTabs, lastSessionTabs)) {
      await markPendingAutoRestore(false);
      return;
    }

    await restoreTabsIntoWindow(windowId, lastSessionTabs);
    await markPendingAutoRestore(false);
    await syncState();
  } finally {
    autoRestoreRunning = false;
  }
}

async function restoreTabsIntoWindow(windowId, tabs) {
  const validTabs = filterValidTabs(tabs);
  if (!validTabs.length) {
    return;
  }

  await chrome.storage.session.set({
    [STORAGE_KEYS.restoreInProgress]: true
  });

  try {
    await replaceWindowTabs(windowId, validTabs);
  } finally {
    await wait(1000);
    await chrome.storage.session.remove(STORAGE_KEYS.restoreInProgress);
  }
}

async function replaceWindowTabs(windowId, tabSnapshots) {
  const existingTabs = await chrome.tabs.query({ windowId });
  const [firstTab, ...restTabs] = tabSnapshots;
  const firstUrl = firstTab?.url;

  if (!firstUrl) {
    return;
  }

  if (!existingTabs.length) {
    await createTabsInExistingWindow(windowId, tabSnapshots.map((tab) => tab.url));
    return;
  }

  const survivor = existingTabs[0];
  await chrome.tabs.update(survivor.id, { url: firstUrl, active: true });

  for (const tab of restTabs) {
    await chrome.tabs.create({ windowId, url: tab.url, active: false });
  }

  const removableIds = existingTabs
    .slice(1)
    .map((tab) => tab.id)
    .filter((tabId) => typeof tabId === "number");

  await removeTabsSafely(removableIds);
}

async function createTabsInExistingWindow(windowId, urls) {
  const [firstUrl, ...restUrls] = urls;
  await chrome.tabs.create({ windowId, url: firstUrl, active: true });
  for (const url of restUrls) {
    await chrome.tabs.create({ windowId, url, active: false });
  }
}

async function removeTabsSafely(tabIds) {
  for (const tabId of tabIds) {
    try {
      await chrome.tabs.remove(tabId);
    } catch (_error) {
      // The tab may already be closed.
    }
  }
}

async function queryValidTabs() {
  const windows = await chrome.windows.getAll({ populate: true });
  return windows
    .filter((window) => window.type === "normal")
    .flatMap((window) =>
      (window.tabs || [])
        .filter((tab) => isValidUrl(tab.url))
        .sort((a, b) => a.index - b.index)
        .map((tab) => ({
          url: tab.url,
          title: tab.title || tab.url,
          windowId: window.id,
          index: tab.index
        }))
    );
}

async function queryNormalWindows() {
  const windows = await chrome.windows.getAll({ populate: false });
  return windows.filter((window) => window.type === "normal");
}

function isValidUrl(url) {
  if (!url || INVALID_URL_PREFIXES.some((prefix) => url.startsWith(prefix))) {
    return false;
  }

  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:" || parsed.protocol === "file:";
  } catch (_error) {
    return false;
  }
}

function filterValidTabs(tabs) {
  return Array.isArray(tabs) ? tabs.filter((tab) => isValidUrl(tab.url)) : [];
}

function createSignature(tabs) {
  return tabs.map((tab) => tab.url).join("\n");
}

function hasAllTabs(currentTabs, targetTabs) {
  const currentCounts = countByUrl(currentTabs);
  for (const [url, neededCount] of countByUrl(targetTabs)) {
    if ((currentCounts.get(url) || 0) < neededCount) {
      return false;
    }
  }

  return targetTabs.length > 0;
}

function countByUrl(tabs) {
  const counts = new Map();
  for (const tab of tabs) {
    if (!isValidUrl(tab.url)) {
      continue;
    }

    counts.set(tab.url, (counts.get(tab.url) || 0) + 1);
  }

  return counts;
}

async function handleWindowRemovedForAutoRestore() {
  await wait(350);
  const windows = await queryNormalWindows();
  if (!windows.length) {
    await markPendingAutoRestore(true);
  }
}

function markPendingAutoRestore(value) {
  return chrome.storage.session.set({
    [STORAGE_KEYS.pendingAutoRestore]: value
  });
}

async function isPendingAutoRestore() {
  const { [STORAGE_KEYS.pendingAutoRestore]: pendingAutoRestore } =
    await chrome.storage.session.get(STORAGE_KEYS.pendingAutoRestore);
  return Boolean(pendingAutoRestore);
}

async function isRestoreInProgress() {
  const { [STORAGE_KEYS.restoreInProgress]: restoreInProgress } =
    await chrome.storage.session.get(STORAGE_KEYS.restoreInProgress);
  return Boolean(restoreInProgress);
}

function wait(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
