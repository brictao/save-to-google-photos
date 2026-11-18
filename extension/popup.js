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
const albumTitle = document.getElementById("albumTitle");
const albumCreateBtn = document.getElementById("albumCreateBtn");
const albumUnbindBtn = document.getElementById("albumUnbindBtn");
const albumHint = document.getElementById("albumHint");
const albumSwitchRow = document.getElementById("albumSwitchRow");
const albumSelect = document.getElementById("albumSelect");
const albumDuplicateBtn = document.getElementById("albumDuplicateBtn");
const albumRestoreToggle = document.getElementById("albumRestoreToggle");
const albumRestoreRow = document.getElementById("albumRestoreRow");
const albumRestoreInput = document.getElementById("albumRestoreInput");
const albumRestoreBtn = document.getElementById("albumRestoreBtn");

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

// 同名拦截后暂存待切换的相册
let duplicateAlbum = null;

function clearDuplicate() {
    duplicateAlbum = null;
    albumDuplicateBtn.style.display = "none";
}

function showDuplicate(existing) {
    duplicateAlbum = existing;
    albumHint.textContent =
        `An album named "${existing.title}" already exists. Switch to it, or use a different name.`;
    albumHint.className = "album-hint error";
    albumDuplicateBtn.textContent = `Switch to "${existing.title}"`;
    albumDuplicateBtn.style.display = "inline";
}

async function loadAlbum() {
    try {
        const response = await sendMessage({ action: "getAlbums" });
        renderAlbum(
            response.success ? response.album : null,
            response.success ? response.albums || [] : []
        );
    } catch {
        renderAlbum(null, []);
    }
}

function renderAlbum(album, albums = []) {
    const hasAlbum = Boolean(album && album.id);
    const list = albums.filter((item) => item && item.id);
    clearDuplicate();

    albumCurrent.style.display = hasAlbum ? "block" : "none";
    albumUnbindBtn.style.display = hasAlbum ? "inline" : "none";
    albumHint.className = "album-hint";

    // 清单里有两个以上时才值得切换；未绑定时也允许从清单里挑一个
    const showSwitch = list.length > 1 || (list.length >= 1 && !hasAlbum);
    albumSwitchRow.style.display = showSwitch ? "block" : "none";
    if (showSwitch) {
        albumSelect.innerHTML = "";
        if (!hasAlbum) {
            const placeholder = document.createElement("option");
            placeholder.value = "";
            placeholder.textContent = "Select an album…";
            albumSelect.appendChild(placeholder);
        }
        for (const item of list) {
            const option = document.createElement("option");
            option.value = item.id;
            option.textContent = item.title || "Album";
            albumSelect.appendChild(option);
        }
        albumSelect.value = hasAlbum ? album.id : "";
    }

    if (!hasAlbum) {
        albumHint.textContent = "Create an album to group everything you save.";
        return;
    }

    albumLink.textContent = album.title || "Album";
    // productUrl 由 Google 返回，缺失时退回相册首页，避免链接不可用
    albumLink.href = album.productUrl || "https://photos.google.com/albums";
    albumHint.textContent = showSwitch
        ? "New saves go to the selected album."
        : ALBUM_HINT;
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
            renderAlbum(response.album, response.albums || []);
        } else if (response.duplicate) {
            showDuplicate(response.existing);
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

albumSelect.addEventListener("change", async () => {
    const albumId = albumSelect.value;
    if (!albumId) return;

    albumSelect.disabled = true;
    try {
        const response = await sendMessage({ action: "selectAlbum", albumId });
        if (response.success) {
            renderAlbum(response.album, response.albums || []);
        } else {
            albumHint.textContent = response.error || "Could not switch album.";
            albumHint.className = "album-hint error";
            loadAlbum();
        }
    } catch (error) {
        albumHint.textContent = error.message || "Could not switch album.";
        albumHint.className = "album-hint error";
        loadAlbum();
    } finally {
        albumSelect.disabled = false;
    }
});

albumDuplicateBtn.addEventListener("click", async () => {
    if (!duplicateAlbum) return;

    albumDuplicateBtn.disabled = true;
    try {
        const response = await sendMessage({
            action: "selectAlbum",
            albumId: duplicateAlbum.id,
        });
        if (response.success) {
            albumTitle.value = "";
            renderAlbum(response.album, response.albums || []);
            albumHint.textContent = `Switched to "${response.album.title}".`;
        } else {
            albumHint.textContent = response.error || "Could not switch album.";
            albumHint.className = "album-hint error";
        }
    } catch (error) {
        albumHint.textContent = error.message || "Could not switch album.";
        albumHint.className = "album-hint error";
    } finally {
        albumDuplicateBtn.disabled = false;
    }
});

// albums.list 已被移除，无法枚举账号里的相册。卸载或换设备后清单会丢，
// 这时用相册链接把旧绑定挂回来，链接里带着 albumId。
function setRestoreOpen(open) {
    albumRestoreRow.style.display = open ? "flex" : "none";
    albumRestoreToggle.textContent = open ? "Hide album link" : "Have an album link?";
    albumRestoreToggle.setAttribute("aria-expanded", open ? "true" : "false");
}

albumRestoreToggle.addEventListener("click", () => {
    const open = albumRestoreRow.style.display === "none";
    setRestoreOpen(open);
    if (open) albumRestoreInput.focus();
});

async function linkAlbumByInput() {
    const input = albumRestoreInput.value.trim();
    if (!input) {
        albumHint.textContent = "Paste the album link first.";
        albumHint.className = "album-hint error";
        albumRestoreInput.focus();
        return;
    }

    albumRestoreBtn.disabled = true;
    albumRestoreBtn.textContent = "Linking…";
    try {
        const response = await sendMessage({ action: "bindAlbum", input });
        if (response.success) {
            albumRestoreInput.value = "";
            setRestoreOpen(false);
            renderAlbum(response.album, response.albums || []);
            albumHint.textContent = response.unverified
                ? "Linked by album ID. Google will confirm it on the next save."
                : `Linked to "${response.album.title}".`;
            albumHint.className = "album-hint";
        } else {
            albumHint.textContent = response.error || "Could not link that album.";
            albumHint.className = "album-hint error";
        }
    } catch (error) {
        albumHint.textContent = error.message || "Could not link that album.";
        albumHint.className = "album-hint error";
    } finally {
        albumRestoreBtn.disabled = false;
        albumRestoreBtn.textContent = "Link";
    }
}

albumRestoreBtn.addEventListener("click", linkAlbumByInput);

albumRestoreInput.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    linkAlbumByInput();
});

albumUnbindBtn.addEventListener("click", async () => {
    try {
        await sendMessage({ action: "clearAlbum" });
    } catch {
        // ignore errors
    }
    loadAlbum();
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
