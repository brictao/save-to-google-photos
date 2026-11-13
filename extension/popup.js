// ============================================================
// Save to Google Photos — Popup Script
// ============================================================

const statusDot = document.getElementById("statusDot");
const statusText = document.getElementById("statusText");
const statusHint = document.getElementById("statusHint");
const signInBtn = document.getElementById("signInBtn");
const signOutBtn = document.getElementById("signOutBtn");
const saveAllBtn = document.getElementById("saveAllBtn");
const saveNoteBtn = document.getElementById("saveNoteBtn");
const historyList = document.getElementById("historyList");
const clearHistoryBtn = document.getElementById("clearHistoryBtn");

let signedIn = false;
// 帖子级保存只对有多图详情页的站点开放，避免在别的站点给出无用入口
let noteSupported = false;

const STATUS_LABEL = {
    saved: "Saved",
    failed: "Failed",
    skipped: "Skipped",
};

// --------------------------------------------------
// 当前标签页是否支持帖子级保存
// --------------------------------------------------
async function detectNoteSite() {
    try {
        const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
        const url = tabs?.[0]?.url || "";
        noteSupported = /(^|\.)xiaohongshu\.com$/i.test(new URL(url).hostname);
    } catch {
        noteSupported = false;
    }
    saveNoteBtn.style.display = signedIn && noteSupported ? "flex" : "none";
}

// --------------------------------------------------
// Check auth status on popup open
// --------------------------------------------------
async function checkAuthStatus() {
    try {
        const response = await sendMessage({
            action: "getAuthToken",
            interactive: false,
        });

        if (response.success && response.token) {
            setSignedIn();
        } else {
            setSignedOut();
        }
    } catch {
        setSignedOut();
    }
}

// --------------------------------------------------
// UI state helpers
// --------------------------------------------------
function setSignedIn() {
    signedIn = true;
    statusDot.className = "dot online";
    statusText.textContent = "Signed In";
    statusHint.textContent = "You're connected to Google Photos.";
    signInBtn.style.display = "none";
    signOutBtn.style.display = "flex";
    saveAllBtn.style.display = "flex";
    saveAllBtn.disabled = false;
    saveNoteBtn.style.display = noteSupported ? "flex" : "none";
    saveNoteBtn.disabled = false;
}

function setSignedOut() {
    signedIn = false;
    statusDot.className = "dot offline";
    statusText.textContent = "Not Signed In";
    statusHint.textContent = "Sign in to start saving images.";
    signInBtn.style.display = "flex";
    signOutBtn.style.display = "none";
    saveAllBtn.style.display = "none";
    saveNoteBtn.style.display = "none";
}

function setLoading(text) {
    statusDot.className = "dot";
    statusText.textContent = text;
    statusHint.textContent = "";
    signInBtn.style.display = "none";
    signOutBtn.style.display = "none";
    saveAllBtn.style.display = signedIn ? "flex" : "none";
    saveNoteBtn.style.display = signedIn && noteSupported ? "flex" : "none";
}

// --------------------------------------------------
// Button handlers
// --------------------------------------------------
signInBtn.addEventListener("click", async () => {
    setLoading("Signing in…");
    try {
        const response = await sendMessage({
            action: "getAuthToken",
            interactive: true,
        });
        if (response.success) {
            setSignedIn();
        } else {
            setSignedOut();
            statusHint.textContent = response.error || "Sign-in failed.";
        }
    } catch {
        setSignedOut();
        statusHint.textContent = "Sign-in failed. Please try again.";
    }
});

signOutBtn.addEventListener("click", async () => {
    setLoading("Signing out…");
    try {
        await sendMessage({ action: "signOut" });
    } catch {
        // ignore errors
    }
    setSignedOut();
});

async function runPopupBatch(button, action, params, loadingText) {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const tab = tabs && tabs[0];
    if (!tab || !tab.id) {
        statusHint.textContent = "No active tab to read images from.";
        return;
    }

    button.disabled = true;
    setLoading(loadingText);

    let title = "Batch finished";
    let hint = "";

    try {
        const response = await sendMessage({ action, tabId: tab.id, ...params });

        if (response.success) {
            const counts = response.counts || {};
            if (!counts.total) {
                title = "Nothing to save";
                hint = "The page did not expose any usable images.";
            } else {
                hint = `${counts.saved || 0} saved, ${counts.skipped || 0} skipped, ${counts.failed || 0} failed.`;
            }
        } else {
            title = "Batch failed";
            hint = response.error || "The page did not expose any usable images.";
        }
    } catch (err) {
        title = "Batch failed";
        hint = err.message || "Please try again.";
    }

    // 批量结束后恢复登录态按钮，否则 Sign Out 会一直是隐藏的
    if (signedIn) {
        setSignedIn();
    } else {
        setSignedOut();
    }
    statusText.textContent = title;
    statusHint.textContent = hint;

    button.disabled = false;
    loadHistory();
}

saveAllBtn.addEventListener("click", () =>
    runPopupBatch(saveAllBtn, "saveAllImages", { limit: 20 }, "Saving images…")
);

saveNoteBtn.addEventListener("click", () =>
    runPopupBatch(saveNoteBtn, "saveNoteImages", {}, "Saving this post…")
);

clearHistoryBtn.addEventListener("click", async () => {
    try {
        await sendMessage({ action: "clearHistory" });
    } catch {
        // ignore errors
    }
    loadHistory();
});

// --------------------------------------------------
// History
// --------------------------------------------------
async function loadHistory() {
    try {
        const response = await sendMessage({ action: "getHistory" });
        renderHistory(response.success ? response.items : []);
    } catch {
        renderHistory([]);
    }
}

function renderHistory(items) {
    historyList.innerHTML = "";

    if (!items || !items.length) {
        const empty = document.createElement("li");
        empty.className = "history-empty";
        empty.textContent = "No recent saves.";
        historyList.appendChild(empty);
        return;
    }

    for (const item of items) {
        const row = document.createElement("li");
        row.className = `history-item status-${item.status || "saved"}`;

        const name = document.createElement("div");
        name.className = "history-name";
        name.textContent = item.name || item.url || "Unknown file";

        const meta = document.createElement("div");
        meta.className = "history-meta";
        const label = STATUS_LABEL[item.status] || "Saved";
        const detail = item.message ? ` · ${item.message}` : "";
        meta.textContent = `${label} · ${timeAgo(item.time)}${detail}`;

        row.append(name, meta);
        historyList.appendChild(row);
    }
}

function timeAgo(timestamp) {
    if (!timestamp) return "just now";
    const diff = Date.now() - timestamp;
    if (diff < 60000) return "just now";
    if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
    if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
    return `${Math.floor(diff / 86400000)}d ago`;
}

// --------------------------------------------------
// Messaging helper
// --------------------------------------------------
function sendMessage(msg) {
    return new Promise((resolve, reject) => {
        chrome.runtime.sendMessage(msg, (response) => {
            if (chrome.runtime.lastError) {
                reject(new Error(chrome.runtime.lastError.message));
            } else {
                resolve(response);
            }
        });
    });
}

// --------------------------------------------------
// Init
// --------------------------------------------------
// 每次打开 popup 都让 background 重建一次右键菜单。菜单只在安装和浏览器
// 启动时注册，漏注册时用户可以靠打开 popup 自愈，不必重装扩展。
sendMessage({ action: "ensureMenus" }).catch(() => {});

detectNoteSite();
checkAuthStatus();
loadHistory();
