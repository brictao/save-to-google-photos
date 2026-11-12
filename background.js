// ============================================================
// Save to Google Photos — Background Service Worker
// ============================================================

importScripts("motion-photo.js");

const GOOGLE_PHOTOS_UPLOAD_URL =
  "https://photoslibrary.googleapis.com/v1/uploads";
const GOOGLE_PHOTOS_BATCH_CREATE_URL =
  "https://photoslibrary.googleapis.com/v1/mediaItems:batchCreate";
const CONTEXT_MENU_ID = "save-to-google-photos";
const LIVE_PHOTO_MENU_ID = "save-live-photo-to-google-photos";

// --------------------------------------------------
// 1. Context Menu
// --------------------------------------------------
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: CONTEXT_MENU_ID,
      title: "Save to Google Photos",
      contexts: ["image"],
    });
    chrome.contextMenus.create({
      id: LIVE_PHOTO_MENU_ID,
      title: "Save Live Photo to Google Photos",
      contexts: ["image"],
    });
  });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === LIVE_PHOTO_MENU_ID) {
    await handleLivePhoto(tab, info.srcUrl);
    return;
  }

  if (info.menuItemId !== CONTEXT_MENU_ID) return;

  const tabId = tab?.id;
  const imageUrl = info.srcUrl;
  if (!imageUrl) {
    showToast(tabId, "error", "Error", "Could not determine image URL.");
    return;
  }

  try {
    showToast(tabId, "loading", "Uploading…", "Saving image to Google Photos…");

    // 1) Get OAuth token
    const token = await getAuthToken(/* interactive */ true);

    // 2) Download image bytes
    const { blob, mimeType, fileName } = await downloadImage(imageUrl);

    // 3) Upload bytes → get upload token
    const uploadToken = await uploadBytes(token, blob, mimeType, fileName);

    // 4) Create media item
    await createMediaItem(token, uploadToken, fileName, imageUrl);

    showToast(tabId, "success", "Saved!", "Image saved to Google Photos");
  } catch (err) {
    console.error("[Save to Google Photos]", err);
    showToast(tabId, "error", "Upload Failed", err.message || String(err));
  }
});

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
async function handleLivePhoto(tab, imageUrl) {
  const tabId = tab?.id;
  if (!imageUrl) {
    showToast(tabId, "error", "Error", "Could not determine image URL.");
    return;
  }

  try {
    showToast(tabId, "loading", "Looking for motion…", "Checking this page for a paired video.");

    // 1) 向页面询问配套视频
    const source = await requestVideoSource(tabId, imageUrl);
    const video = await resolveVideoBytes(source);
    if (!video) {
      throw new Error(
        source.reason ||
        "这个页面没有提供可用的动态视频。已尝试同名文件和页面视频元素。"
      );
    }

    // 2) 拿授权
    const token = await getAuthToken(true);

    // 3) 下载主图并合成
    showToast(tabId, "loading", "Building Live Photo…", "Merging photo and motion into one file.");
    const photoBytes = await fetchBytes(imageUrl);
    const result = self.MotionPhoto.assemble(
      new Uint8Array(photoBytes),
      new Uint8Array(video.bytes)
    );

    const fileName = buildMotionPhotoName(imageUrl);

    // 4) 上传
    showToast(tabId, "loading", "Uploading…", "Saving Live Photo to Google Photos…");
    const blob = new Blob([result.bytes], { type: "image/jpeg" });
    const uploadToken = await uploadBytes(token, blob, "image/jpeg", fileName);
    await createMediaItem(token, uploadToken, fileName, imageUrl);

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

function requestVideoSource(tabId, imageUrl) {
  const message = { action: "findLivePhotoVideo", imageUrl };

  return chrome.tabs.sendMessage(tabId, message).catch(() =>
    chrome.scripting
      .executeScript({ target: { tabId }, files: ["content.js"] })
      .then(() => chrome.tabs.sendMessage(tabId, message))
  );
}

async function fetchBytes(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to download ${shortUrl(url)} (HTTP ${response.status})`);
  }
  return response.arrayBuffer();
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
  chrome.tabs.sendMessage(tabId, {
    action: "showToast",
    type,
    title,
    message,
  }).catch(() => {
    // Content script might not be injected yet, try to inject it
    chrome.scripting.executeScript({
      target: { tabId },
      files: ["content.js"],
    }).then(() => {
      chrome.tabs.sendMessage(tabId, {
        action: "showToast",
        type,
        title,
        message,
      }).catch(() => { });
    }).catch(() => { });
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
