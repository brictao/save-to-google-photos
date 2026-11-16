// ============================================================
// Save to Google Photos — Popup Script
// ============================================================

const statusDot = document.getElementById("statusDot");
const statusText = document.getElementById("statusText");
const statusHint = document.getElementById("statusHint");
const signInBtn = document.getElementById("signInBtn");
const signOutBtn = document.getElementById("signOutBtn");
const saveAllBtn = document.getElementById("saveAllBtn");
const historyList = document.getElementById("historyList");
const clearHistoryBtn = document.getElementById("clearHistoryBtn");
const albumCard = document.getElementById("albumCard");
const albumCurrent = document.getElementById("albumCurrent");
const albumLink = document.getElementById("albumLink");
const albumCreateRow = document.getElementById("albumCreateRow");
const albumTitle = document.getElementById("albumTitle");
const albumCreateBtn = document.getElementById("albumCreateBtn");
const albumUnbindBtn = document.getElementById("albumUnbindBtn");
const albumHint = document.getElementById("albumHint");

let signedIn = false;

const STATUS_LABEL = {
    saved: "Saved",
    failed: "Failed",
    skipped: "Skipped",
};

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
    albumCard.style.display = "flex";
    loadAlbum();
}

function setSignedOut() {
    signedIn = false;
    statusDot.className = "dot offline";
    statusText.textContent = "Not Signed In";
    statusHint.textContent = "Sign in to start saving images.";
    signInBtn.style.display = "flex";
    signOutBtn.style.display = "none";
    saveAllBtn.style.display = "none";
    albumCard.style.display = "none";
}

function setLoading(text) {
    statusDot.className = "dot";
    statusText.textContent = text;
    statusHint.textContent = "";
    signInBtn.style.display = "none";
    signOutBtn.style.display = "none";
    saveAllBtn.style.display = signedIn ? "flex" : "none";
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

// 在页面里打开选择面板，由用户勾选后再保存
async function openPickerFromPopup(button) {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const tab = tabs && tabs[0];
    if (!tab || !tab.id) {
        statusHint.textContent = "No active tab to use.";
        return;
    }

    if (tab.url && !/^https?:/i.test(tab.url)) {
        statusHint.textContent = "This page does not allow extensions to read media.";
        return;
    }

    button.disabled = true;
    const message = { action: "openPicker" };

    try {
        await chrome.tabs.sendMessage(tab.id, message);
    } catch {
        try {
            await chrome.scripting.executeScript({
                target: { tabId: tab.id },
                files: ["content.js"],
            });
            await chrome.tabs.sendMessage(tab.id, message);
        } catch {
            button.disabled = false;
            statusHint.textContent = "Cannot access this page. Try reloading the tab.";
            return;
        }
    }

    window.close();
}

saveAllBtn.addEventListener("click", () => openPickerFromPopup(saveAllBtn));

// --------------------------------------------------
// Album
// --------------------------------------------------
const ALBUM_HINT = "New saves will be added to this album automatically.";

async function loadAlbum() {
    try {
        const response = await sendMessage({ action: "getAlbum" });
        renderAlbum(response.success ? response.album : null);
    } catch {
        renderAlbum(null);
    }
}

function renderAlbum(album) {
    const hasAlbum = Boolean(album && album.id);

    albumCurrent.style.display = hasAlbum ? "block" : "none";
    albumCreateRow.style.display = hasAlbum ? "none" : "flex";
    albumUnbindBtn.style.display = hasAlbum ? "inline" : "none";
    albumHint.className = "album-hint";

    if (!hasAlbum) {
        albumHint.textContent = "Create an album to group everything you save.";
        return;
    }

    albumLink.textContent = album.title || "Album";
    // productUrl 由 Google 返回，缺失时退回相册首页，避免链接不可用
    albumLink.href = album.productUrl || "https://photos.google.com/albums";
    albumHint.textContent = ALBUM_HINT;
}

albumCreateBtn.addEventListener("click", async () => {
    const title = albumTitle.value.trim();
    if (!title) {
        albumHint.textContent = "Enter an album name first.";
        albumHint.className = "album-hint error";
        albumTitle.focus();
        return;
    }

    albumCreateBtn.disabled = true;
    albumCreateBtn.textContent = "Creating…";
    albumHint.textContent = "Creating the album in Google Photos…";
    albumHint.className = "album-hint";

    try {
        const response = await sendMessage({ action: "createAlbum", title });
        if (response.success) {
            albumTitle.value = "";
            renderAlbum(response.album);
        } else {
            albumHint.textContent = response.error || "Could not create the album.";
            albumHint.className = "album-hint error";
        }
    } catch (error) {
        albumHint.textContent = error.message || "Could not create the album.";
        albumHint.className = "album-hint error";
    } finally {
        albumCreateBtn.disabled = false;
        albumCreateBtn.textContent = "Create";
    }
});

albumTitle.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    albumCreateBtn.click();
});

albumUnbindBtn.addEventListener("click", async () => {
    try {
        await sendMessage({ action: "clearAlbum" });
    } catch {
        // ignore errors
    }
    renderAlbum(null);
});

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

checkAuthStatus();
loadHistory();
