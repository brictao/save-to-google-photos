// ============================================================
// Save to Google Photos — Background Service Worker
// ============================================================

importScripts("motion-photo.js");

const GOOGLE_PHOTOS_UPLOAD_URL =
  "https://photoslibrary.googleapis.com/v1/uploads";
const GOOGLE_PHOTOS_BATCH_CREATE_URL =
  "https://photoslibrary.googleapis.com/v1/mediaItems:batchCreate";
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
// 页面上下文回退要用 base64 跨进程传输，内存会翻倍，只处理中小文件
const PAGE_FALLBACK_MAX_BYTES = 25 * 1024 * 1024;
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

  // 右键的是视频，时长明显超出 Live Photo 的范围：按视频原文件保存
  if (mediaType === "video" && ctx?.found && isLongVideo(ctx.videoDuration)) {
    await handleSingleMedia(tabId, srcUrl || ctx.videoUrl, "video");
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

// 覆盖层站点：按右键坐标反查媒体元素，再走普通保存流程
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
    await handleSingleMedia(tabId, target.url, "video");
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

function requestAtCursor(tabId) {
  const message = { action: "resolveAtCursor" };

  return chrome.tabs
    .sendMessage(tabId, message)
    .catch(() =>
      chrome.scripting
        .executeScript({ target: { tabId }, files: ["content.js"] })
        .then(() => chrome.tabs.sendMessage(tabId, message))
    )
    .catch(() => null);
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

    await withAuthRetry(async (token) => {
      const uploadToken = await uploadBytes(token, media.blob, media.mimeType, media.fileName);
      await createMediaItem(token, uploadToken, media.fileName, url);
    });

    await markSeen(fp);
    await addHistory({
      status: "saved",
      kind,
      name: media.fileName,
      url: shortUrl(url),
      message: formatBytes(media.size),
    });

    if (!quiet) {
      showToast(
        tabId,
        "success",
        "Saved!",
        `${label === "video" ? "Video" : "Image"} saved to Google Photos (${formatBytes(media.size)})`
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

  let bytes;
  if (!response.body) {
    bytes = new Uint8Array(await response.arrayBuffer());
  } else {
    const reader = response.body.getReader();
    const chunks = [];
    let received = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        received += value.length;
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
    throw new Error("The file could not be downloaded and there is no page available to retry from.");
  }

  let response;
  try {
    response = await chrome.tabs.sendMessage(tabId, { action: "fetchAsBase64", url });
  } catch {
    throw new Error("The file could not be downloaded, and the page could not be reached to retry.");
  }

  if (!response || !response.ok) {
    throw new Error(
      response?.error
        ? `Could not download this file: ${response.error}`
        : "Could not download this file, even from the page context."
    );
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
  let base = "";
  try {
    const last = new URL(url).pathname.split("/").filter(Boolean).pop();
    if (last) base = safeDecode(last.replace(/\.[^.]+$/, ""));
  } catch {
    // 忽略，走默认名
  }

  // X-Goog-Upload-File-Name 只接受 ASCII，中文文件名会让 fetch 直接抛错
  const ascii = base.replace(/[^\x20-\x7E]/g, "").replace(/["\\/:*?<>|]/g, "_").trim();
  const usable = /[a-zA-Z0-9]/.test(ascii) ? ascii : `photo_${Date.now()}`;
  return `${usable.slice(0, 120)}.${ext}`;
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
  if (/^blob:/i.test(url)) {
    throw new Error(
      `The ${label} uses a blob URL, so the extension cannot read the original file.`
    );
  }
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

  return result;
}

// --------------------------------------------------
// 7. Live Photo：找配套视频并合成 Motion Photo
// --------------------------------------------------
async function handleLivePhoto(tab, srcUrl, mediaType, ctx) {
  const tabId = tab?.id;
  // 视频元素可能没有 src，地址在页面组件数据里，此时交给 content 解析
  if (!srcUrl && mediaType !== "video") {
    showToast(tabId, "error", "Error", "Could not determine the clicked URL.");
    return;
  }

  try {
    showToast(tabId, "loading", "Looking for the pair…", "Checking this page for the matching photo or video.");

    // 1) 确定主图与动态段，两个入口共用后续流程
    const pair = await resolveLivePhotoPair(tabId, srcUrl, mediaType, ctx);

    // 2) 下载主图、必要时转成 JPEG，再合成
    showToast(tabId, "loading", "Building Live Photo…", "Merging photo and motion into one file.");
    const photo = await fetchBytes(pair.imageUrl, tabId, (received, total) => {
      const detail =
        total > 0
          ? `${formatBytes(received)} of ${formatBytes(total)} (${Math.round((received / total) * 100)}%)`
          : `${formatBytes(received)} downloaded`;
      showToast(tabId, "loading", "Downloading cover image…", detail);
    });
    const jpegBytes = await ensureJpeg(photo.bytes, pair.imageUrl, tabId);
    const result = self.MotionPhoto.assemble(
      jpegBytes,
      new Uint8Array(pair.videoBytes)
    );

    // 同一组照片和视频重复合成会生成重复条目，用地址加动态段长度做指纹
    const fp = fingerprint(pair.imageUrl, `live:${new Uint8Array(pair.videoBytes).length}`);
    if (await isSeen(fp)) {
      await addHistory({
        status: "skipped",
        kind: "live",
        name: "",
        url: shortUrl(pair.imageUrl),
        message: "Already uploaded from this source.",
      });
      showToast(
        tabId,
        "success",
        "Already saved",
        "This Live Photo was uploaded before, skipped to avoid a duplicate."
      );
      return;
    }

    const fileName = buildMotionPhotoName(pair.imageUrl);

    // 3) 上传。合成结果同样受 Google 的单文件上限约束，在本地先拦一道
    const size = result.bytes.byteLength;
    assertUploadable({ size, mimeType: "image/jpeg" }, "image");
    showToast(
      tabId,
      "loading",
      `Uploading ${formatBytes(size)}…`,
      "Saving Live Photo to Google Photos…"
    );
    const blob = new Blob([result.bytes], { type: "image/jpeg" });
    await withAuthRetry(async (token) => {
      const uploadToken = await uploadBytes(token, blob, "image/jpeg", fileName);
      await createMediaItem(token, uploadToken, fileName, pair.imageUrl);
    });

    await markSeen(fp);
    await addHistory({
      status: "saved",
      kind: "live",
      name: fileName,
      url: shortUrl(pair.imageUrl),
      message: formatBytes(size),
    });

    const note = result.warnings.length ? ` (${result.warnings.join("; ")})` : "";
    showToast(
      tabId,
      "success",
      "Live Photo Saved!",
      `Still ${formatBytes(result.stillSize)} + motion ${formatBytes(result.videoSize)}${note}`
    );
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
    showToast(tabId, "error", "Live Photo Failed", message);
    notifyFailure("Could not save Live Photo", message);
  }
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
    if (!self.MotionPhoto.isMp4(new Uint8Array(video.bytes))) {
      throw new Error(
        `The video is not an MP4 container, so it cannot be packaged as a Motion Photo: ${shortUrl(videoUrl)}`
      );
    }

    return { imageUrl, videoBytes: video.bytes, via };
  }

  // 图片入口：视频优先取页面数据，其次按元素和同名规则探测
  if (fromContext?.videoUrl) {
    assertFetchable(fromContext.videoUrl, "video");
    const video = await fetchBytes(fromContext.videoUrl, tabId);
    if (self.MotionPhoto.isMp4(new Uint8Array(video.bytes))) {
      return { imageUrl: srcUrl, videoBytes: video.bytes, via: fromContext.via };
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
  const message = { action: "findLivePhotoVideo", imageUrl };

  return chrome.tabs.sendMessage(tabId, message).catch(() =>
    chrome.scripting
      .executeScript({ target: { tabId }, files: ["content.js"] })
      .then(() => chrome.tabs.sendMessage(tabId, message))
  );
}

function requestCoverImage(tabId, videoUrl) {
  const message = { action: "findLivePhotoCover", videoUrl };

  return chrome.tabs.sendMessage(tabId, message).catch(() =>
    chrome.scripting
      .executeScript({ target: { tabId }, files: ["content.js"] })
      .then(() => chrome.tabs.sendMessage(tabId, message))
  );
}

// 向页面索取右键位置的完整配对信息，失败时返回 null 而不是抛错
function requestContextPair(tabId) {
  const message = { action: "findLivePhotoFromContext" };

  return chrome.tabs
    .sendMessage(tabId, message)
    .catch(() =>
      chrome.scripting
        .executeScript({ target: { tabId }, files: ["content.js"] })
        .then(() => chrome.tabs.sendMessage(tabId, message))
    )
    .catch(() => null);
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
  try {
    const result = await fetchWithProgress(url, onProgress);
    return result;
  } catch (err) {
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
      if (self.MotionPhoto.isMp4(new Uint8Array(media.bytes))) {
        return { bytes: media.bytes, url };
      }
    } catch (err) {
      console.warn("[Save to Google Photos] 候选视频不可用", url, err);
    }
  }
  return null;
}

function buildMotionPhotoName(url) {
  let name = "photo";
  try {
    const last = new URL(url).pathname.split("/").filter(Boolean).pop();
    if (last) name = safeDecode(last);
  } catch {
    // 忽略，用默认名
  }

  name = name.split("?")[0];
  const base = name.replace(/\.[^.]+$/, "");
  const ascii = base.replace(/[^\x20-\x7E]/g, "").replace(/["\\/:*?<>|]/g, "_").trim();
  return `${/[a-zA-Z0-9]/.test(ascii) ? ascii.slice(0, 120) : "photo"}.MP.jpg`;
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
  let listed;
  try {
    listed = await chrome.tabs.sendMessage(tabId, { action: "collectImages" });
  } catch {
    await chrome.scripting
      .executeScript({ target: { tabId }, files: ["content.js"] })
      .catch(() => {});
    try {
      listed = await chrome.tabs.sendMessage(tabId, { action: "collectImages" });
    } catch {
      listed = null;
    }
  }

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

  for (let i = 0; i < entries.length; i++) {
    showToast(
      tabId,
      "loading",
      `Saving ${i + 1} of ${entries.length}…`,
      "Uploading the images found on this page."
    );
    const outcome = await saveWithCandidates(tabId, entries[i]);
    counts[outcome] = (counts[outcome] || 0) + 1;
    // 轻微间隔，避免并发限流
    await delay(250);
  }

  const parts = [`${counts.saved} saved`];
  if (counts.skipped) parts.push(`${counts.skipped} skipped`);
  if (counts.failed) parts.push(`${counts.failed} failed`);

  showToast(
    tabId,
    counts.failed ? "error" : "success",
    counts.failed ? "Finished with errors" : "Batch finished",
    `${parts.join(", ")} out of ${counts.total}.`
  );

  if (counts.failed) {
    await notifyFailureWhenHidden(
      tabId,
      "Batch finished with errors",
      `${counts.failed} of ${counts.total} images could not be uploaded.`
    );
  }

  return counts;
}

// 保存当前帖子里的全部图片。小红书的详情是页内弹窗，信息流只给首图，
// 完整列表只存在于组件数据里。
async function saveNoteImages(tabId) {
  const listed = await requestNoteImages(tabId);

  if (!listed || !listed.ok) {
    showToast(
      tabId,
      "error",
      "No post detected",
      listed?.reason || "Open a post first, then try again."
    );
    return { total: 0, saved: 0, skipped: 0, failed: 0 };
  }

  const entries = (listed.items || [])
    .filter((item) => item && typeof item.url === "string")
    .slice(0, 40);

  return runBatch(tabId, entries, "This post has no images.");
}

function requestNoteImages(tabId) {
  const message = { action: "collectNoteImages" };

  return chrome.tabs
    .sendMessage(tabId, message)
    .catch(() =>
      chrome.scripting
        .executeScript({ target: { tabId }, files: ["content.js"] })
        .then(() => chrome.tabs.sendMessage(tabId, message))
    )
    .catch(() => null);
}

// 用户在选择面板里勾选后提交的图片
async function saveSelectedItems(tabId, items) {
  const entries = (Array.isArray(items) ? items : [])
    .filter((item) => item && typeof item.url === "string")
    .slice(0, 60)
    .map((item) => ({
      url: item.url,
      candidates:
        Array.isArray(item.candidates) && item.candidates.length
          ? item.candidates
          : [item.url],
    }));

  return runBatch(tabId, entries, "No images were selected.");
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
  const candidates = (
    Array.isArray(entry.candidates) && entry.candidates.length
      ? entry.candidates
      : [entry.url]
  ).slice(0, 4);

  for (let i = 0; i < candidates.length; i++) {
    const isLast = i === candidates.length - 1;
    const outcome = await saveOne(tabId, candidates[i], "image", {
      quiet,
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

async function addHistory(entry) {
  const list = (await storageGet(HISTORY_KEY)) || [];
  list.unshift({ ...entry, time: Date.now() });
  await storageSet(HISTORY_KEY, list.slice(0, HISTORY_MAX));
}

async function readHistory() {
  return (await storageGet(HISTORY_KEY)) || [];
}

async function clearHistory() {
  await storageSet(HISTORY_KEY, []);
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

async function markSeen(fp) {
  const seen = (await storageGet(SEEN_KEY)) || [];
  if (seen.includes(fp)) return;
  seen.unshift(fp);
  await storageSet(SEEN_KEY, seen.slice(0, SEEN_MAX));
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

  chrome.tabs.sendMessage(tabId, payload).catch(() => {
    // 内容脚本可能已经和扩展断开，注入新实例后再试一次
    chrome.scripting
      .executeScript({ target: { tabId }, files: ["content.js"] })
      .then(() => chrome.tabs.sendMessage(tabId, payload))
      .catch(() => {
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
        // Revoke the token on Google's side
        fetch(`https://accounts.google.com/o/oauth2/revoke?token=${token}`)
          .catch(() => { });
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

  if (request.action === "saveNoteImages") {
    saveNoteImages(request.tabId)
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
});
