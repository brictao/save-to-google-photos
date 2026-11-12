// ============================================================
// Save to Google Photos — Background Service Worker
// ============================================================

importScripts("motion-photo.js");

const GOOGLE_PHOTOS_UPLOAD_URL =
  "https://photoslibrary.googleapis.com/v1/uploads";
const GOOGLE_PHOTOS_BATCH_CREATE_URL =
  "https://photoslibrary.googleapis.com/v1/mediaItems:batchCreate";
const CONTEXT_MENU_ID = "save-to-google-photos";

// --------------------------------------------------
// 1. Context Menu
// --------------------------------------------------
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    // 只保留一个顶层菜单项。多个顶层项会被 Chrome 折叠成二级菜单，
    // 单一入口直接显示，点击后按内容自动判断走上传还是合成。
    chrome.contextMenus.create({
      id: CONTEXT_MENU_ID,
      title: "Save to Google Photos",
      contexts: ["image", "video"],
    });
  });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== CONTEXT_MENU_ID) return;
  await handleSave(tab, info.srcUrl, info.mediaType);
});

async function handleSave(tab, srcUrl, mediaType) {
  const tabId = tab?.id;
  if (!srcUrl && mediaType !== "video") {
    showToast(tabId, "error", "Error", "Could not determine the clicked URL.");
    return;
  }

  // 先确认页面上有没有 Live Photo 配对，再决定走合成还是普通上传
  const ctx = await requestContextPair(tabId);
  if (ctx && ctx.found && ctx.videoUrl) {
    await handleLivePhoto(tab, srcUrl, mediaType, ctx);
    return;
  }

  if (mediaType === "video") {
    showToast(
      tabId,
      "error",
      "Not a Live Photo",
      "这个视频没有配套的封面图，无法作为 Live Photo 保存。"
    );
    return;
  }

  await handleSingleImage(tabId, srcUrl);
}

async function handleSingleImage(tabId, imageUrl) {
  try {
    showToast(tabId, "loading", "Uploading…", "Saving image to Google Photos…");

    const token = await getAuthToken(true);
    const { blob, mimeType, fileName } = await downloadImage(imageUrl);
    const uploadToken = await uploadBytes(token, blob, mimeType, fileName);
    await createMediaItem(token, uploadToken, fileName, imageUrl);

    showToast(tabId, "success", "Saved!", "Image saved to Google Photos");
  } catch (err) {
    console.error("[Save to Google Photos]", err);
    showToast(tabId, "error", "Upload Failed", err.message || String(err));
  }
}

// --------------------------------------------------
// 2. Auth helpers
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

// --------------------------------------------------
// 3. Download image
// --------------------------------------------------
async function downloadImage(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to download image (HTTP ${response.status})`);
  }

  const blob = await response.blob();
  const mimeType = blob.type || "image/jpeg";

  // Try to derive a file name from the URL
  let fileName = "image";
  try {
    const pathname = new URL(url).pathname;
    const parts = pathname.split("/");
    const last = parts[parts.length - 1];
    if (last && last.includes(".")) {
      fileName = decodeURIComponent(last);
    } else {
      // Fallback: generate a timestamped name
      const ext = mimeType.split("/")[1] || "jpg";
      fileName = `photo_${Date.now()}.${ext}`;
    }
  } catch {
    const ext = mimeType.split("/")[1] || "jpg";
    fileName = `photo_${Date.now()}.${ext}`;
  }

  return { blob, mimeType, fileName };
}

// --------------------------------------------------
// 4. Upload bytes (Step 1 of Google Photos upload)
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
    const text = await response.text();
    throw new Error(`Upload failed (${response.status}): ${text}`);
  }

  const uploadToken = await response.text();
  return uploadToken;
}

// --------------------------------------------------
// 5. Create media item (Step 2 of Google Photos upload)
// --------------------------------------------------
async function createMediaItem(token, uploadToken, fileName, sourceUrl) {
  const body = {
    newMediaItems: [
      {
        description: sourceUrl || "",
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
    const text = await response.text();
    throw new Error(`Create media item failed (${response.status}): ${text}`);
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
// 6. Live Photo：找配套视频并合成 Motion Photo
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

    // 2) 拿授权
    const token = await getAuthToken(true);

    // 3) 下载主图、必要时转成 JPEG，再合成
    showToast(tabId, "loading", "Building Live Photo…", "Merging photo and motion into one file.");
    const photoBytes = await fetchBytes(pair.imageUrl);
    const jpegBytes = await ensureJpeg(photoBytes, pair.imageUrl);
    const result = self.MotionPhoto.assemble(
      jpegBytes,
      new Uint8Array(pair.videoBytes)
    );

    const fileName = buildMotionPhotoName(pair.imageUrl);

    // 4) 上传
    showToast(tabId, "loading", "Uploading…", "Saving Live Photo to Google Photos…");
    const blob = new Blob([result.bytes], { type: "image/jpeg" });
    const uploadToken = await uploadBytes(token, blob, "image/jpeg", fileName);
    await createMediaItem(token, uploadToken, fileName, pair.imageUrl);

    const note = result.warnings.length ? `（${result.warnings.join("；")}）` : "";
    showToast(
      tabId,
      "success",
      "Live Photo Saved!",
      `静态图 ${formatBytes(result.stillSize)} + 动态 ${formatBytes(result.videoSize)}${note}`
    );
  } catch (err) {
    console.error("[Save to Google Photos] Live Photo", err);
    showToast(tabId, "error", "Live Photo Failed", err.message || String(err));
  }
}

// 根据右键入口返回 { imageUrl, videoBytes, via }
async function resolveLivePhotoPair(tabId, srcUrl, mediaType, ctx) {
  // 页面上下文由调用方传入，避免同一流程里重复请求
  const fromContext = ctx && ctx.found ? ctx : null;

  if (mediaType === "video") {
    const videoUrl = fromContext?.videoUrl || srcUrl;
    if (!videoUrl) {
      throw new Error(fromContext?.reason || "没有找到这个视频的播放地址。");
    }
    assertFetchable(videoUrl, "视频");

    let imageUrl = fromContext?.imageUrl || null;
    let via = fromContext?.via || "页面元素";
    if (!imageUrl) {
      const cover = await requestCoverImage(tabId, videoUrl);
      if (!cover) {
        throw new Error("这个视频附近找不到可用的封面图，无法合成 Live Photo。");
      }
      imageUrl = cover.imageUrl;
      via = cover.via;
    }

    const videoBytes = await fetchBytes(videoUrl);
    if (!self.MotionPhoto.isMp4(new Uint8Array(videoBytes))) {
      throw new Error(`视频不是 MP4 容器，Motion Photo 无法封装：${shortUrl(videoUrl)}`);
    }

    return { imageUrl, videoBytes, via };
  }

  // 图片入口：视频优先取页面数据，其次按元素和同名规则探测
  if (fromContext?.videoUrl) {
    assertFetchable(fromContext.videoUrl, "视频");
    const videoBytes = await fetchBytes(fromContext.videoUrl);
    if (self.MotionPhoto.isMp4(new Uint8Array(videoBytes))) {
      return { imageUrl: srcUrl, videoBytes, via: fromContext.via };
    }
  }

  const source = await requestVideoSource(tabId, srcUrl);
  const video = await resolveVideoBytes(source);
  if (!video) {
    throw new Error(
      source.reason ||
      "这个页面没有提供可用的动态视频。已尝试同名文件和页面视频元素。"
    );
  }
  return { imageUrl: srcUrl, videoBytes: video.bytes, via: video.url };
}

// blob: 与 m3u8 这类地址在扩展里拿不到完整文件，提前给出清楚的原因
function assertFetchable(url, label) {
  if (/^blob:/i.test(url)) {
    throw new Error(`${label}使用的是 blob 地址，扩展无法读取原始文件。`);
  }
  if (/\.m3u8(\?|$)/i.test(url)) {
    throw new Error(`${label}是 HLS 流，扩展无法直接下载完整文件。`);
  }
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
async function ensureJpeg(bytes, url) {
  const arr = new Uint8Array(bytes);
  if (self.MotionPhoto.isJpeg(arr)) return arr;

  let bitmap;
  try {
    bitmap = await createImageBitmap(new Blob([arr]));
  } catch {
    throw new Error(`封面图格式无法解码：${shortUrl(url)}`);
  }

  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close?.();

  const jpegBlob = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.95 });
  const out = new Uint8Array(await jpegBlob.arrayBuffer());
  if (!self.MotionPhoto.isJpeg(out)) {
    throw new Error("封面图转码为 JPEG 失败");
  }
  return out;
}

async function fetchBytes(url, timeoutMs = 90000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`Failed to download ${shortUrl(url)} (HTTP ${response.status})`);
    }
    return await response.arrayBuffer();
  } catch (err) {
    if (err.name === "AbortError") {
      throw new Error(
        `下载超时（${Math.round(timeoutMs / 1000)} 秒）：${shortUrl(url)}`
      );
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// 返回 { bytes } 或 null。先试页面给出的地址，再逐个探测同名候选。
async function resolveVideoBytes(source) {
  if (!source) return null;

  const urls = [];
  if (source.found && source.videoUrl) urls.push(source.videoUrl);
  if (Array.isArray(source.candidates)) urls.push(...source.candidates);

  for (const url of urls.slice(0, 6)) {
    try {
      const bytes = await fetchBytes(url);
      if (self.MotionPhoto.isMp4(new Uint8Array(bytes))) {
        return { bytes, url };
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
    if (last) name = decodeURIComponent(last);
  } catch {
    // 忽略，用默认名
  }

  name = name.split("?")[0];
  const base = name.replace(/\.[^.]+$/, "");
  return `${base || "photo"}.MP.jpg`;
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
// 7. In-page toast notifications (via content script)
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
// 8. Message handler for popup communication
// --------------------------------------------------
chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
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
});
