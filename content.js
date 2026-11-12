// ============================================================
// Save to Google Photos — Content Script (In-page Toast)
// ============================================================

(() => {
    // 扩展重载后，页面上旧版本的 content script 会与扩展断开连接，
    // 但它的 window 标记仍然存在。不能因为标记存在就退出，否则新实例
    // 永远无法接管页面，消息也没有任何监听器回应。
    document.querySelectorAll(".sgp-toast-container").forEach((el) => el.remove());
    document.querySelectorAll("style[data-sgp-style]").forEach((el) => el.remove());
    window.__saveToGooglePhotosToast = true;

    // --------------------------------------------------
    // Inject styles
    // --------------------------------------------------
    const style = document.createElement("style");
    style.setAttribute("data-sgp-style", "1");
    style.textContent = `
    .sgp-toast-container {
      position: fixed;
      top: 20px;
      right: 20px;
      z-index: 2147483647;
      display: flex;
      flex-direction: column;
      gap: 10px;
      pointer-events: none;
      font-family: 'Segoe UI', system-ui, -apple-system, sans-serif;
    }

    .sgp-toast {
      pointer-events: auto;
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 14px 20px;
      border-radius: 12px;
      backdrop-filter: blur(16px);
      -webkit-backdrop-filter: blur(16px);
      box-shadow: 0 8px 32px rgba(0, 0, 0, 0.3), 0 0 0 1px rgba(255, 255, 255, 0.08);
      color: #fff;
      font-size: 13px;
      line-height: 1.4;
      max-width: 380px;
      transform: translateX(120%);
      opacity: 0;
      transition: transform 0.4s cubic-bezier(0.16, 1, 0.3, 1), opacity 0.4s ease;
    }

    .sgp-toast.sgp-show {
      transform: translateX(0);
      opacity: 1;
    }

    .sgp-toast.sgp-hide {
      transform: translateX(120%);
      opacity: 0;
    }

    .sgp-toast--loading {
      background: linear-gradient(135deg, rgba(26, 26, 46, 0.95), rgba(22, 33, 62, 0.95));
      border: 1px solid rgba(66, 133, 244, 0.3);
    }

    .sgp-toast--success {
      background: linear-gradient(135deg, rgba(20, 40, 30, 0.95), rgba(16, 46, 28, 0.95));
      border: 1px solid rgba(52, 168, 83, 0.4);
    }

    .sgp-toast--error {
      background: linear-gradient(135deg, rgba(46, 20, 20, 0.95), rgba(62, 22, 22, 0.95));
      border: 1px solid rgba(234, 67, 53, 0.4);
    }

    .sgp-toast-icon {
      font-size: 22px;
      flex-shrink: 0;
      line-height: 1;
    }

    .sgp-toast-body {
      flex: 1;
      min-width: 0;
    }

    .sgp-toast-title {
      font-weight: 700;
      font-size: 13px;
      margin-bottom: 2px;
    }

    .sgp-toast-message {
      font-size: 12px;
      color: rgba(255, 255, 255, 0.65);
      word-break: break-word;
    }

    .sgp-toast-close {
      background: none;
      border: none;
      color: rgba(255, 255, 255, 0.4);
      cursor: pointer;
      font-size: 16px;
      padding: 4px;
      line-height: 1;
      flex-shrink: 0;
      transition: color 0.2s;
    }

    .sgp-toast-close:hover {
      color: rgba(255, 255, 255, 0.8);
    }

    @keyframes sgp-spin {
      to { transform: rotate(360deg); }
    }

    .sgp-spinner {
      width: 22px;
      height: 22px;
      border: 2.5px solid rgba(66, 133, 244, 0.25);
      border-top-color: #4285F4;
      border-radius: 50%;
      animation: sgp-spin 0.8s linear infinite;
      flex-shrink: 0;
    }
  `;
    document.documentElement.appendChild(style);

    // --------------------------------------------------
    // Create container
    // --------------------------------------------------
    let container = document.createElement("div");
    container.className = "sgp-toast-container";
    document.documentElement.appendChild(container);

    // Track current loading toast so we can replace it
    let currentLoadingToast = null;

    // --------------------------------------------------
    // Toast creation
    // --------------------------------------------------
    function createToast(type, title, message, autoDismiss = true) {
        // 每次出现新提示都先清掉上一条 loading。
        // 多步流程会连续创建多条 loading，只保留最新一条，
        // 否则旧的加载卡片会一直堆在页面上。
        if (currentLoadingToast) {
            dismissToast(currentLoadingToast);
            currentLoadingToast = null;
        }

        const toast = document.createElement("div");
        toast.className = `sgp-toast sgp-toast--${type}`;

        // Icon
        let iconHTML = "";
        if (type === "loading") {
            iconHTML = `<div class="sgp-spinner"></div>`;
        } else if (type === "success") {
            iconHTML = `<span class="sgp-toast-icon">✅</span>`;
        } else {
            iconHTML = `<span class="sgp-toast-icon">❌</span>`;
        }

        toast.innerHTML = `
      ${iconHTML}
      <div class="sgp-toast-body">
        <div class="sgp-toast-title">${escapeHtml(title)}</div>
        <div class="sgp-toast-message">${escapeHtml(message)}</div>
      </div>
      <button class="sgp-toast-close">✕</button>
    `;

        // Close button
        toast.querySelector(".sgp-toast-close").addEventListener("click", () => {
            dismissToast(toast);
        });

        container.appendChild(toast);

        // Trigger animation
        requestAnimationFrame(() => {
            requestAnimationFrame(() => {
                toast.classList.add("sgp-show");
            });
        });

        if (type === "loading") {
            currentLoadingToast = toast;

            // 兜底：后台异常中断时不要让加载卡片永久停留
            setTimeout(() => {
                if (currentLoadingToast === toast) {
                    dismissToast(toast);
                    currentLoadingToast = null;
                }
            }, 180000);
        }

        // Auto dismiss
        if (autoDismiss && type !== "loading") {
            setTimeout(() => dismissToast(toast), 4000);
        }

        return toast;
    }

    function dismissToast(toast) {
        if (!toast || !toast.parentNode) return;
        toast.classList.remove("sgp-show");
        toast.classList.add("sgp-hide");
        setTimeout(() => {
            if (toast.parentNode) toast.parentNode.removeChild(toast);
        }, 400);
    }

    function escapeHtml(str) {
        const div = document.createElement("div");
        div.textContent = str;
        return div.innerHTML;
    }

    // --------------------------------------------------
    // 记录右键位置的图片元素，供 Live Photo 查找配套视频使用
    // --------------------------------------------------
    let lastContextImage = null;
    let lastContextVideo = null;

    // 根据右键目标通知后台切换菜单文案。
    // 菜单只有一个入口，文案只影响显示，点下去仍会自动判断类型。
    function syncMenuMode() {
        let live = false;
        try {
            live = Boolean(
                (lastContextVideo &&
                    (readReactLivePhoto(lastContextVideo) ||
                        absoluteUrl(lastContextVideo.currentSrc) ||
                        absoluteUrl(lastContextVideo.getAttribute("src")))) ||
                (lastContextImage && readReactLivePhoto(lastContextImage))
            );
        } catch {
            live = false;
        }

        chrome.runtime
            .sendMessage({ action: "setMenuMode", mode: live ? "live" : "photo" })
            .catch(() => { });
    }

    document.addEventListener("contextmenu", (event) => {
        const target = event.target;
        lastContextImage = target && target.tagName === "IMG" ? target : null;
        lastContextVideo = target && target.tagName === "VIDEO" ? target : null;
        syncMenuMode();
    }, true);

    function absoluteUrl(url) {
        if (!url) return null;
        try {
            return new URL(url, location.href).href;
        } catch {
            return null;
        }
    }

    // 在图片附近查找动态视频
    function findNearbyVideo(img) {
        let node = img;
        for (let depth = 0; depth < 5 && node; depth++) {
            const parent = node.parentElement;
            if (!parent) break;

            const video = parent.querySelector("video");
            if (video) {
                const src =
                    absoluteUrl(video.currentSrc) ||
                    absoluteUrl(video.getAttribute("src")) ||
                    absoluteUrl(video.querySelector("source")?.getAttribute("src"));
                if (src) return src;
            }

            // 常见 Live Photo 站点把视频地址放在容器属性里
            for (const attr of ["data-video", "data-video-src", "data-motion-photo", "data-live-photo"]) {
                const value = parent.getAttribute?.(attr);
                const url = absoluteUrl(value);
                if (url) return url;
            }

            node = parent;
        }
        return null;
    }

    // 按同名规则推导可能的动态视频地址，由后台逐个探测
    function guessVideoUrls(img) {
        const src = absoluteUrl(img.currentSrc || img.src);
        if (!src) return [];

        const match = src.match(/^(.*)\.(heic|heif|jpe?g|png|webp|avif)(\?.*)?$/i);
        if (!match) return [];

        const [, base, , query = ""] = match;
        const candidates = [];
        for (const ext of ["MOV", "mov", "MP4", "mp4"]) {
            candidates.push(`${base}.${ext}${query}`);
        }
        return candidates;
    }

    function describeLivePhotoSource(imageUrl) {
        const normalized = absoluteUrl(imageUrl);

        // 优先用在右键位置真实抓到的元素，其次按 URL 找页面上匹配的图片
        let img = lastContextImage;
        if (!img || (normalized && absoluteUrl(img.currentSrc || img.src) !== normalized)) {
            img = Array.from(document.images).find(
                (candidate) => absoluteUrl(candidate.currentSrc || candidate.src) === normalized
            ) || lastContextImage;
        }

        if (!img) {
            return { found: false, reason: "页面上找不到这张图片元素" };
        }

        const nearby = findNearbyVideo(img);
        if (nearby) {
            return { found: true, videoUrl: nearby, via: "页面上的视频元素或容器属性" };
        }

        const guesses = guessVideoUrls(img);
        if (guesses.length) {
            return { found: false, candidates: guesses, via: "同名文件推导" };
        }

        return { found: false, reason: "既没有配套视频元素，也无法从图片地址推导视频地址" };
    }

    // 在视频附近查找封面图
    function findCoverForVideo(video) {
        if (!video) return null;

        // 1) poster 属性通常就是封面帧
        const poster = absoluteUrl(video.getAttribute("poster"));
        if (poster) return { url: poster, via: "video 的 poster 属性" };

        // 2) 向上逐层找页面上的 img
        let node = video;
        for (let depth = 0; depth < 5 && node; depth++) {
            const parent = node.parentElement;
            if (!parent) break;

            const images = Array.from(parent.querySelectorAll("img"));
            const usable = images
                .map((img) => ({
                    url: absoluteUrl(img.currentSrc || img.src),
                    area: (img.naturalWidth || 0) * (img.naturalHeight || 0),
                }))
                .filter((item) => item.url)
                .sort((a, b) => b.area - a.area);

            if (usable.length) {
                return { url: usable[0].url, via: "video 附近的图片元素" };
            }

            node = parent;
        }

        return null;
    }

    // 从视频入口推导合成所需的封面图
    function describeLivePhotoCover(videoUrl) {
        const normalized = absoluteUrl(videoUrl);

        let video = lastContextVideo;
        if (!video || (normalized && absoluteUrl(video.currentSrc || video.src) !== normalized)) {
            video = Array.from(document.querySelectorAll("video")).find(
                (candidate) => absoluteUrl(candidate.currentSrc || candidate.src) === normalized
            ) || lastContextVideo;
        }

        if (!video) {
            return { found: false, reason: "页面上找不到这个视频元素" };
        }

        const cover = findCoverForVideo(video);
        if (!cover) {
            return { found: false, reason: "视频附近找不到可用的封面图" };
        }

        return { found: true, imageUrl: cover.url, videoUrl: normalized, via: cover.via };
    }

    // 从 React fiber 向上查找 Live Photo 数据。
    // 部分站点（例如即刻）在预览态不给 video 设 src，地址只存在于组件数据里。
    function readReactLivePhoto(el) {
        if (!el) return null;

        const fiberKey = Object.keys(el).find(
            (key) => key.startsWith("__reactFiber$") || key.startsWith("__reactInternalInstance$")
        );
        if (!fiberKey) return null;

        let fiber = el[fiberKey];
        let depth = 0;
        while (fiber && depth < 40) {
            const props = fiber.memoizedProps;
            if (props && typeof props === "object") {
                const candidates = [
                    props.livePhoto,
                    props.data,
                    props.data?.livePhoto,
                    props.pictureInfo?.livePhoto,
                    props.media,
                ];
                for (const candidate of candidates) {
                    if (candidate && typeof candidate.videoUrl === "string" && candidate.videoUrl) {
                        return {
                            videoUrl: absoluteUrl(candidate.videoUrl),
                            imageUrl: absoluteUrl(candidate.imageUrl) || absoluteUrl(candidate.src),
                        };
                    }
                }
            }
            fiber = fiber.return;
            depth++;
        }
        return null;
    }

    // 用右键位置的元素解析配对信息，兼容视频没有 src 的站点
    function describeLivePhotoFromContext() {
        const video = lastContextVideo;
        const image = lastContextImage;

        // 1) video 自身的地址
        let videoUrl = null;
        if (video) {
            videoUrl =
                absoluteUrl(video.currentSrc) ||
                absoluteUrl(video.getAttribute("src")) ||
                absoluteUrl(video.querySelector("source")?.getAttribute("src"));
        }

        // 2) 组件数据里的地址
        const react =
            readReactLivePhoto(video) ||
            readReactLivePhoto(video?.parentElement) ||
            readReactLivePhoto(image) ||
            readReactLivePhoto(image?.parentElement);

        if (!videoUrl && react?.videoUrl) videoUrl = react.videoUrl;

        // 3) 封面图
        let imageUrl = react?.imageUrl || null;
        if (!imageUrl && video) {
            const cover = findCoverForVideo(video);
            if (cover) imageUrl = cover.url;
        }
        if (!imageUrl && image) {
            imageUrl = absoluteUrl(image.currentSrc || image.src);
        }

        if (!videoUrl) {
            return { found: false, reason: "没有找到这个 Live Photo 的视频地址。" };
        }
        if (!imageUrl) {
            return { found: false, reason: "没有找到这个 Live Photo 的封面图。" };
        }

        return {
            found: true,
            imageUrl,
            videoUrl,
            via: react ? "页面组件数据" : "页面元素",
        };
    }

    // --------------------------------------------------
    // Listen for messages from background service worker
    // --------------------------------------------------
    chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
        if (request.action === "showToast") {
            createToast(request.type, request.title, request.message);
        }

        if (request.action === "findLivePhotoVideo") {
            let result;
            try {
                result = describeLivePhotoSource(request.imageUrl);
            } catch (err) {
                result = { found: false, reason: err.message || String(err) };
            }
            sendResponse(result);
            return true;
        }

        if (request.action === "findLivePhotoCover") {
            let result;
            try {
                result = describeLivePhotoCover(request.videoUrl);
            } catch (err) {
                result = { found: false, reason: err.message || String(err) };
            }
            sendResponse(result);
            return true;
        }

        if (request.action === "findLivePhotoFromContext") {
            let result;
            try {
                result = describeLivePhotoFromContext();
            } catch (err) {
                result = { found: false, reason: err.message || String(err) };
            }
            sendResponse(result);
            return true;
        }
    });
})();
