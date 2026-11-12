// ============================================================
// Save to Google Photos — Content Script (In-page Toast)
// ============================================================

(() => {
    // Prevent double-injection
    if (window.__saveToGooglePhotosToast) return;
    window.__saveToGooglePhotosToast = true;

    // --------------------------------------------------
    // Inject styles
    // --------------------------------------------------
    const style = document.createElement("style");
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
        // Remove loading toast if showing a result
        if (type !== "loading" && currentLoadingToast) {
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
    // Listen for messages from background service worker
    // --------------------------------------------------
    chrome.runtime.onMessage.addListener((request) => {
        if (request.action === "showToast") {
            createToast(request.type, request.title, request.message);
        }
    });
})();
