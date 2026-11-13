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
        // 多步流程和下载进度会连续推送 loading。同一条卡片原地更新文本，
        // 比销毁重建稳定，也不会在页面上堆出多条。
        if (type === "loading" && currentLoadingToast) {
            updateToast(currentLoadingToast, title, message);
            return currentLoadingToast;
        }

        // 非 loading 提示出现时，先清掉上一条 loading
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
            armLoadingTimeout(toast);
        }

        // Auto dismiss
        if (autoDismiss && type !== "loading") {
            setTimeout(() => dismissToast(toast), 4000);
        }

        return toast;
    }

    function dismissToast(toast) {
        if (!toast || !toast.parentNode) return;
        if (toast.__sgpTimer) {
            clearTimeout(toast.__sgpTimer);
            toast.__sgpTimer = null;
        }
        toast.classList.remove("sgp-show");
        toast.classList.add("sgp-hide");
        setTimeout(() => {
            if (toast.parentNode) toast.parentNode.removeChild(toast);
        }, 400);
    }

    // 同一条 loading 卡片只更新文字，用于下载进度这类高频状态
    function updateToast(toast, title, message) {
        if (!toast || !toast.parentNode) return;
        const titleEl = toast.querySelector(".sgp-toast-title");
        const messageEl = toast.querySelector(".sgp-toast-message");
        if (titleEl) titleEl.textContent = String(title);
        if (messageEl) messageEl.textContent = String(message);
        armLoadingTimeout(toast);
    }

    function armLoadingTimeout(toast) {
        if (toast.__sgpTimer) clearTimeout(toast.__sgpTimer);
        toast.__sgpTimer = setTimeout(() => {
            if (currentLoadingToast === toast) {
                dismissToast(toast);
                currentLoadingToast = null;
            }
        }, 180000);
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

    // 判断某个元素应该对应哪种菜单文案
    function menuModeOf(el) {
        if (!el) return "photo";
        try {
            if (el.tagName === "VIDEO") {
                const hasSource =
                    readReactLivePhoto(el) ||
                    absoluteUrl(el.currentSrc) ||
                    absoluteUrl(el.getAttribute("src"));
                return hasSource ? "live" : "photo";
            }
            if (el.tagName === "IMG") {
                return readReactLivePhoto(el) ? "live" : "photo";
            }
        } catch {
            // 解析失败时按普通图片处理
        }
        return "photo";
    }

    let publishedMode = null;
    let lastHoverTarget = null;

    function publishMenuMode(el) {
        const mode = menuModeOf(el);
        if (mode === publishedMode) return;
        publishedMode = mode;
        chrome.runtime
            .sendMessage({ action: "setMenuMode", mode })
            .catch(() => { });
    }

    // 鼠标进入图片时就预判。右键那一刻菜单已经开始渲染，
    // 等到 contextmenu 再更新会慢一拍，第一次总是显示上一次的文案。
    document.addEventListener("mouseover", (event) => {
        const target = event.target;
        if (!target || (target.tagName !== "IMG" && target.tagName !== "VIDEO")) return;
        if (target === lastHoverTarget) return;
        lastHoverTarget = target;
        publishMenuMode(target);
    }, true);

    document.addEventListener("contextmenu", (event) => {
        const target = event.target;
        lastContextImage = target && target.tagName === "IMG" ? target : null;
        lastContextVideo = target && target.tagName === "VIDEO" ? target : null;
        publishMenuMode(target);
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
            return { found: false, reason: "The image element could not be found on this page." };
        }

        const nearby = findNearbyVideo(img);
        if (nearby) {
            return { found: true, videoUrl: nearby, via: "页面上的视频元素或容器属性" };
        }

        const guesses = guessVideoUrls(img);
        if (guesses.length) {
            return { found: false, candidates: guesses, via: "同名文件推导" };
        }

        return { found: false, reason: "No paired video element was found, and no video URL could be derived from the image URL." };
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
            return { found: false, reason: "The video element could not be found on this page." };
        }

        const cover = findCoverForVideo(video);
        if (!cover) {
            return { found: false, reason: "No usable cover image was found near this video." };
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
            return { found: false, reason: "No video URL was found for this Live Photo." };
        }
        if (!imageUrl) {
            return { found: false, reason: "No cover image was found for this Live Photo." };
        }

        return {
            found: true,
            imageUrl,
            videoUrl,
            // 交给后台按实际时长区分 Live Photo 和普通视频。
            // 直播流的 duration 是 Infinity，这里一并过滤掉。
            videoDuration: Number.isFinite(video?.duration) ? video.duration : undefined,
            via: react ? "页面组件数据" : "页面元素",
        };
    }

    // --------------------------------------------------
    // 页面上下文抓字节：防盗链站点只认同源 Referer，
    // 扩展进程的 fetch 会被 403，这里让页面自己发请求。
    // --------------------------------------------------
    const PAGE_FALLBACK_MAX_BYTES = 25 * 1024 * 1024;

    async function fetchAsBase64(url) {
        if (/^blob:/i.test(url)) {
            return { ok: false, error: "blob URL" };
        }

        let response;
        try {
            response = await fetch(url, { credentials: "include" });
        } catch {
            return { ok: false, error: "network error" };
        }

        if (!response.ok) {
            return { ok: false, error: `HTTP ${response.status}` };
        }

        const declared = Number(response.headers.get("content-length")) || 0;
        if (declared > PAGE_FALLBACK_MAX_BYTES) {
            return { ok: false, error: "file is too large to hand over from the page" };
        }

        const buffer = await response.arrayBuffer();
        if (buffer.byteLength > PAGE_FALLBACK_MAX_BYTES) {
            return { ok: false, error: "file is too large to hand over from the page" };
        }

        return {
            ok: true,
            base64: bytesToBase64(new Uint8Array(buffer)),
            mimeType: (response.headers.get("content-type") || "").split(";")[0].trim(),
        };
    }

    function bytesToBase64(bytes) {
        let binary = "";
        const chunk = 0x8000;
        for (let i = 0; i < bytes.length; i += chunk) {
            binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
        }
        return btoa(binary);
    }

    // --------------------------------------------------
    // 批量保存：收集当前页面上足够大的图片，去重后交给后台
    // --------------------------------------------------
    // 七牛这类 CDN 把缩放参数直接拼在 query 里，例如
    // imageView2/2/w/400/q/90/format/jpeg。去掉缩放段就能拿到原图，
    // format 段要留下，它决定返回的编码格式。
    function stripThumbnailParams(url) {
        try {
            const parsed = new URL(url);
            const query = parsed.search.slice(1);
            if (!query) return url;

            if (/^imageslim/i.test(query)) {
                return `${parsed.origin}${parsed.pathname}`;
            }
            if (!/^(imageView2|imageMogr2|imageView|thumbnail)\//i.test(query)) {
                return url;
            }

            // format 段的位置不固定，直接匹配而不是按位置步进。
            // 缩放段全部丢掉，只留下编码格式。
            const format = query.match(/\/format\/([a-zA-Z0-9]+)/i);
            const search = format ? `?format=${format[1]}` : "";
            return `${parsed.origin}${parsed.pathname}${search}`;
        } catch {
            return url;
        }
    }

    // srcset 里描述符最大的那一项通常就是原图
    function largestSrcsetUrl(img) {
        const srcset = img.getAttribute?.("srcset");
        if (!srcset) return null;

        let best = null;
        let bestScore = -1;

        for (const part of srcset.split(",")) {
            const tokens = part.trim().split(/\s+/);
            const raw = tokens[0];
            if (!raw) continue;

            const descriptor = tokens[1] || "";
            let score = 1;
            if (/^\d+(\.\d+)?w$/.test(descriptor)) {
                score = parseFloat(descriptor);
            } else if (/^\d+(\.\d+)?x$/.test(descriptor)) {
                score = parseFloat(descriptor) * 1000;
            }

            if (score > bestScore) {
                bestScore = score;
                best = raw;
            }
        }

        return best ? absoluteUrl(best) : null;
    }

    // 懒加载站点把原图地址放在 data-* 里，src 上只有占位图
    function dataOriginalUrl(img) {
        const dataset = img.dataset || {};
        for (const key of ["original", "full", "raw", "src", "lazySrc", "lazy", "originalSrc", "url"]) {
            const value = dataset[key];
            if (!value || /^data:/i.test(value)) continue;
            const url = absoluteUrl(value);
            if (url) return url;
        }
        return null;
    }

    // 按可信度排列候选地址：去参数的在前，原始地址留作回退
    function imageCandidates(img) {
        const raw = [
            largestSrcsetUrl(img),
            dataOriginalUrl(img),
            absoluteUrl(img.getAttribute?.("src")),
            absoluteUrl(img.currentSrc),
        ].filter(Boolean);

        const out = [];
        const seen = new Set();

        for (const url of raw) {
            for (const candidate of [stripThumbnailParams(url), url]) {
                if (!/^https?:/i.test(candidate) || seen.has(candidate)) continue;
                seen.add(candidate);
                out.push(candidate);
            }
        }

        return out.slice(0, 3);
    }

    function collectImages(limit = 20) {
        const seen = new Set();
        const items = [];

        for (const img of Array.from(document.images)) {
            const candidates = imageCandidates(img);
            const primary = candidates[0];
            if (!primary) continue;

            // 列表页常把图压到卡片大小，自然尺寸和显示尺寸取较大的那个
            const rect = img.getBoundingClientRect?.();
            const width = Math.max(img.naturalWidth || 0, img.width || 0, Math.round(rect?.width || 0));
            const height = Math.max(img.naturalHeight || 0, img.height || 0, Math.round(rect?.height || 0));

            // 图标、头像、跟踪像素一律跳过
            if (width < 300 || height < 300) continue;
            if (seen.has(primary)) continue;

            seen.add(primary);
            items.push({ url: primary, candidates, area: width * height });
        }

        items.sort((a, b) => b.area - a.area);
        const picked = items.slice(0, limit);

        return {
            images: picked.map((item) => item.url),
            items: picked,
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

        if (request.action === "fetchAsBase64") {
            fetchAsBase64(request.url)
                .then((result) => sendResponse(result))
                .catch((err) => sendResponse({ ok: false, error: err.message || String(err) }));
            return true;
        }

        if (request.action === "collectImages") {
            let result;
            try {
                result = collectImages(request.limit || 20);
            } catch (err) {
                result = { images: [], error: err.message || String(err) };
            }
            sendResponse(result);
            return true;
        }
    });
})();
