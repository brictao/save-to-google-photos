// ============================================================
// Save to Google Photos — Content Script (In-page Toast)
// ============================================================

(() => {
    // 扩展重载或再次注入时，先注销上一实例遗留的 DOM 与监听器，
    // 避免同一页面上挂载多套事件监听或残留旧的选择面板。
    try {
        window.__sgpCleanup?.();
    } catch {
        // 忽略旧实例清理异常
    }
    document.querySelectorAll(".sgp-toast-container").forEach((el) => el.remove());
    document.querySelectorAll("style[data-sgp-style]").forEach((el) => el.remove());
    document.getElementById?.("sgp-picker-host")?.remove?.();
    window.__saveToGooglePhotosToast = true;

    const MAX_LIVE_PHOTO_SECONDS = 10;
    const MENU_MODE_CACHE_TTL_MS = 1500;
    const menuModeCache = typeof WeakMap === "function" ? new WeakMap() : null;

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
        const safeType = type === "loading" || type === "success" ? type : "error";

        // 多步流程和下载进度会连续推送 loading。同一条卡片原地更新文本，
        // 比销毁重建稳定，也不会在页面上堆出多条。
        if (safeType === "loading" && currentLoadingToast) {
            updateToast(currentLoadingToast, title, message);
            return currentLoadingToast;
        }

        // 非 loading 提示出现时，先清掉上一条 loading
        if (currentLoadingToast) {
            dismissToast(currentLoadingToast);
            currentLoadingToast = null;
        }

        const toast = document.createElement("div");
        toast.className = `sgp-toast sgp-toast--${safeType}`;

        let iconEl;
        if (safeType === "loading") {
            iconEl = document.createElement("div");
            iconEl.className = "sgp-spinner";
        } else {
            iconEl = document.createElement("span");
            iconEl.className = "sgp-toast-icon";
            iconEl.textContent = safeType === "success" ? "✅" : "❌";
        }

        const bodyEl = document.createElement("div");
        bodyEl.className = "sgp-toast-body";

        const titleEl = document.createElement("div");
        titleEl.className = "sgp-toast-title";
        titleEl.textContent = String(title ?? "");

        const messageEl = document.createElement("div");
        messageEl.className = "sgp-toast-message";
        messageEl.textContent = String(message ?? "");

        bodyEl.appendChild(titleEl);
        bodyEl.appendChild(messageEl);

        const closeBtn = document.createElement("button");
        closeBtn.className = "sgp-toast-close";
        closeBtn.type = "button";
        closeBtn.textContent = "✕";
        closeBtn.addEventListener("click", () => {
            dismissToast(toast);
        });

        toast.appendChild(iconEl);
        toast.appendChild(bodyEl);
        toast.appendChild(closeBtn);
        toast.__sgpTitleEl = titleEl;
        toast.__sgpMessageEl = messageEl;

        container.appendChild(toast);

        // Trigger animation
        requestAnimationFrame(() => {
            requestAnimationFrame(() => {
                toast.classList.add("sgp-show");
            });
        });

        if (safeType === "loading") {
            currentLoadingToast = toast;
            // 兜底：后台异常中断时不要让加载卡片永久停留
            armLoadingTimeout(toast);
        }

        // Auto dismiss
        if (autoDismiss && safeType !== "loading") {
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
        const titleEl = toast.__sgpTitleEl || toast.querySelector(".sgp-toast-title");
        const messageEl = toast.__sgpMessageEl || toast.querySelector(".sgp-toast-message");
        if (titleEl) titleEl.textContent = String(title ?? "");
        if (messageEl) messageEl.textContent = String(message ?? "");
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

    // --------------------------------------------------
    // 记录右键位置的图片元素，供 Live Photo 查找配套视频使用
    // --------------------------------------------------
    let lastContextImage = null;
    let lastContextVideo = null;
    let disposed = false;
    const domAbort = typeof AbortController === "function" ? new AbortController() : null;

    // 判断某个元素应该对应哪种菜单文案
    function computeMenuMode(el) {
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

    function menuModeOf(el, forceRefresh = false) {
        if (!el) return "photo";
        const now = Date.now();
        if (!forceRefresh && menuModeCache && typeof el === "object") {
            const cached = menuModeCache.get(el);
            if (cached && now - cached.time < MENU_MODE_CACHE_TTL_MS) {
                return cached.mode;
            }
        }
        const mode = computeMenuMode(el);
        if (menuModeCache && typeof el === "object") {
            menuModeCache.set(el, { mode, time: now });
        }
        return mode;
    }

    let publishedMode = null;
    let lastHoverTarget = null;

    function publishMenuMode(el, forceRefresh = false) {
        if (disposed) return;
        const mode = menuModeOf(el, forceRefresh);
        if (mode === publishedMode) return;
        publishedMode = mode;
        chrome.runtime
            .sendMessage({ action: "setMenuMode", mode })
            .catch(() => { });
    }

    function addDocListener(type, handler, capture = true) {
        if (domAbort) {
            document.addEventListener(type, handler, { capture, signal: domAbort.signal });
        } else {
            document.addEventListener(type, handler, capture);
        }
    }

    // 鼠标进入图片时就预判。右键那一刻菜单已经开始渲染，
    // 等到 contextmenu 再更新会慢一拍，第一次总是显示上一次的文案。
    const onMouseOver = (event) => {
        if (disposed) return;
        const target = event.target;
        if (!target || (target.tagName !== "IMG" && target.tagName !== "VIDEO")) return;
        if (target === lastHoverTarget) return;
        lastHoverTarget = target;
        publishMenuMode(target, false);
    };
    addDocListener("mouseover", onMouseOver, true);

    const onContextMenuTarget = (event) => {
        if (disposed) return;
        const target = event.target;
        lastContextImage = target && target.tagName === "IMG" ? target : null;
        lastContextVideo = target && target.tagName === "VIDEO" ? target : null;
        publishMenuMode(target, true);
    };
    addDocListener("contextmenu", onContextMenuTarget, true);

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
        return describeMediaElements(lastContextVideo, lastContextImage);
    }

    // 右键和选择面板共用元素解析，面板不依赖上一次右键的位置。
    function describeMediaElements(video, image) {

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

        return {
            found: Boolean(videoUrl && imageUrl),
            reason: !videoUrl ? "No video URL was found for this Live Photo." :
                !imageUrl ? "No cover image was found for this Live Photo." : undefined,
            imageUrl,
            videoUrl,
            // 时长未知时保留旧的封面判定规则。
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
        // blob: 由页面创建，只有页面上下文能读到。这里不再拒绝，
        // 让 Live Photo 的动态段有机会被完整取出。
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

    // 小红书、Instagram 会在图片上叠链接、按钮和渐变遮罩。右键落在覆盖层
    // 上时 Chrome 判定为普通页面，image 菜单不会出现。这里记录右键坐标，
    // 菜单点击后按坐标找出最上层的媒体元素。
    let lastContextPoint = null;

    const onContextMenuPoint = (event) => {
        if (disposed || !event.isTrusted) return;
        lastContextPoint = {
            x: event.clientX,
            y: event.clientY,
            time: Date.now(),
        };
    };
    addDocListener("contextmenu", onContextMenuPoint, true);

    // 背景图样式的地址提取。渐变背景匹配不到 url()，会被跳过。
    function backgroundImageUrl(el) {
        const bg = getComputedStyle(el).backgroundImage;
        if (!bg || bg === "none") return null;
        const matched = /url\(["']?([^"')]+)["']?\)/.exec(bg);
        if (!matched) return null;
        const url = absoluteUrl(matched[1]);
        return /^https?:/i.test(url || "") ? url : null;
    }

    function mediaAtPoint(x, y) {
        let stack = [];
        if (typeof document.elementsFromPoint === "function") {
            stack = document.elementsFromPoint(x, y) || [];
        } else if (document.elementFromPoint) {
            const top = document.elementFromPoint(x, y);
            if (top) stack = [top];
        }

        for (const el of stack) {
            if (el.tagName === "IMG") {
                const candidates = imageCandidates(el);
                if (candidates.length) {
                    lastContextImage = el;
                    lastContextVideo = null;
                    const pair = describeMediaElements(null, el);
                    return {
                        ok: true,
                        kind: "image",
                        url: candidates[0],
                        candidates,
                        livePhoto: pair.found ? pair : null,
                    };
                }
                continue;
            }

            if (el.tagName === "VIDEO") {
                const pair = describeMediaElements(el, null);
                const url = pair.videoUrl || absoluteUrl(el.currentSrc || el.getAttribute("src"));
                if (url) {
                    lastContextVideo = el;
                    lastContextImage = null;
                    return {
                        ok: true,
                        kind: "video",
                        url,
                        candidates: [url],
                        videoDuration: pair.videoDuration,
                        livePhoto: pair.found ? pair : null,
                    };
                }
                continue;
            }

            const bg = backgroundImageUrl(el);
            if (bg) {
                const candidates = [stripThumbnailParams(bg), bg].filter(Boolean);
                return {
                    ok: true,
                    kind: "image",
                    url: candidates[0],
                    candidates,
                };
            }
        }

        return { ok: false };
    }

    function resolveAtCursor() {
        if (!lastContextPoint) {
            return { ok: false, reason: "No right-click was recorded on this page." };
        }
        if (Date.now() - lastContextPoint.time > 120000) {
            return { ok: false, reason: "The right-click was too long ago, try again." };
        }
        return mediaAtPoint(lastContextPoint.x, lastContextPoint.y);
    }

    // 小红书 CDN：sns-webpic 是预览域，sns-img 是原图域，路径末尾的
    // !<style>（如 !nd_dft_wlteh_webp_3）是 webp 转码样式。两者都会压低
    // 分辨率，换成原图域并去掉样式后才是原图。
    function xhsOriginalUrls(url) {
        try {
            const parsed = new URL(url);
            if (!/(^|\.)xhscdn\.com$/i.test(parsed.hostname)) return [];

            const path = parsed.pathname.replace(/![^/]*$/, "");
            const hosts = [];
            if (/^sns-webpic/i.test(parsed.hostname)) {
                hosts.push(parsed.hostname.replace(/^sns-webpic/i, "sns-img"));
            }
            hosts.push(parsed.hostname);

            const out = [];
            for (const host of hosts) {
                const candidate = `${parsed.protocol}//${host}${path}`;
                if (candidate !== url && !out.includes(candidate)) out.push(candidate);
            }
            return out;
        } catch {
            return [];
        }
    }

    // 按可信度排列候选地址：原图在前，去参数的次之，原始地址留作回退
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
            for (const candidate of xhsOriginalUrls(url)) {
                if (seen.has(candidate)) continue;
                seen.add(candidate);
                out.push(candidate);
            }
        }

        for (const url of raw) {
            for (const candidate of [stripThumbnailParams(url), url]) {
                if (!/^https?:/i.test(candidate) || seen.has(candidate)) continue;
                seen.add(candidate);
                out.push(candidate);
            }
        }

        return out.slice(0, 4);
    }

    // 小红书详情是页内浮层，打开后浮层里只有当前一张大图，背后的信息流
    // 还挂着一串封面。浮层里能找到大图时只收浮层内的，避免收进无关封面。
    function pickMediaPool() {
        const all = {
            images: Array.from(document.images || []),
            videos: Array.from(document.querySelectorAll?.("video") || []),
        };
        const nodes = [];
        for (const selector of ['[role="dialog"]', ".note-detail-mask", ".note-detail", ".note-container"]) {
            for (const node of Array.from(document.querySelectorAll(selector) || [])) {
                nodes.push(node);
            }
        }

        for (const node of nodes) {
            const inside = Array.from(node.querySelectorAll?.("img") || []);
            const large = inside.filter((img) => {
                const rect = img.getBoundingClientRect?.();
                const width = Math.max(img.naturalWidth || 0, img.width || 0, Math.round(rect?.width || 0));
                const height = Math.max(img.naturalHeight || 0, img.height || 0, Math.round(rect?.height || 0));
                return width >= 300 && height >= 300;
            });
            const videos = Array.from(node.querySelectorAll?.("video") || []);
            if (large.length || videos.length) return { images: large, videos };
        }

        return all;
    }

    function collectImages(limit = 20, pool = pickMediaPool().images) {
        const seen = new Set();
        const items = [];

        for (const img of pool) {
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
            items.push({
                url: primary,
                // 面板缩略图用页面真正加载成功的地址。原图候选是改写域名
                // 猜出来的，浏览器直接 img 加载会被 CDN 拒绝，显示成破图。
                displayUrl: absoluteUrl(img.currentSrc) || absoluteUrl(img.getAttribute?.("src")) || primary,
                // 原图在页面上是带站点自己的请求策略加载成功的，面板重发请求
                // 时沿用同一策略，否则部分 CDN 会因为 Referer 不同而拒绝。
                referrerPolicy: img.referrerPolicy || "",
                candidates,
                area: width * height,
                width,
                height,
            });
        }

        items.sort((a, b) => b.area - a.area);
        const picked = items.slice(0, limit);

        return {
            images: picked.map((item) => item.url),
            items: picked,
        };
    }

    // 与后台 isLongVideo 保持相同边界：超过 10 秒才按长视频保存。
    function pickerVideoKind(duration, imageUrl) {
        return imageUrl && !(Number.isFinite(duration) && duration > MAX_LIVE_PHOTO_SECONDS) ? "live" : "video";
    }

    function videoUnavailableReason(url, imageUrl, kind) {
        if (!url) return "No video URL is available.";
        if (!/^https?:/i.test(url)) {
            // Live Photo 的动态段经常是页面临时创建的 blob。封面仍然可下载，
            // 保存时先尝试从页面上下文取字节，失败再退回封面。
            if (kind !== "live") return "This video uses a blob or local URL and cannot be saved.";
            return /^https?:/i.test(imageUrl || "") ? "" : "The Live Photo cover URL cannot be downloaded.";
        }
        if (/\.(m3u8|mpd)(?:[?#]|$)/i.test(url)) return "Streaming playlists are not supported.";
        if (/\.(webm|mkv|avi)(?:[?#]|$)/i.test(url)) return "Only MP4 and MOV videos are supported.";
        if (kind === "live" && !/^https?:/i.test(imageUrl || "")) return "The Live Photo cover URL cannot be downloaded.";
        return "";
    }

    function collectMedia(limit = 60) {
        const pool = pickMediaPool();
        const images = collectImages(Infinity, pool.images).items.map(item => ({ ...item, kind: "image" }));
        const motion = [];
        const seen = new Set();
        const addMotion = (pair, element) => {
            const url = pair.videoUrl || "";
            if (url && seen.has(url)) return;
            if (url) seen.add(url);
            const rect = element.getBoundingClientRect?.();
            const width = element.videoWidth || element.naturalWidth || element.width || Math.round(rect?.width || 0);
            const height = element.videoHeight || element.naturalHeight || element.height || Math.round(rect?.height || 0);
            const imageUrl = pair.imageUrl || "";
            const kind = pickerVideoKind(pair.videoDuration, imageUrl);
            motion.push({
                kind, url, candidates: [url], imageUrl, displayUrl: imageUrl,
                videoDuration: pair.videoDuration, width, height, area: width * height,
                unavailableReason: videoUnavailableReason(url, imageUrl, kind),
                // 动态段不是普通 http 地址，保存时依赖页面上下文，可能退回封面
                coverFallback: kind === "live" && Boolean(url) && !/^https?:/i.test(url),
            });
        };
        for (const video of pool.videos) addMotion(describeMediaElements(video, null), video);
        // 即刻等站点可能只在图片的组件数据中暴露动态段，不猜测同名视频。
        for (const image of pool.images) {
            const pair = readReactLivePhoto(image) || readReactLivePhoto(image.parentElement);
            if (pair?.videoUrl) {
                addMotion({ ...pair, imageUrl: pair.imageUrl || absoluteUrl(image.currentSrc || image.src) }, image);
            }
        }
        // 可保存的 Live Photo 已包含封面，同一封面不再默认单独上传一份。
        const covers = new Set(motion.filter(item => item.kind === "live" && !item.unavailableReason).map(item => item.imageUrl));
        return [...images.filter(item => !covers.has(item.displayUrl) && !covers.has(item.url)), ...motion]
            .sort((a, b) => b.area - a.area).slice(0, limit);
    }

    function formatDuration(seconds) {
        if (!Number.isFinite(seconds) || seconds < 0) return "Duration unknown";
        const whole = Math.floor(seconds);
        return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
    }

    // --------------------------------------------------
    // 媒体选择面板：注入到页面内的覆盖层
    // --------------------------------------------------
    const PICKER_HOST_ID = "sgp-picker-host";

    function closePicker() {
        const existing = document.getElementById?.(PICKER_HOST_ID);
        if (existing) existing.remove();
    }

    function formatDimensions(item) {
        if (!item.width || !item.height) return "size unknown";
        return `${item.width} × ${item.height}`;
    }

    const PICKER_STYLE = `
.sgp-overlay { position: fixed; inset: 0; z-index: 2147483647; background: rgba(0, 0, 0, 0.55); display: flex; align-items: center; justify-content: center; padding: 24px; box-sizing: border-box; }
.sgp-panel { width: min(1180px, 100%); max-height: 88vh; background: #fff; border-radius: 14px; display: flex; flex-direction: column; overflow: hidden; box-shadow: 0 24px 64px rgba(0, 0, 0, 0.35); font-family: system-ui, -apple-system, "Segoe UI", sans-serif; }
.sgp-head { display: flex; flex-shrink: 0; align-items: center; justify-content: space-between; gap: 12px; padding: 14px 18px; border-bottom: 1px solid #ececec; }
.sgp-title { font-size: 15px; font-weight: 600; color: #111; }
.sgp-count { font-size: 12px; color: #666; }
.sgp-scroll { overflow-y: auto; overscroll-behavior: contain; flex: 1 1 auto; min-height: 0; padding: 16px 18px; }
.sgp-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 14px; align-items: start; }
.sgp-card { display: block; box-sizing: border-box; width: auto; margin: 0; border: 1px solid #e3e3e3; border-radius: 10px; overflow: hidden; background: #fafafa; cursor: pointer; transition: border-color .12s, box-shadow .12s; }
.sgp-card.selected { border-color: #1a73e8; box-shadow: 0 0 0 1px #1a73e8; }
.sgp-thumb { width: 100%; height: auto; display: block; object-fit: contain; background: #e8e8e8; }
.sgp-thumb.missing { min-height: 48px; }
.sgp-preview-note { padding: 0 8px 8px; color: #8a6d3b; font-size: 11px; line-height: 1.4; }
.sgp-preview { position: relative; }
.sgp-play { position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); border: 1px solid #ffffff80; border-radius: 24px; padding: 10px 14px; background: #152333cc; color: #fff; font: 13px system-ui, sans-serif; cursor: pointer; }
.sgp-play[hidden] { display: none; }
.sgp-meta { display: flex; align-items: center; gap: 6px; padding: 6px 8px; font-size: 11px; color: #555; }
.sgp-meta input { margin: 0; accent-color: #1a73e8; }
.sgp-size { font-variant-numeric: tabular-nums; }
.sgp-media-info { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; padding: 0 8px 8px; font-size: 11px; color: #666; }
.sgp-kind { padding: 2px 6px; border-radius: 4px; background: #eee; color: #555; font-weight: 600; }
.sgp-kind[data-kind="live"] { background: #e4f2e9; color: #20683c; }
.sgp-kind[data-kind="video"] { background: #e5edfc; color: #2157a5; }
.sgp-duration { font-variant-numeric: tabular-nums; }
.sgp-note { color: #8a6d3b; font-size: 11px; }
.sgp-card.unavailable { cursor: default; border-style: dashed; }
.sgp-unavailable-reason { padding: 0 8px 8px; color: #9b3c27; font-size: 11px; line-height: 1.4; }
.sgp-foot { display: flex; flex-shrink: 0; flex-wrap: wrap; align-items: center; gap: 8px; padding: 12px 18px; border-top: 1px solid #ececec; }
.sgp-spacer { flex: 1; }
.sgp-btn { font: inherit; font-size: 13px; padding: 7px 14px; border-radius: 8px; border: 1px solid #d5d5d5; background: #fff; color: #222; cursor: pointer; }
.sgp-btn:hover { background: #f4f4f4; }
.sgp-btn.primary { background: #1a73e8; border-color: #1a73e8; color: #fff; font-weight: 600; }
.sgp-btn.primary:hover { background: #1667d0; }
.sgp-btn.link { border: none; background: none; color: #1a73e8; padding: 7px 6px; }
`;

    function renderPicker(items) {
        closePicker();

        // 站点自己的浮层常见 z-index 在十万级，这里压到最大值并固定定位，
        // 否则面板会被评论框、悬浮工具栏之类盖住
        const host = document.createElement("div");
        host.id = PICKER_HOST_ID;
        host.style.position = "fixed";
        host.style.inset = "0";
        host.style.zIndex = "2147483647";

        const shadow = host.attachShadow({ mode: "open" });
        const styleEl = document.createElement("style");
        styleEl.textContent = PICKER_STYLE;
        shadow.appendChild(styleEl);

        const overlay = document.createElement("div");
        overlay.className = "sgp-overlay";

        const panel = document.createElement("div");
        panel.className = "sgp-panel";

        const head = document.createElement("div");
        head.className = "sgp-head";

        const title = document.createElement("div");
        title.className = "sgp-title";
        title.textContent = "Images and videos on this page";

        const count = document.createElement("div");
        count.className = "sgp-count";

        head.appendChild(title);
        head.appendChild(count);

        // 滚动高度由外层约束，多列容器保持自然高度，卡片不会被压缩或拆开。
        const scroll = document.createElement("div");
        scroll.className = "sgp-scroll";
        const grid = document.createElement("div");
        grid.className = "sgp-grid";
        scroll.appendChild(grid);

        const boxes = [];
        for (const item of items) {
            const card = document.createElement("div");
            const isMotion = item.kind === "live" || item.kind === "video";
            card.className = item.unavailableReason ? "sgp-card unavailable" : "sgp-card selected";

            const thumb = document.createElement(isMotion ? "video" : "img");
            thumb.className = "sgp-thumb";
            if (item.width > 0 && item.height > 0) {
                thumb.style.aspectRatio = `${item.width} / ${item.height}`;
            } else if (isMotion) {
                thumb.style.aspectRatio = "16 / 9";
            }
            if (isMotion) {
                // 不自动播放，也不为打开选择器下载整段视频；用户点击后才预览。
                thumb.preload = "none";
                thumb.controls = false;
                thumb.muted = true;
                thumb.playsInline = true;
                if (item.displayUrl) thumb.poster = item.displayUrl;
                if (!item.unavailableReason) thumb.src = item.url;
            } else {
                thumb.loading = "lazy";
                thumb.decoding = "async";
                thumb.alt = "";
                // 缩略图优先使用页面已加载的地址，失败后才尝试下载候选。
                const sources = [];
                for (const url of [item.displayUrl, item.url, ...(item.candidates || [])]) {
                    if (url && !sources.includes(url)) sources.push(url);
                }
                let sourceIndex = 0;
                // 每个地址先按原策略请求，再退到不带 Referer 重试，最后才换地址。
                // 不能直接跳到候选地址：候选里的原图域是猜出来的，未必存在。
                let policies = [];
                let policyIndex = 0;
                let previewNote = null;
                const resetPolicies = () => {
                    policies = item.referrerPolicy === "no-referrer"
                        ? ["no-referrer"]
                        : [item.referrerPolicy || "", "no-referrer"];
                    policyIndex = 0;
                };
                const applySource = () => {
                    const policy = policies[policyIndex];
                    if (policy) thumb.setAttribute("referrerpolicy", policy);
                    else thumb.removeAttribute("referrerpolicy");
                    thumb.src = sources[sourceIndex];
                };
                const showPreviewFailure = () => {
                    thumb.removeAttribute("src");
                    thumb.classList.add("missing");
                    if (previewNote) return;
                    previewNote = document.createElement("div");
                    previewNote.className = "sgp-preview-note";
                    previewNote.textContent = "Preview unavailable. You can still select and save this image.";
                    card.appendChild(previewNote);
                };
                thumb.addEventListener("error", () => {
                    if (policyIndex + 1 < policies.length) {
                        policyIndex += 1;
                        applySource();
                        return;
                    }
                    if (sourceIndex + 1 < sources.length) {
                        sourceIndex += 1;
                        resetPolicies();
                        applySource();
                        return;
                    }
                    showPreviewFailure();
                });
                resetPolicies();
                applySource();
            }

            const meta = document.createElement("div");
            meta.className = "sgp-meta";
            const box = document.createElement("input");
            box.type = "checkbox";
            box.disabled = Boolean(item.unavailableReason);
            box.checked = !box.disabled;
            const size = document.createElement("span");
            size.className = "sgp-size";
            size.textContent = formatDimensions(item);
            meta.appendChild(box);
            meta.appendChild(size);

            const info = document.createElement("div");
            info.className = "sgp-media-info";
            const badge = document.createElement("span");
            badge.className = "sgp-kind";
            const updateKind = () => {
                badge.textContent = item.kind === "live" ? "Live Photo" : isMotion ? "Video" : "Image";
                badge.dataset.kind = item.kind || "image";
            };
            updateKind();
            info.appendChild(badge);
            if (item.coverFallback) {
                const note = document.createElement("span");
                note.className = "sgp-note";
                note.textContent = "cover fallback";
                info.appendChild(note);
            }
            if (isMotion) {
                const duration = document.createElement("span");
                duration.className = "sgp-duration";
                duration.textContent = formatDuration(item.videoDuration);
                info.appendChild(duration);
                thumb.addEventListener("loadedmetadata", () => {
                    // 预览拿到新时长后，标注和提交的快照一起更新，避免按旧类型保存。
                    if (Number.isFinite(thumb.duration)) item.videoDuration = thumb.duration;
                    item.kind = pickerVideoKind(item.videoDuration, item.imageUrl);
                    updateKind();
                    duration.textContent = formatDuration(item.videoDuration);
                    if (thumb.videoWidth > 0 && thumb.videoHeight > 0) {
                        item.width = thumb.videoWidth;
                        item.height = thumb.videoHeight;
                        size.textContent = formatDimensions(item);
                        thumb.style.aspectRatio = `${item.width} / ${item.height}`;
                    }
                });
            }
            if (isMotion) {
                const preview = document.createElement("div");
                preview.className = "sgp-preview";
                preview.appendChild(thumb);
                if (!item.unavailableReason) {
                    const play = document.createElement("button");
                    play.className = "sgp-play";
                    play.textContent = "▶";
                    play.setAttribute("aria-label", "Preview video");
                    play.addEventListener("click", (event) => {
                        event.stopPropagation?.();
                        play.hidden = true;
                        thumb.controls = true;
                        thumb.play().catch(() => {
                            thumb.controls = false;
                            play.hidden = false;
                            play.textContent = "Retry preview";
                        });
                    });
                    preview.appendChild(play);
                }
                card.appendChild(preview);
            } else {
                card.appendChild(thumb);
            }
            card.appendChild(meta);
            card.appendChild(info);
            if (item.unavailableReason) {
                const reason = document.createElement("div");
                reason.className = "sgp-unavailable-reason";
                reason.textContent = item.unavailableReason;
                card.appendChild(reason);
            }
            grid.appendChild(card);
            boxes.push(box);

            const sync = () => {
                card.classList.toggle("selected", box.checked);
                updateCount();
            };
            box.addEventListener("change", sync);
            card.addEventListener("click", (event) => {
                if (box.disabled || event.target === box || (isMotion && event.target === thumb)) return;
                box.checked = !box.checked;
                sync();
            });
        }

        const foot = document.createElement("div");
        foot.className = "sgp-foot";

        const selectAll = document.createElement("button");
        selectAll.className = "sgp-btn link";
        selectAll.textContent = "Select all";

        const selectNone = document.createElement("button");
        selectNone.className = "sgp-btn link";
        selectNone.textContent = "Select none";

        const spacer = document.createElement("div");
        spacer.className = "sgp-spacer";

        const cancel = document.createElement("button");
        cancel.className = "sgp-btn";
        cancel.textContent = "Cancel";

        const save = document.createElement("button");
        save.className = "sgp-btn primary";

        foot.appendChild(selectAll);
        foot.appendChild(selectNone);
        foot.appendChild(spacer);
        foot.appendChild(cancel);
        foot.appendChild(save);

        panel.appendChild(head);
        panel.appendChild(scroll);
        panel.appendChild(foot);
        overlay.appendChild(panel);
        shadow.appendChild(overlay);
        document.documentElement.appendChild(host);

        function updateCount() {
            const selected = boxes.filter((box) => box.checked).length;
            count.textContent = `${selected} of ${items.length} selected`;
            save.textContent = selected ? `Save ${selected}` : "Save";
            save.disabled = !selected;
        }

        function setAll(checked) {
            boxes.forEach((box, index) => {
                box.checked = checked && !box.disabled;
                grid.children[index]?.classList.toggle("selected", box.checked);
            });
            updateCount();
        }

        selectAll.addEventListener("click", () => setAll(true));
        selectNone.addEventListener("click", () => setAll(false));
        cancel.addEventListener("click", closePicker);
        overlay.addEventListener("click", (event) => {
            if (event.target === overlay) closePicker();
        });

        save.addEventListener("click", () => {
            const chosen = items.filter((_, index) => boxes[index].checked && !boxes[index].disabled);
            if (!chosen.length) return;
            closePicker();
            chrome.runtime.sendMessage({ action: "saveSelectedItems", items: chosen });
        });

        updateCount();
        return { ok: true, count: items.length };
    }

    function openPicker() {
        closePicker();

        const items = collectMedia(60);

        if (!items.length) {
            const reason = "No large images or videos were found on this page.";
            createToast("error", "Nothing to save", reason);
            return { ok: false, reason };
        }

        return renderPicker(items);
    }

    // --------------------------------------------------
    // Listen for messages from background service worker
    // --------------------------------------------------
    const onRuntimeMessage = (request, _sender, sendResponse) => {
        if (disposed) return;
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

        if (request.action === "resolveAtCursor") {
            let result;
            try {
                result = resolveAtCursor();
            } catch (err) {
                result = { ok: false, reason: err.message || String(err) };
            }
            sendResponse(result);
            return true;
        }

        if (request.action === "openPicker") {
            let result;
            try {
                result = openPicker();
            } catch (err) {
                result = { ok: false, reason: err.message || String(err) };
            }
            sendResponse(result);
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
    };

    chrome.runtime.onMessage.addListener(onRuntimeMessage);

    window.__sgpCleanup = () => {
        disposed = true;
        domAbort?.abort?.();
        try {
            document.removeEventListener?.("mouseover", onMouseOver, true);
            document.removeEventListener?.("contextmenu", onContextMenuTarget, true);
            document.removeEventListener?.("contextmenu", onContextMenuPoint, true);
        } catch {
            // 忽略不支持 removeEventListener 的环境
        }
        try {
            chrome.runtime?.onMessage?.removeListener?.(onRuntimeMessage);
        } catch {
            // 忽略扩展上下文已断开的情况
        }
        closePicker();
    };
})();
