// ============================================================
// Save to Google Photos — Background Service Worker
// ============================================================

importScripts("motion-photo.js");

const GOOGLE_PHOTOS_UPLOAD_URL =
  "https://photoslibrary.googleapis.com/v1/uploads";
const GOOGLE_PHOTOS_BATCH_CREATE_URL =
  "https://photoslibrary.googleapis.com/v1/mediaItems:batchCreate";
const GOOGLE_PHOTOS_ALBUMS_URL = "https://photoslibrary.googleapis.com/v1/albums";
// albums.list 在 2025 年 3 月的 API 收缩中移除，无法枚举 Google Photos
// 里的已有相册。只能记录本扩展创建过的相册，供绑定切换使用。
// 绑定和清单存 chrome.storage.sync，多设备或重装后有机会恢复。Chrome 在
// 卸载扩展时会把扩展数据一起清掉，所以 sync 不能当备份。清单丢失后可以用
// 相册链接重新绑定，见 bindAlbum。
const ALBUM_KEY = "sgp_album";
const ALBUM_LIST_KEY = "sgp_albums";
// sync 单键上限 8KB，清单只存必要字段并截断标题，20 条留足余量
const ALBUM_LIST_MAX = 20;
// albums.batchAddMediaItems 单次上限 50 项，单个相册上限 20000 项
const ALBUM_ADD_CHUNK = 50;
const ALBUM_MAX_ITEMS = 20000;
const CONTEXT_MENU_ID = "save-to-google-photos";
// 覆盖层兜底入口。小红书、Instagram 会在图片上叠链接和渐变遮罩，右键
// 落点被判定为普通页面时 image 菜单不会出现，这类站点用坐标反查补一个入口。
const CONTEXT_MENU_FALLBACK_ID = "save-to-google-photos-at-cursor";
const COVER_SITE_PATTERNS_KEY = "sgp_cover_sites";
const DEFAULT_COVER_SITE_PATTERNS = [
  "*://*.xiaohongshu.com/*",
  "*://*.instagram.com/*",
];

// Google Photos 单文件上限按官方口径 200 MB，超限只会由 API 侧失败，
// 提前在本地拦下来可以给出可操作的提示。
const MAX_UPLOAD_BYTES = 200 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 120000;

const HISTORY_KEY = "sgp_history";
const SEEN_KEY = "sgp_seen";
const HISTORY_MAX = 100;
const SEEN_MAX = 500;

const ALLOWED_IMAGE = /^image\/(jpeg|jpg|png|webp|heic|heif|gif)$/i;
const ALLOWED_VIDEO = /^video\/(mp4|quicktime|x-m4v)$/i;

const MIME_BY_EXT = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  heic: "image/heic",
  heif: "image/heif",
  gif: "image/gif",
  avif: "image/avif",
  mp4: "video/mp4",
  m4v: "video/x-m4v",
  mov: "video/quicktime",
  webm: "video/webm",
};

// --------------------------------------------------
// 1. Context Menu
// --------------------------------------------------
function buildContextMenus(patterns) {
  chrome.contextMenus.removeAll(() => {
    void chrome.runtime.lastError;

    // 图片和视频上右键走精确入口，标题会按右键目标动态变化
    chrome.contextMenus.create(
      {
        id: CONTEXT_MENU_ID,
        title: "Save to Google Photos",
        contexts: ["image", "video"],
      },
      () => void chrome.runtime.lastError
    );

    if (!Array.isArray(patterns) || !patterns.length) return;

    // 只在配置的站点出现，并排除 image / video，避免同一张图上出现两个入口
    chrome.contextMenus.create(
      {
        id: CONTEXT_MENU_FALLBACK_ID,
        title: "Save image under cursor to Google Photos",
        contexts: ["page", "link", "selection", "frame"],
        documentUrlPatterns: patterns,
      },
      () => void chrome.runtime.lastError
    );
  });
}

async function registerContextMenus() {
  const stored = await storageGet(COVER_SITE_PATTERNS_KEY);
  const patterns =
    Array.isArray(stored) && stored.length ? stored : DEFAULT_COVER_SITE_PATTERNS;
  buildContextMenus(patterns);
}

chrome.runtime.onInstalled.addListener(() => {
  void registerContextMenus();
});

// 浏览器重启后菜单可能丢失，启动时补注册一次
chrome.runtime.onStartup.addListener(() => {
  void registerContextMenus();
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === CONTEXT_MENU_FALLBACK_ID) {
    await handleSaveAtCursor(tab);
    return;
  }
  if (info.menuItemId !== CONTEXT_MENU_ID) return;
  await handleSave(tab, info.srcUrl, info.mediaType);
});

// 切换标签页时把标题恢复默认，避免残留上一个页面的文案
chrome.tabs.onActivated.addListener(() => {
  chrome.contextMenus.update(CONTEXT_MENU_ID, { title: "Save to Google Photos" }, () => {
    void chrome.runtime.lastError;
  });
});

// Apple 原生 Live Photo 固定 3 秒，第三方转换工具一般不超过 5 秒。
// 超过这个上限的视频按原文件保存，避免把整段视频拼成 Motion Photo。
const MAX_LIVE_PHOTO_SECONDS = 10;

async function handleSave(tab, srcUrl, mediaType) {
  const tabId = tab?.id;
  if (!srcUrl && mediaType !== "video") {
    showToast(tabId, "error", "Error", "Could not determine the clicked URL.");
    return;
  }

  // 先确认页面上有没有 Live Photo 配对，再决定走合成还是普通上传
  const ctx = await requestContextPair(tabId);

  // 右键的是视频，时长明显超出 Live Photo 的范围：优先按视频原文件保存
  if (mediaType === "video" && isLongVideo(ctx?.videoDuration)) {
    await handleSingleMedia(tabId, srcUrl || ctx?.videoUrl, "video");
    return;
  }

  if (ctx && ctx.found && ctx.videoUrl) {
    await handleLivePhoto(tab, srcUrl, mediaType, ctx);
    return;
  }

  await handleSingleMedia(tabId, srcUrl, mediaType === "video" ? "video" : "image");
}

// 时长未知时不擅自改判，保持原来的封面对齐逻辑
function isLongVideo(seconds) {
  return Number.isFinite(seconds) && seconds > MAX_LIVE_PHOTO_SECONDS;
}

// 覆盖层站点：按右键坐标反查媒体元素，支持图片、视频以及页面组件自带的 Live Photo 配对
async function handleSaveAtCursor(tab) {
  const tabId = tab?.id;
  const target = await requestAtCursor(tabId);

  if (!target || !target.ok) {
    showToast(
      tabId,
      "error",
      "No image found",
      target?.reason || "Nothing saveable was under the cursor."
    );
    return;
  }

  if (target.kind === "video") {
    if (!isLongVideo(target.videoDuration) && target.livePhoto?.found && target.livePhoto.videoUrl) {
      await handleLivePhoto(tab, target.url, "video", target.livePhoto);
      return;
    }
    await handleSingleMedia(tabId, target.url, "video");
    return;
  }

  if (target.livePhoto?.found && target.livePhoto.videoUrl && !isLongVideo(target.livePhoto.videoDuration)) {
    await handleLivePhoto(tab, target.url, "image", target.livePhoto);
    return;
  }

  await saveWithCandidates(
    tabId,
    {
      url: target.url,
      candidates: target.candidates || [target.url],
    },
    { quiet: false }
  );
}

function sendToTabWithInject(tabId, message) {
  return chrome.tabs.sendMessage(tabId, message).catch(() =>
    chrome.scripting
      .executeScript({ target: { tabId }, files: ["content.js"] })
      .then(() => chrome.tabs.sendMessage(tabId, message))
  );
}

function requestAtCursor(tabId) {
  return sendToTabWithInject(tabId, { action: "resolveAtCursor" }).catch(() => null);
}

// --------------------------------------------------
// 2. 普通媒体：图片或视频，不再要求配对
// --------------------------------------------------
async function handleSingleMedia(tabId, url, kind) {
  const result = await saveOne(tabId, url, kind);
  return result;
}

// 返回 "saved" | "skipped" | "failed"
async function saveOne(tabId, url, kind, options = {}) {
  const label = kind === "video" ? "video" : "image";
  const quiet = options.quiet === true;
  const quietFailure = options.quietFailure === true;

  try {
    if (!quiet) {
      showToast(tabId, "loading", `Saving ${label}…`, "Reading the file from this page.");
    }

    const media = await downloadMedia(tabId, url, kind, (received, total) => {
      if (quiet) return;
      const detail =
        total > 0
          ? `${formatBytes(received)} of ${formatBytes(total)} (${Math.round((received / total) * 100)}%)`
          : `${formatBytes(received)} downloaded`;
      showToast(tabId, "loading", `Downloading ${label}…`, detail);
    });

    assertUploadable(media, kind);

    const fp = fingerprint(url, media.size);
    if (await isSeen(fp)) {
      await addHistory({
        status: "skipped",
        kind,
        name: media.fileName,
        url: shortUrl(url),
        message: "Already uploaded from this source.",
      });
      if (!quiet) {
        showToast(
          tabId,
          "success",
          "Already saved",
          "This file was uploaded before, skipped to avoid a duplicate."
        );
      }
      return "skipped";
    }

    if (!quiet) {
      showToast(
        tabId,
        "loading",
        `Uploading ${formatBytes(media.size)}…`,
        `Saving ${label} to Google Photos…`
      );
    }

    // 批量模式由 runBatch 传入共享数组，单张模式在这里自己归入相册
    const albumIds = Array.isArray(options.albumIds) ? options.albumIds : [];
    const ownsAlbum = !Array.isArray(options.albumIds);

    const mediaItemId = await withAuthRetry(async (token) => {
      const uploadToken = await uploadBytes(token, media.blob, media.mimeType, media.fileName);
      return createMediaItem(token, uploadToken, media.fileName, url);
    });
    if (mediaItemId) albumIds.push(mediaItemId);

    await markSeen(fp);

    let albumNote = "";
    if (ownsAlbum) {
      const archived = await archiveToAlbum(albumIds);
      if (archived.error) albumNote = ` · ${archived.error}`;
      else if (archived.added) albumNote = ` · added to "${archived.albumTitle}"`;
    }

    await addHistory({
      status: "saved",
      kind,
      name: media.fileName,
      url: shortUrl(url),
      message: formatBytes(media.size) + albumNote,
    });

    if (!quiet) {
      showToast(
        tabId,
        "success",
        "Saved!",
        `${label === "video" ? "Video" : "Image"} saved to Google Photos (${formatBytes(media.size)})${albumNote}`
      );
    }
    return "saved";
  } catch (err) {
    console.error("[Save to Google Photos]", kind, err);
    const message = err.message || String(err);
    if (!options.suppressFailureHistory) {
      await addHistory({
        status: "failed",
        kind,
        name: "",
        url: shortUrl(url),
        message,
      });
    }
    if (!quiet && !quietFailure) {
      showToast(tabId, "error", "Save Failed", message);
    }
    // 失败时补一条系统通知，用户切走标签页也能看到原因。
    // 批量模式下只在最后汇总一条，避免 20 张图弹 20 条。
    if (!quiet && !quietFailure) {
      await notifyFailureWhenHidden(tabId, `Could not save ${label}`, message);
    }
    return "failed";
  }
}

// --------------------------------------------------
// 3. Auth helpers
// --------------------------------------------------
function getAuthToken(interactive = false) {
  return new Promise((resolve, reject) => {
    chrome.identity.getAuthToken({ interactive }, (token) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else if (!token) {
        reject(new Error("No auth token received. Please sign in first."));
      } else {
        resolve(token);
      }
    });
  });
}

function invalidateToken(token) {
  return new Promise((resolve) => {
    chrome.identity.removeCachedAuthToken({ token }, () => {
      void chrome.runtime.lastError;
      resolve();
    });
  });
}

// identity 返回的是缓存 token，有效期约一小时。过期后 uploads 会返回 401，
// 这里清掉缓存再取一次并重跑任务，用户不必手动退出登录。
async function withAuthRetry(task) {
  const token = await getAuthToken(true);
  try {
    return await task(token);
  } catch (err) {
    if (!isAuthError(err)) throw err;
    await invalidateToken(token);
    return task(await getAuthToken(true));
  }
}

function isAuthError(err) {
  if (!err) return false;
  if (err.status === 401) return true;
  return err.status === 403 && /credential|token|auth/i.test(err.detail || "");
}

function httpError(label, response, text) {
  const detail = (text || "").slice(0, 300);
  const err = new Error(
    detail
      ? `${label} failed (HTTP ${response.status}): ${detail}`
      : `${label} failed (HTTP ${response.status})`
  );
  err.status = response.status;
  err.detail = detail;
  return err;
}

// Google 的 description 上限是 1000 字符。带签名参数的 CDN 地址经常超过这个长度，
// 整条 batchCreate 会直接失败。只保留 host 和路径，同时避免把临时凭据写进照片描述。
const DESCRIPTION_MAX = 1000;

function buildDescription(sourceUrl) {
  if (!sourceUrl) return "";
  let clean = sourceUrl;
  try {
    const parsed = new URL(sourceUrl);
    clean = `${parsed.origin}${parsed.pathname}`;
  } catch {
    // 非法 URL 原样使用
  }
  return clean.slice(0, DESCRIPTION_MAX);
}

// --------------------------------------------------
// 4. Download：带进度，失败时回退到页面上下文
// --------------------------------------------------
async function downloadMedia(tabId, url, kind, onProgress) {
  assertImageUrl(url);
  assertFetchable(url, kind === "video" ? "video" : "image");

  let bytes;
  let mimeType = "";

  try {
    const result = await fetchWithProgress(url, onProgress);
    bytes = result.bytes;
    mimeType = result.mimeType;
  } catch (err) {
    if (err.tooLarge) throw err;
    // 防盗链站点会按 Referer 拒绝扩展进程，页面上下文带着同源 Referer 往往能拿到
    console.warn("[Save to Google Photos] 直接下载失败，回退页面上下文", url, err.message);
    const fallback = await fetchViaPage(tabId, url);
    bytes = fallback.bytes;
    mimeType = fallback.mimeType;
  }

  mimeType = normalizeMime(mimeType, url, kind);
  const size = bytes.byteLength;
  const fileName = buildFileName(url, mimeType, kind);
  const blob = new Blob([bytes], { type: mimeType });

  return { blob, bytes, mimeType, size, fileName };
}

function tooLargeError(size) {
  const err = new Error(
    `This file is ${formatBytes(size)}, above the ${formatBytes(MAX_UPLOAD_BYTES)} Google Photos upload limit.`
  );
  err.tooLarge = true;
  return err;
}

async function fetchWithProgress(url, onProgress) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);

  let response;
  try {
    response = await fetch(url, { signal: controller.signal, redirect: "follow" });
  } catch (err) {
    clearTimeout(timer);
    if (err.name === "AbortError") {
      const timeout = new Error(
        `Download timed out after ${Math.round(DOWNLOAD_TIMEOUT_MS / 1000)}s: ${shortUrl(url)}`
      );
      timeout.downloadFailed = true;
      throw timeout;
    }
    const failure = new Error(
      "Could not download this file. The site may block direct downloads."
    );
    failure.downloadFailed = true;
    throw failure;
  }

  if (!response.ok) {
    clearTimeout(timer);
    const err = new Error(
      `Could not download this file (HTTP ${response.status}). The site may block direct downloads.`
    );
    err.status = response.status;
    err.downloadFailed = true;
    throw err;
  }

  const mimeType = normalizeContentType(response.headers.get("content-type"));
  const total = Number(response.headers.get("content-length")) || 0;
  if (total > MAX_UPLOAD_BYTES) {
    clearTimeout(timer);
    controller.abort();
    throw tooLargeError(total);
  }

  let bytes;
  if (!response.body) {
    try {
      bytes = new Uint8Array(await response.arrayBuffer());
    } finally {
      clearTimeout(timer);
    }
    if (bytes.byteLength > MAX_UPLOAD_BYTES) {
      throw tooLargeError(bytes.byteLength);
    }
  } else {
    const reader = response.body.getReader();
    const chunks = [];
    let received = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        received += value.length;
        if (received > MAX_UPLOAD_BYTES) {
          controller.abort();
          throw tooLargeError(received);
        }
        chunks.push(value);
        onProgress?.(received, total);
      }
    } finally {
      clearTimeout(timer);
    }
    bytes = new Uint8Array(received);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
  }

  return { bytes, mimeType };
}

// 页面上下文抓字节：content script 的请求由页面发出，会带上站点需要的 Referer
async function fetchViaPage(tabId, url) {
  if (!tabId) {
    const err = new Error("The file could not be downloaded and there is no page available to retry from.");
    err.downloadFailed = true;
    throw err;
  }

  let response;
  try {
    response = await chrome.tabs.sendMessage(tabId, { action: "fetchAsBase64", url });
  } catch {
    const err = new Error("The file could not be downloaded, and the page could not be reached to retry.");
    err.downloadFailed = true;
    throw err;
  }

  if (!response || !response.ok) {
    const err = new Error(
      response?.error
        ? `Could not download this file: ${response.error}`
        : "Could not download this file, even from the page context."
    );
    err.downloadFailed = true;
    throw err;
  }

  const bytes = base64ToBytes(response.base64);
  return { bytes, mimeType: response.mimeType || "" };
}

function base64ToBytes(base64) {
  const binary = atob(base64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

function normalizeContentType(value) {
  return String(value || "").split(";")[0].trim().toLowerCase();
}

// Content-Type 缺失或被站点写成 application/octet-stream 时，按扩展名补
function normalizeMime(mimeType, url, kind) {
  const clean = normalizeContentType(mimeType);
  if (clean && (clean.startsWith("image/") || clean.startsWith("video/"))) {
    return clean;
  }
  const ext = extensionOf(url);
  if (ext && MIME_BY_EXT[ext]) return MIME_BY_EXT[ext];
  return kind === "video" ? "video/mp4" : "image/jpeg";
}

function extensionOf(url) {
  try {
    const pathname = new URL(url).pathname;
    const match = pathname.match(/\.([a-z0-9]{2,5})$/i);
    return match ? match[1].toLowerCase() : "";
  } catch {
    return "";
  }
}

function buildFileName(url, mimeType, kind) {
  const ext = extensionOf(url) || extFromMime(mimeType) || (kind === "video" ? "mp4" : "jpg");
  const usable = sanitizeAsciiBase(url) || `photo_${Date.now()}`;
  return `${usable}.${ext}`;
}

function sanitizeAsciiBase(url) {
  let base = "";
  try {
    const last = new URL(url).pathname.split("/").filter(Boolean).pop();
    if (last) base = safeDecode(last.split("?")[0].replace(/\.[^.]+$/, ""));
  } catch {
    // 忽略，走默认名
  }

  // X-Goog-Upload-File-Name 只接受 ASCII，中文文件名会让 fetch 直接抛错
  const ascii = base.replace(/[^\x20-\x7E]/g, "").replace(/["\\/:*?<>|]/g, "_").trim();
  return /[a-zA-Z0-9]/.test(ascii) ? ascii.slice(0, 120) : "";
}

function safeDecode(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function extFromMime(mimeType) {
  const entry = Object.entries(MIME_BY_EXT).find(([, mime]) => mime === mimeType);
  return entry ? entry[0] : "";
}

// blob: 地址属于页面上下文，扩展进程拿不到原始字节。提前说明原因，
// 避免用户看到 HTTP 0 这类无从下手的信息。
function assertImageUrl(url) {
  if (/^blob:/i.test(url)) {
    throw new Error(
      "This image is rendered from a blob URL, so its original file cannot be read. Try saving another image on this page."
    );
  }
}

function assertFetchable(url, label) {
  // blob: 只对创建它的页面有效。扩展进程读不到，页面上下文可以尝试，
  // 所以不在这里直接拒绝，交给 fetchBytes 走页面回退。
  if (/\.m3u8(\?|$)/i.test(url)) {
    throw new Error(
      `The ${label} is an HLS stream, so the extension cannot download the full file.`
    );
  }
}

// 大小与格式前置校验：把 API 侧的失败提前成本地可读的提示
function assertUploadable(media, kind) {
  if (!media.size) {
    throw new Error("The downloaded file is empty, so there is nothing to upload.");
  }
  if (media.size > MAX_UPLOAD_BYTES) {
    throw new Error(
      `This file is ${formatBytes(media.size)}, above the ${formatBytes(MAX_UPLOAD_BYTES)} Google Photos upload limit.`
    );
  }

  const allowed = kind === "video" ? ALLOWED_VIDEO : ALLOWED_IMAGE;
  if (!allowed.test(media.mimeType)) {
    throw new Error(
      `Unsupported ${kind} format: ${media.mimeType || "unknown"}. ${
        kind === "video"
          ? "Google Photos accepts MP4 and MOV."
          : "Google Photos accepts JPEG, PNG, WebP, HEIC and GIF."
      }`
    );
  }
}

// --------------------------------------------------
// 5. Upload bytes (Step 1 of Google Photos upload)
// --------------------------------------------------
async function uploadBytes(token, blob, mimeType, fileName) {
  const response = await fetch(GOOGLE_PHOTOS_UPLOAD_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/octet-stream",
      "X-Goog-Upload-Content-Type": mimeType,
      "X-Goog-Upload-File-Name": fileName,
      "X-Goog-Upload-Protocol": "raw",
    },
    body: blob,
  });

  if (!response.ok) {
    throw httpError("Upload", response, await response.text());
  }

  const uploadToken = await response.text();
  return uploadToken;
}

// --------------------------------------------------
// 6. Create media item (Step 2 of Google Photos upload)
// --------------------------------------------------
async function createMediaItem(token, uploadToken, fileName, sourceUrl) {
  const body = {
    newMediaItems: [
      {
        description: buildDescription(sourceUrl),
        simpleMediaItem: {
          uploadToken,
          fileName,
        },
      },
    ],
  };

  const response = await fetch(GOOGLE_PHOTOS_BATCH_CREATE_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw httpError("Create media item", response, await response.text());
  }

  const result = await response.json();

  // Check per-item status
  const item = result.newMediaItemResults?.[0];
  if (item?.status?.message && item.status.message !== "Success") {
    throw new Error(`Media item error: ${item.status.message}`);
  }

  // 归入相册需要 mediaItem id，顺便把上传结果里的 id 带出去
  return item?.mediaItem?.id || "";
}

// --------------------------------------------------
// 6b. 相册：创建、绑定、把已上传的项归入相册
// --------------------------------------------------
// 相册绑定与清单存在 chrome.storage.sync，换设备和卸载重装后能恢复。
// 个别环境（例如 Edge 未登录同步账号）的回调可能一直不触发。消息处理必须
// 给出响应，否则 popup 会收到 "The message port closed" 而看不到真实原因。
const SYNC_TIMEOUT_MS = 4000;
const ALBUM_META_TIMEOUT_MS = 8000;

function withTimeout(promise, ms, fallback) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(fallback), ms);
    Promise.resolve(promise).then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

function syncGet(key) {
  return new Promise((resolve) => {
    const sync = chrome.storage?.sync;
    if (!sync) return resolve(undefined);
    const timer = setTimeout(() => resolve(undefined), SYNC_TIMEOUT_MS);
    sync.get(key, (data) => {
      clearTimeout(timer);
      resolve(data ? data[key] : undefined);
    });
  });
}

function syncSet(key, value) {
  return new Promise((resolve) => {
    const sync = chrome.storage?.sync;
    if (!sync) return resolve();
    const timer = setTimeout(() => resolve(), SYNC_TIMEOUT_MS);
    sync.set({ [key]: value }, () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

// sync 读不到时回退 local，兼容 1.3 及更早写在本地的数据。
async function albumRead(key) {
  const value = await syncGet(key);
  if (value !== undefined && value !== null) return value;
  return storageGet(key);
}

// 1.3 及更早把绑定和清单存在 local，首次读取时搬到 sync 并清掉旧值。
async function migrateAlbumStorage() {
  const localAlbum = await storageGet(ALBUM_KEY);
  const localList = await storageGet(ALBUM_LIST_KEY);
  const hasLegacy =
    Boolean(localAlbum && localAlbum.id) ||
    (Array.isArray(localList) && localList.length > 0);
  if (!hasLegacy) return;

  const syncAlbum = await syncGet(ALBUM_KEY);
  if ((syncAlbum === undefined || syncAlbum === null) && localAlbum && localAlbum.id) {
    await syncSet(ALBUM_KEY, localAlbum);
  }

  const syncList = await syncGet(ALBUM_LIST_KEY);
  if (
    (!Array.isArray(syncList) || !syncList.length) &&
    Array.isArray(localList) &&
    localList.length
  ) {
    await syncSet(ALBUM_LIST_KEY, localList.slice(0, ALBUM_LIST_MAX));
  }

  await storageSet(ALBUM_KEY, null);
  await storageSet(ALBUM_LIST_KEY, null);
}

async function getAlbumSetting() {
  const value = await albumRead(ALBUM_KEY);
  if (!value || typeof value.id !== "string" || !value.id) return null;
  return value;
}

function setAlbumSetting(album) {
  return syncSet(ALBUM_KEY, album);
}

function clearAlbumSetting() {
  return syncSet(ALBUM_KEY, null);
}

// 相册清单：albums.list 已移除，这里只保存本扩展创建过的相册。
async function getAlbumList() {
  const value = await albumRead(ALBUM_LIST_KEY);
  if (!Array.isArray(value)) return [];
  return value
    .filter((album) => album && typeof album.id === "string" && album.id)
    .map((album) => ({
      ...album,
      title: album.title || "Album",
      // 清单不存 productUrl，按 id 重建，省下 sync 配额
      productUrl: album.productUrl || `https://photos.google.com/album/${album.id}`,
    }));
}

function setAlbumList(list) {
  return syncSet(ALBUM_LIST_KEY, list.slice(0, ALBUM_LIST_MAX));
}

// 新增或更新一条，最近使用的排在最前
async function rememberAlbum(album) {
  const list = await getAlbumList();
  const index = list.findIndex((item) => item.id === album.id);
  const entry = {
    id: album.id,
    // 标题只保留展示需要的长度，避免长名字吃掉 sync 配额
    title: String(album.title || "Album").slice(0, 40),
    itemCount: album.itemCount || 0,
    createdAt: index >= 0 ? list[index].createdAt : Date.now(),
  };
  if (index >= 0) list[index] = entry;
  else list.unshift(entry);
  await setAlbumList(list);
  return entry;
}

async function forgetAlbum(albumId) {
  const list = await getAlbumList();
  await setAlbumList(list.filter((item) => item.id !== albumId));
}

// 1.3 及更早只存了单个绑定，升级后把它补进清单，避免清单为空。
async function ensureAlbumList() {
  await migrateAlbumStorage();
  const list = await getAlbumList();
  if (list.length) return list;
  const current = await getAlbumSetting();
  if (!current) return [];
  await rememberAlbum(current);
  return getAlbumList();
}

// 相册链接形如 https://photos.google.com/album/<id>，也可能带 /u/0/ 前缀
// 或 ?key= 之类的分享参数。分享链接是 /share/<id>，id 与接口里的相册 id
// 相同。这里只取路径里的 id，也接受直接粘贴 id。
function parseAlbumId(input) {
  const raw = String(input || "").trim();
  if (!raw) return "";
  const match = raw.match(
    /photos\.google\.com\/(?:u\/\d+\/)?(?:album|share)\/([A-Za-z0-9_-]+)/i
  );
  if (match) return match[1];
  if (/^[A-Za-z0-9_-]{16,}$/.test(raw)) return raw;
  return "";
}

// 相册页面的标签标题通常是 "旅行 - Google 相册" 或 "Trips - Google Photos"。
// 去掉浏览器附加的站点后缀，只留相册名。
function cleanAlbumTitle(raw) {
  const title = String(raw || "").trim();
  if (!title) return "";
  const cleaned = title
    .replace(/\s+[-–—]\s+Google\s*(Photos|相册|相簿|相冊)?\s*$/i, "")
    .trim();
  if (!cleaned || /^Google\s*(Photos|相册|相簿|相冊)?$/i.test(cleaned)) return "";
  return cleaned.slice(0, 40);
}

// albums.get 已下线，拿不到相册标题。用户粘贴链接时相册页通常还开着，
// 从标签页标题推断；读不到就保持占位名称。
async function inferAlbumTitle(albumId) {
  const api = chrome.tabs;
  if (!api || typeof api.query !== "function") return "";
  const tabs = await withTimeout(
    new Promise((resolve) => {
      try {
        api.query({ url: "https://photos.google.com/*" }, (items) => resolve(items || []));
      } catch {
        resolve([]);
      }
    }),
    2000,
    []
  );
  for (const tab of tabs) {
    const url = String(tab?.url || "");
    if (!url.includes(albumId)) continue;
    const title = cleanAlbumTitle(tab.title);
    if (title) return title;
  }
  return "";
}

// albums.get 不一定对所有账号可用。读到元数据就顺手拿到标题和可写状态，
// 读不到时按 id 直接绑定，真正的写入校验留给保存时的 batchAddMediaItems。
async function readAlbumMeta(token, albumId) {
  const response = await fetch(
    `${GOOGLE_PHOTOS_ALBUMS_URL}/${encodeURIComponent(albumId)}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!response.ok) {
    throw httpError("Read album", response, await response.text());
  }
  return response.json();
}

async function createAlbum(token, title) {
  const response = await fetch(GOOGLE_PHOTOS_ALBUMS_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ album: { title } }),
  });

  if (!response.ok) {
    throw httpError("Create album", response, await response.text());
  }

  const album = await response.json();
  if (!album?.id) {
    throw new Error("Google Photos returned an album without an id.");
  }
  // 只读相册无法再写入，提前失败比每张图都归组失败更好说明问题
  if (album.isWriteable === false) {
    throw new Error("Google Photos created this album as read-only, so grouping would fail.");
  }

  return {
    id: album.id,
    title: album.title || title,
    productUrl: album.productUrl || "",
    itemCount: 0,
  };
}

async function addMediaItemsToAlbum(token, albumId, mediaItemIds) {
  const ids = (mediaItemIds || []).filter(Boolean).slice(0, ALBUM_ADD_CHUNK);
  if (!ids.length) return;

  const response = await fetch(
    `${GOOGLE_PHOTOS_ALBUMS_URL}/${encodeURIComponent(albumId)}:batchAddMediaItems`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ mediaItemIds: ids }),
    }
  );

  if (!response.ok) {
    throw httpError("Add to album", response, await response.text());
  }
}

function isAlbumGone(err) {
  return err?.status === 404;
}

// 归档是保存之外的附加动作：失败只影响归类，已上传的图片仍然算保存成功。
async function archiveToAlbum(mediaItemIds) {
  const ids = (mediaItemIds || []).filter(Boolean);
  if (!ids.length) return { added: 0, albumTitle: "", error: "" };

  const album = await getAlbumSetting();
  if (!album) return { added: 0, albumTitle: "", error: "" };

  try {
    await withAuthRetry(async (token) => {
      for (let i = 0; i < ids.length; i += ALBUM_ADD_CHUNK) {
        await addMediaItemsToAlbum(token, album.id, ids.slice(i, i + ALBUM_ADD_CHUNK));
      }
    });
  } catch (err) {
    console.error("[Save to Google Photos] Album", err);
    if (isAlbumGone(err)) {
      // 相册被用户删掉后 id 会一直失效，清掉绑定并移出清单，避免后续每张都报错
      await clearAlbumSetting();
      await forgetAlbum(album.id);
      return {
        added: 0,
        albumTitle: "",
        error: `Album "${album.title}" no longer exists, files went to the library only.`,
        cleared: true,
      };
    }
    return {
      added: 0,
      albumTitle: "",
      error: `Could not add to album: ${err.message || err}`,
    };
  }

  const total = (album.itemCount || 0) + ids.length;
  const updated = { ...album, itemCount: total };
  await setAlbumSetting(updated);
  await rememberAlbum(updated);

  const overflow =
    total > ALBUM_MAX_ITEMS
      ? ` Album may exceed the ${ALBUM_MAX_ITEMS}-item limit soon.`
      : "";

  return { added: ids.length, albumTitle: album.title, error: "", warning: overflow };
}

// --------------------------------------------------
// 7. Live Photo：找配套视频并合成 Motion Photo
// --------------------------------------------------
async function handleLivePhoto(tab, srcUrl, mediaType, ctx, options = {}) {
  const tabId = tab?.id;
  const quiet = options.quiet === true;
  const report = (...args) => { if (!quiet) showToast(...args); };
  // 视频元素可能没有 src，地址在页面组件数据里，此时交给 content 解析
  if (!srcUrl && mediaType !== "video") {
    report(tabId, "error", "Error", "Could not determine the clicked URL.");
    return "failed";
  }

  const fallbackCover = ctx?.imageUrl || (mediaType !== "video" && isHttpUrl(srcUrl) ? srcUrl : "");

  try {
    report(tabId, "loading", "Looking for the pair…", "Checking this page for the matching photo or video.");

    // 1) 确定主图与动态段，两个入口共用后续流程
    let pair;
    try {
      pair = await resolveLivePhotoPair(tabId, srcUrl, mediaType, ctx);
    } catch (err) {
      // 动态段是 blob 且页面也读不到时，封面通常仍然可用，退回只保存封面
      if (isCoverFallbackError(err, fallbackCover)) {
        report(
          tabId,
          "loading",
          "Saving cover only…",
          "The motion clip could not be read, so the cover image is saved instead."
        );
        return saveOne(tabId, fallbackCover, "image", {
          quiet,
          albumIds: options.albumIds,
        });
      }
      throw err;
    }

    // 2) 下载主图、必要时转成 JPEG，再合成
    report(tabId, "loading", "Building Live Photo…", "Merging photo and motion into one file.");
    const photo = await fetchBytes(pair.imageUrl, tabId, (received, total) => {
      const detail =
        total > 0
          ? `${formatBytes(received)} of ${formatBytes(total)} (${Math.round((received / total) * 100)}%)`
          : `${formatBytes(received)} downloaded`;
      report(tabId, "loading", "Downloading cover image…", detail);
    });
    const jpegBytes = await ensureJpeg(photo.bytes, pair.imageUrl, tabId);
    const videoBytes = pair.videoBytes instanceof Uint8Array
      ? pair.videoBytes
      : new Uint8Array(pair.videoBytes);
    const estimatedTotal = jpegBytes.byteLength + videoBytes.byteLength;
    if (estimatedTotal > MAX_UPLOAD_BYTES) {
      throw tooLargeError(estimatedTotal);
    }
    const result = self.MotionPhoto.assemble(jpegBytes, videoBytes);

    // 同一组照片和视频重复合成会生成重复条目，用地址加动态段长度做指纹
    const fp = fingerprint(pair.imageUrl, `live:${videoBytes.byteLength}`);
    if (await isSeen(fp)) {
      await addHistory({
        status: "skipped",
        kind: "live",
        name: "",
        url: shortUrl(pair.imageUrl),
        message: "Already uploaded from this source.",
      });
      report(
        tabId,
        "success",
        "Already saved",
        "This Live Photo was uploaded before, skipped to avoid a duplicate."
      );
      return "skipped";
    }

    const fileName = buildMotionPhotoName(pair.imageUrl);

    // 3) 上传。合成结果同样受 Google 的单文件上限约束，在本地先拦一道
    const size = result.bytes.byteLength;
    assertUploadable({ size, mimeType: "image/jpeg" }, "image");
    report(
      tabId,
      "loading",
      `Uploading ${formatBytes(size)}…`,
      "Saving Live Photo to Google Photos…"
    );
    const blob = new Blob([result.bytes], { type: "image/jpeg" });
    const albumIds = Array.isArray(options.albumIds) ? options.albumIds : [];
    const ownsAlbum = !Array.isArray(options.albumIds);

    const mediaItemId = await withAuthRetry(async (token) => {
      const uploadToken = await uploadBytes(token, blob, "image/jpeg", fileName);
      return createMediaItem(token, uploadToken, fileName, pair.imageUrl);
    });
    if (mediaItemId) albumIds.push(mediaItemId);

    await markSeen(fp);

    let albumNote = "";
    if (ownsAlbum) {
      const archived = await archiveToAlbum(albumIds);
      if (archived.error) albumNote = ` · ${archived.error}`;
      else if (archived.added) albumNote = ` · added to "${archived.albumTitle}"`;
    }

    await addHistory({
      status: "saved",
      kind: "live",
      name: fileName,
      url: shortUrl(pair.imageUrl),
      message: formatBytes(size) + albumNote,
    });

    const note = result.warnings.length ? ` (${result.warnings.join("; ")})` : "";
    report(
      tabId,
      "success",
      "Live Photo Saved!",
      `Still ${formatBytes(result.stillSize)} + motion ${formatBytes(result.videoSize)}${note}${albumNote}`
    );
    return "saved";
  } catch (err) {
    console.error("[Save to Google Photos] Live Photo", err);
    const message = err.message || String(err);
    await addHistory({
      status: "failed",
      kind: "live",
      name: "",
      url: shortUrl(srcUrl),
      message,
    });
    report(tabId, "error", "Live Photo Failed", message);
    if (!quiet) notifyFailure("Could not save Live Photo", message);
    return "failed";
  }
}

// 动态段取不到但封面可用时，允许降级保存封面；超限错误不降级
function isCoverFallbackError(err, coverOrCtx) {
  if (!err || err.tooLarge) return false;
  const cover = typeof coverOrCtx === "string" ? coverOrCtx : coverOrCtx?.imageUrl;
  if (!isHttpUrl(cover)) return false;
  if (err.downloadFailed || err.notMp4) return true;
  return /blob|failed to fetch|network error|could not (?:download|be downloaded)|not an MP4 container/i.test(
    err.message || ""
  );
}

// 根据右键入口返回 { imageUrl, videoBytes, via }
async function resolveLivePhotoPair(tabId, srcUrl, mediaType, ctx) {
  // 页面上下文由调用方传入，避免同一流程里重复请求
  const fromContext = ctx && ctx.found ? ctx : null;

  if (mediaType === "video") {
    const videoUrl = fromContext?.videoUrl || srcUrl;
    if (!videoUrl) {
      throw new Error(
        fromContext?.reason || "No playable URL was found for this video."
      );
    }
    assertFetchable(videoUrl, "video");

    let imageUrl = fromContext?.imageUrl || null;
    let via = fromContext?.via || "page element";
    if (!imageUrl) {
      const cover = await requestCoverImage(tabId, videoUrl);
      if (!cover) {
        throw new Error(
          "No usable cover image was found near this video, so a Live Photo cannot be built."
        );
      }
      imageUrl = cover.imageUrl;
      via = cover.via;
    }

    assertFetchable(imageUrl, "cover image");
    const video = await fetchBytes(videoUrl, tabId);
    const videoBytes = video.bytes instanceof Uint8Array ? video.bytes : new Uint8Array(video.bytes);
    if (!self.MotionPhoto.isMp4(videoBytes)) {
      const err = new Error(
        `The video is not an MP4 container, so it cannot be packaged as a Motion Photo: ${shortUrl(videoUrl)}`
      );
      err.notMp4 = true;
      throw err;
    }

    return { imageUrl, videoBytes, via };
  }

  // 图片入口：视频优先取页面数据，其次按元素和同名规则探测
  if (fromContext?.videoUrl) {
    assertFetchable(fromContext.videoUrl, "video");
    const video = await fetchBytes(fromContext.videoUrl, tabId);
    const videoBytes = video.bytes instanceof Uint8Array ? video.bytes : new Uint8Array(video.bytes);
    if (self.MotionPhoto.isMp4(videoBytes)) {
      return { imageUrl: srcUrl, videoBytes, via: fromContext.via };
    }
  }

  const source = await requestVideoSource(tabId, srcUrl);
  const video = await resolveVideoBytes(source, tabId);
  if (!video) {
    throw new Error(
      source.reason ||
      "This page does not expose a usable motion video. Same-name files and page video elements were both tried."
    );
  }
  return { imageUrl: srcUrl, videoBytes: video.bytes, via: video.url };
}

function requestVideoSource(tabId, imageUrl) {
  return sendToTabWithInject(tabId, { action: "findLivePhotoVideo", imageUrl });
}

function requestCoverImage(tabId, videoUrl) {
  return sendToTabWithInject(tabId, { action: "findLivePhotoCover", videoUrl });
}

// 向页面索取右键位置的完整配对信息，失败时返回 null 而不是抛错
function requestContextPair(tabId) {
  return sendToTabWithInject(tabId, { action: "findLivePhotoFromContext" }).catch(() => null);
}

// Motion Photo 的主图必须是 JPEG。非 JPEG 用 OffscreenCanvas 转码。
async function ensureJpeg(bytes, url, tabId) {
  const arr = new Uint8Array(bytes);
  if (self.MotionPhoto.isJpeg(arr)) return arr;

  const bitmap = await decodeImage(arr, url, tabId);
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close?.();

  const jpegBlob = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.95 });
  const out = new Uint8Array(await jpegBlob.arrayBuffer());
  if (!self.MotionPhoto.isJpeg(out)) {
    throw new Error("Converting the cover image to JPEG failed.");
  }
  return out;
}

// Chrome 解码不了 HEIC/HEIF。先试同一 CDN 的 JPEG 变体，再给出明确结论。
async function decodeImage(bytes, url, tabId) {
  try {
    return await createImageBitmap(new Blob([bytes]));
  } catch (err) {
    const variant = jpegVariantOf(url);
    if (variant) {
      try {
        const photo = await fetchBytes(variant, tabId);
        return await createImageBitmap(new Blob([photo.bytes]));
      } catch {
        // 落到下面的统一报错
      }
    }
    throw new Error(
      `This cover image format cannot be decoded by the browser (${shortUrl(url)}). If it is HEIC, try saving a JPEG version of the same photo.`
    );
  }
}

// 常见 CDN 的 HEIC 地址后接 /format/jpeg 会返回 JPEG
function jpegVariantOf(url) {
  if (!/\.(heic|heif)(\?|$)/i.test(url) && !/heic|heif/i.test(url)) return null;
  // 已经是 JPEG 变体的地址不必再拼参数
  if (/[?&/]format=jpe?g/i.test(url)) return null;
  return `${url}${url.includes("?") ? "&" : "?"}format=jpeg`;
}

async function fetchBytes(url, tabId, onProgress) {
  // blob: 由页面自己创建，扩展进程的 fetch 必然失败，直接走页面上下文
  if (/^blob:/i.test(url)) return fetchViaPage(tabId, url);
  try {
    const result = await fetchWithProgress(url, onProgress);
    return result;
  } catch (err) {
    if (err.tooLarge) throw err;
    console.warn("[Save to Google Photos] 下载失败，尝试页面上下文", shortUrl(url), err.message);
    return fetchViaPage(tabId, url);
  }
}

// 返回 { bytes } 或 null。先试页面给出的地址，再逐个探测同名候选。
async function resolveVideoBytes(source, tabId) {
  if (!source) return null;

  const urls = [];
  if (source.found && source.videoUrl) urls.push(source.videoUrl);
  if (Array.isArray(source.candidates)) urls.push(...source.candidates);

  for (const url of urls.slice(0, 6)) {
    try {
      const media = await fetchBytes(url, tabId);
      const videoBytes = media.bytes instanceof Uint8Array ? media.bytes : new Uint8Array(media.bytes);
      if (self.MotionPhoto.isMp4(videoBytes)) {
        return { bytes: videoBytes, url };
      }
    } catch (err) {
      console.warn("[Save to Google Photos] 候选视频不可用", url, err);
    }
  }
  return null;
}

function buildMotionPhotoName(url) {
  return `${sanitizeAsciiBase(url) || "photo"}.MP.jpg`;
}

function shortUrl(url) {
  try {
    const parsed = new URL(url);
    return `${parsed.host}${parsed.pathname}`.slice(0, 80);
  } catch {
    return String(url).slice(0, 80);
  }
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

// --------------------------------------------------
// 8. 批量保存：由 popup 触发，逐个上传
// --------------------------------------------------
async function saveAllImages(tabId, limit = 20) {
  const listed = await sendToTabWithInject(tabId, { action: "collectImages" }).catch(() => null);
  const entries = normalizeBatchEntries(listed, limit);
  return runBatch(tabId, entries, "No large images were found on this page.");
}

// 批量保存的公共循环：逐个上传并汇总结果
async function runBatch(tabId, entries, emptyMessage) {
  if (!entries.length) {
    showToast(tabId, "error", "Nothing to save", emptyMessage);
    return { total: 0, saved: 0, skipped: 0, failed: 0 };
  }

  const counts = { total: entries.length, saved: 0, skipped: 0, failed: 0 };
  // 整批只归入一次相册，比每张单独调用少一轮请求
  const albumIds = [];

  for (let i = 0; i < entries.length; i++) {
    showToast(
      tabId,
      "loading",
      `Saving ${i + 1} of ${entries.length}…`,
      "Uploading the selected images, videos and Live Photos."
    );
    const outcome = await saveWithCandidates(tabId, entries[i], { albumIds });
    counts[outcome] = (counts[outcome] || 0) + 1;
    // 轻微间隔，避免并发限流
    await delay(250);
  }

  const archived = await archiveToAlbum(albumIds);
  let albumNote = "";
  if (archived.error) albumNote = ` ${archived.error}`;
  else if (archived.added) albumNote = ` Added ${archived.added} to "${archived.albumTitle}".`;

  const parts = [`${counts.saved} saved`];
  if (counts.skipped) parts.push(`${counts.skipped} skipped`);
  if (counts.failed) parts.push(`${counts.failed} failed`);

  showToast(
    tabId,
    counts.failed ? "error" : "success",
    counts.failed ? "Finished with errors" : "Batch finished",
    `${parts.join(", ")} out of ${counts.total}.${albumNote}`
  );

  if (counts.failed) {
    await notifyFailureWhenHidden(
      tabId,
      "Batch finished with errors",
      `${counts.failed} of ${counts.total} items could not be uploaded.`
    );
  }

  return counts;
}

function isHttpUrl(url) {
  return typeof url === "string" && /^https?:/i.test(url);
}

function isHttpOrBlobUrl(url) {
  return typeof url === "string" && /^(https?|blob):/i.test(url);
}

// 用户在选择面板里勾选后提交的媒体，保留每张卡片的配对和时长快照。
async function saveSelectedItems(tabId, items) {
  const entries = (Array.isArray(items) ? items : [])
    .filter((item) => item && typeof item.url === "string" && !item.unavailableReason)
    .slice(0, 60)
    .map((item) => {
      const isMedia = item.kind === "live" || item.kind === "video";
      const imageUrl = isHttpUrl(item.imageUrl) ? item.imageUrl : "";
      const kind = isMedia
        ? (imageUrl && !isLongVideo(item.videoDuration) ? "live" : "video")
        : "image";
      const candidates = (
        Array.isArray(item.candidates) && item.candidates.length
          ? item.candidates
          : [item.url]
      ).filter(isHttpUrl);
      const validUrl = kind === "live"
        ? (isHttpOrBlobUrl(item.url) ? item.url : "")
        : (isHttpUrl(item.url) ? item.url : (candidates[0] || ""));
      if (!validUrl) return null;
      return {
        url: validUrl,
        kind,
        imageUrl,
        videoDuration: Number.isFinite(item.videoDuration) ? item.videoDuration : undefined,
        candidates: candidates.length ? candidates : [validUrl],
      };
    })
    .filter(Boolean);

  return runBatch(tabId, entries, "No media were selected.");
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// 新版本 content 会带上候选地址列表，旧版本只有 URL 数组
function normalizeBatchEntries(listed, limit) {
  const max = Number.isFinite(limit) && limit > 0 ? limit : 20;

  if (Array.isArray(listed?.items) && listed.items.length) {
    return listed.items
      .filter((item) => item && typeof item.url === "string")
      .slice(0, max);
  }

  if (Array.isArray(listed?.images)) {
    return listed.images
      .filter((url) => typeof url === "string")
      .slice(0, max)
      .map((url) => ({ url, candidates: [url] }));
  }

  return [];
}

// 列表页给的地址可能是缩略图。按候选顺序试，去掉缩放参数的地址失败时
// 再退回原始地址，避免整张图直接判失败。
async function saveWithCandidates(tabId, entry, options = {}) {
  // 批量模式靠外层汇总，默认静默；单张右键需要进度和结果提示
  const quiet = options.quiet !== false;
  if (entry.kind === "live") {
    return handleLivePhoto({ id: tabId }, entry.url, "video", {
      found: true, videoUrl: entry.url, imageUrl: entry.imageUrl,
      videoDuration: entry.videoDuration, via: "media picker",
    }, { quiet, albumIds: options.albumIds });
  }
  if (entry.kind === "video") {
    return saveOne(tabId, entry.url, "video", { quiet, albumIds: options.albumIds });
  }
  const candidates = (
    Array.isArray(entry.candidates) && entry.candidates.length
      ? entry.candidates
      : [entry.url]
  ).slice(0, 4);

  for (let i = 0; i < candidates.length; i++) {
    const isLast = i === candidates.length - 1;
    const outcome = await saveOne(tabId, candidates[i], "image", {
      quiet,
      albumIds: options.albumIds,
      // 中间候选失败不写历史也不弹错误，只把最后一个候选的原因露出来
      quietFailure: !isLast,
      suppressFailureHistory: !isLast,
    });
    if (outcome !== "failed") return outcome;
  }

  return "failed";
}

// --------------------------------------------------
// 9. 历史记录与重复检测
// --------------------------------------------------
function storageGet(key) {
  return new Promise((resolve) => {
    const local = chrome.storage?.local;
    if (!local) return resolve(undefined);
    local.get(key, (data) => resolve(data ? data[key] : undefined));
  });
}

function storageSet(key, value) {
  return new Promise((resolve) => {
    const local = chrome.storage?.local;
    if (!local) return resolve();
    local.set({ [key]: value }, () => resolve());
  });
}

let storageQueue = Promise.resolve();

function withStorageLock(task) {
  const run = storageQueue.then(task, task);
  storageQueue = run.catch(() => {});
  return run;
}

function addHistory(entry) {
  return withStorageLock(async () => {
    const list = (await storageGet(HISTORY_KEY)) || [];
    list.unshift({ ...entry, time: Date.now() });
    await storageSet(HISTORY_KEY, list.slice(0, HISTORY_MAX));
  });
}

async function readHistory() {
  return (await storageGet(HISTORY_KEY)) || [];
}

function clearHistory() {
  return withStorageLock(() => storageSet(HISTORY_KEY, []));
}

// 同一地址重复点击会生成两份文件，用「去查询串的地址 + 字节数」做指纹
function fingerprint(url, size) {
  let clean = String(url || "");
  try {
    const parsed = new URL(clean);
    clean = `${parsed.origin}${parsed.pathname}`;
  } catch {
    // 非法 URL 原样参与指纹
  }
  return `${clean}|${size}`;
}

async function isSeen(fp) {
  const seen = (await storageGet(SEEN_KEY)) || [];
  return seen.includes(fp);
}

function markSeen(fp) {
  return withStorageLock(async () => {
    const seen = (await storageGet(SEEN_KEY)) || [];
    if (seen.includes(fp)) return;
    seen.unshift(fp);
    await storageSet(SEEN_KEY, seen.slice(0, SEEN_MAX));
  });
}

// --------------------------------------------------
// 10. Notifications
// --------------------------------------------------
// 页面在前台时 toast 已经可见，不必再弹一条系统通知
async function notifyFailureWhenHidden(tabId, title, message) {
  try {
    const tab = tabId && chrome.tabs?.get ? await chrome.tabs.get(tabId) : null;
    if (tab && tab.active) return;
  } catch {
    // 拿不到标签页状态时按后台处理
  }
  notifyFailure(title, message);
}

function notifyFailure(title, message) {
  try {
    if (!chrome.notifications?.create) return;
    chrome.notifications.create(
      {
        type: "basic",
        iconUrl: "icons/icon128.png",
        title: String(title).slice(0, 60),
        message: String(message || "Unknown error").slice(0, 200),
        priority: 1,
      },
      () => {
        void chrome.runtime.lastError;
      }
    );
  } catch {
    // 通知不可用时静默，页面内提示已经覆盖了主要路径
  }
}

// --------------------------------------------------
// 11. In-page toast notifications (via content script)
// --------------------------------------------------
function showToast(tabId, type, title, message) {
  if (!tabId) return;

  const payload = { action: "showToast", type, title, message };

  sendToTabWithInject(tabId, payload).catch(() => {
    // 消息通道彻底不可用时，直接在页面里渲染提示，避免界面停在转圈
    chrome.scripting
      .executeScript({
        target: { tabId },
        func: (kind, text, detail) => {
          const palette = {
            loading: "#4285f4",
            success: "#34a853",
            error: "#ea4335",
          };
          const box = document.createElement("div");
          box.setAttribute("data-sgp-fallback", "1");
          box.textContent = detail ? `${text}｜${detail}` : text;
          box.style.cssText = [
            "position:fixed", "top:20px", "right:20px", "z-index:2147483647",
            `background:${palette[kind] || "#333"}`, "color:#fff",
            "padding:12px 18px", "border-radius:10px", "max-width:380px",
            "font:13px/1.5 -apple-system,system-ui,sans-serif",
            "box-shadow:0 8px 24px rgba(0,0,0,.3)", "word-break:break-word",
          ].join(";");
          document.documentElement.appendChild(box);
          setTimeout(() => box.remove(), kind === "loading" ? 15000 : 6000);
        },
        args: [type, title, message],
      })
      .catch(() => {});
  });
}

// --------------------------------------------------
// 12. Message handler for popup communication
// --------------------------------------------------
chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
  if (request.action === "setMenuMode") {
    const title =
      request.mode === "live"
        ? "Save Live Photo to Google Photos"
        : "Save to Google Photos";
    chrome.contextMenus.update(CONTEXT_MENU_ID, { title }, () => {
      void chrome.runtime.lastError;
    });
    sendResponse({ ok: true });
    return true;
  }

  if (request.action === "getAuthToken") {
    getAuthToken(request.interactive)
      .then((token) => sendResponse({ success: true, token }))
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true; // keep channel open for async response
  }

  if (request.action === "signOut") {
    chrome.identity.getAuthToken({ interactive: false }, (token) => {
      if (token) {
        // Revoke the token via POST body so credentials are not placed in URL query strings
        fetch("https://oauth2.googleapis.com/revoke", {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ token }).toString(),
        }).catch(() => {});
        // Remove cached token
        chrome.identity.removeCachedAuthToken({ token }, () => {
          sendResponse({ success: true });
        });
      } else {
        sendResponse({ success: true });
      }
    });
    return true;
  }

  if (request.action === "ensureMenus") {
    registerContextMenus()
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (request.action === "saveAllImages") {
    saveAllImages(request.tabId, request.limit)
      .then((counts) => sendResponse({ success: true, counts }))
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (request.action === "saveSelectedItems") {
    const tabId = _sender?.tab?.id;
    if (!tabId) {
      sendResponse({ success: false, error: "No active tab." });
      return true;
    }
    saveSelectedItems(tabId, request.items)
      .then((counts) => sendResponse({ success: true, counts }))
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (request.action === "getHistory") {
    readHistory()
      .then((items) => sendResponse({ success: true, items: items.slice(0, 20) }))
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (request.action === "clearHistory") {
    clearHistory()
      .then(() => sendResponse({ success: true }))
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (request.action === "getAlbum") {
    getAlbumSetting()
      .then((album) => sendResponse({ success: true, album }))
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (request.action === "getAlbums") {
    ensureAlbumList()
      .then(async (albums) => {
        const album = await getAlbumSetting();
        sendResponse({ success: true, albums, album });
      })
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (request.action === "selectAlbum") {
    const albumId = String(request.albumId || "");
    ensureAlbumList()
      .then(async (albums) => {
        const album = albums.find((item) => item.id === albumId);
        if (!album) {
          sendResponse({
            success: false,
            error: "That album is not in the local list anymore.",
            albums,
          });
          return;
        }
        await setAlbumSetting(album);
        sendResponse({ success: true, album, albums });
      })
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (request.action === "createAlbum") {
    const title = String(request.title || "").trim();
    if (!title) {
      sendResponse({ success: false, error: "Album name cannot be empty." });
      return true;
    }
    ensureAlbumList()
      .then(async (albums) => {
        // Google 允许同名相册，各建一个会把照片分散开。先在本地拦截，
        // 让用户选择切到已有的那个，或换个名字。清单标题截断到 40 字符，
        // 比较时按同样长度归一化。
        const existing = albums.find((item) => item.title === title.slice(0, 40));
        if (existing) {
          sendResponse({ success: false, duplicate: true, existing, albums });
          return;
        }
        const album = await withAuthRetry((token) => createAlbum(token, title));
        await setAlbumSetting(album);
        await rememberAlbum(album);
        sendResponse({ success: true, album, albums: await getAlbumList() });
      })
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (request.action === "bindAlbum") {
    const albumId = parseAlbumId(request.input);
    if (!albumId) {
      sendResponse({
        success: false,
        error: "That does not look like a Google Photos album link.",
      });
      return true;
    }
    ensureAlbumList()
      .then(async (albums) => {
        const known = albums.find((item) => item.id === albumId);
        if (known) {
          // 早期绑定时拿不到标题，清单里留下的是占位名。重新绑定时顺手修正。
          const inferred =
            !known.title || known.title === "Album" ? await inferAlbumTitle(albumId) : "";
          const album = inferred ? { ...known, title: inferred } : known;
          if (inferred) await rememberAlbum(album);
          await setAlbumSetting(album);
          sendResponse({ success: true, album, albums: await getAlbumList() });
          return;
        }

        let album = {
          id: albumId,
          title: "Album",
          productUrl: `https://photos.google.com/album/${albumId}`,
          itemCount: 0,
        };
        let unverified = false;
        try {
          // 校验元数据只用于补标题。网络或授权卡住时不能让整条消息挂起，
          // 超时就直接按 ID 绑定，下一次保存会验证这个 ID 是否可写。
          const meta = await withTimeout(
            withAuthRetry((token) => readAlbumMeta(token, albumId)),
            ALBUM_META_TIMEOUT_MS,
            null
          );
          if (meta?.isWriteable === false) {
            sendResponse({
              success: false,
              error: "This album is read-only, so new photos cannot be added to it.",
            });
            return;
          }
          if (meta) {
            album = {
              id: meta.id || albumId,
              title: meta.title || "Album",
              productUrl: meta.productUrl || album.productUrl,
              itemCount: meta.itemCount || 0,
            };
          } else {
            unverified = true;
          }
        } catch (err) {
          // albums.get 在部分账号或相册上不可用。除了 401 说明授权本身失效，
          // 其余情况先按 id 绑定，下次保存失败时 archiveToAlbum 会清掉失效绑定。
          if (err.status === 401) throw err;
          unverified = true;
        }

        if (album.title === "Album") {
          const inferred = await inferAlbumTitle(albumId);
          if (inferred) album = { ...album, title: inferred };
        }

        await setAlbumSetting(album);
        await rememberAlbum(album);
        sendResponse({
          success: true,
          album,
          albums: await getAlbumList(),
          unverified,
        });
      })
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (request.action === "clearAlbum") {
    clearAlbumSetting()
      .then(() => sendResponse({ success: true }))
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }
});
