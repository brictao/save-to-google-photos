#!/usr/bin/env node
// 验证 v1.2.0 修复项：
// 1) motion-photo.js 边界检查：多 mdat 拒绝 faststart、空 stco、截断 mvhd、offset 溢出
// 2) background.js：下载超过 200MB 在流式读取时即中断且不触发页面上下文回退
// 3) background.js：blob/下载失败/非 MP4 的 Live Photo 均降级保存封面（含图片右键入口无 ctx.imageUrl 场景）
// 4) background.js：storage 并发写入不互相覆盖，signOut 使用 POST body 传 token
// 5) background.js：saveSelectedItems 拒绝非 http/https/blob 协议的恶意 URL
// 6) background.js：handleSaveAtCursor 对覆盖层上的 Live Photo 正确走合成流程
// 7) content.js：多次注入清理旧监听器和旧面板，Toast 节点不解析 HTML 且校验 type 白名单

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

// ---------- 1. motion-photo.js 边界检查 ----------
global.self = global;
require(path.resolve(__dirname, "../extension/motion-photo.js"));
const MP = self.MotionPhoto;

function makeBox(type, payload) {
  const out = new Uint8Array(8 + payload.length);
  const size = out.length;
  out[0] = (size >>> 24) & 0xff;
  out[1] = (size >>> 16) & 0xff;
  out[2] = (size >>> 8) & 0xff;
  out[3] = size & 0xff;
  out[4] = type.charCodeAt(0);
  out[5] = type.charCodeAt(1);
  out[6] = type.charCodeAt(2);
  out[7] = type.charCodeAt(3);
  out.set(payload, 8);
  return out;
}

function concatBytes(parts) {
  const total = parts.reduce((sum, p) => sum + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

{
  const ftyp = makeBox("ftyp", new Uint8Array([0x6d, 0x70, 0x34, 0x32, 0, 0, 0, 0]));
  const mdat1 = makeBox("mdat", new Uint8Array([1, 2, 3, 4]));
  const mdat2 = makeBox("mdat", new Uint8Array([5, 6, 7, 8]));
  const shortMvhd = makeBox("mvhd", new Uint8Array([0, 0, 0, 0, 0, 0]));
  const emptyStco = makeBox("stco", new Uint8Array([0, 0]));
  const moov = makeBox("moov", concatBytes([shortMvhd, emptyStco]));
  const multiMdatMp4 = concatBytes([ftyp, mdat1, mdat2, moov]);

  assert.equal(MP.analyzeMp4(multiMdatMp4).mdatCount, 2);
  assert.equal(MP.readDurationUs(multiMdatMp4), null, "截断 mvhd 应安全返回 null");
  assert.throws(
    () => MP.applyFaststart(multiMdatMp4),
    /multiple mdat boxes/i,
    "多 mdat 且 moov 在尾部时应拒绝重排"
  );

  // 单 mdat 但 stco 损坏/为空时，applyFaststart 不应崩溃
  const singleMdatMp4 = concatBytes([ftyp, mdat1, moov]);
  const reordered = MP.applyFaststart(singleMdatMp4);
  assert.equal(MP.isMp4(reordered), true);
  console.log("PASS  motion-photo.js 多 mdat 拒绝重排，截断 mvhd 与异常 stco 不越界");
}

// ---------- 2. background.js ----------
function createBgHarness(overrides = {}) {
  const storage = { sgp_history: [], sgp_seen: [] };
  const fetchCalls = [];
  const toasts = [];
  const tabMessages = [];
  const noop = () => {};
  const addListener = { addListener: noop };
  let runtimeListener = null;

  const context = {
    console: { log: noop, warn: noop, error: noop },
    TextEncoder,
    Blob,
    URL,
    URLSearchParams,
    setTimeout,
    clearTimeout,
    AbortController,
    importScripts: noop,
    self: { MotionPhoto: { isMp4: () => false, isJpeg: () => true, assemble: () => ({}) } },
    fetch: async (url, init) => {
      fetchCalls.push({ url, init });
      if (overrides.fetch) return overrides.fetch(url, init);
      return { ok: true, status: 200, headers: new Headers(), text: async () => "ok", arrayBuffer: async () => new ArrayBuffer(0) };
    },
    chrome: {
      runtime: {
        lastError: undefined,
        onInstalled: addListener,
        onStartup: addListener,
        onMessage: { addListener: (fn) => { runtimeListener = fn; } },
      },
      contextMenus: {
        create: noop,
        removeAll: (cb) => cb && cb(),
        update: noop,
        onClicked: addListener,
      },
      tabs: {
        onActivated: addListener,
        sendMessage: async (tabId, msg) => {
          tabMessages.push({ tabId, msg });
          if (overrides.sendMessage) return overrides.sendMessage(tabId, msg);
          throw new Error("no receiver");
        },
        get: async () => ({ id: 1, active: true }),
      },
      scripting: { executeScript: async () => {} },
      storage: {
        local: {
          get: (key, cb) => {
            setTimeout(() => cb({ [key]: structuredClone(storage[key]) }), 5);
          },
          set: (obj, cb) => {
            setTimeout(() => {
              Object.assign(storage, structuredClone(obj));
              cb();
            }, 5);
          },
        },
      },
      identity: {
        getAuthToken: (_o, cb) => cb("secret-oauth-token"),
        removeCachedAuthToken: (_o, cb) => cb(),
      },
    },
  };

  vm.createContext(context);
  vm.runInContext(
    fs.readFileSync(path.resolve(__dirname, "../extension/background.js"), "utf8"),
    context
  );
  return { context, storage, fetchCalls, toasts, tabMessages, getRuntimeListener: () => runtimeListener };
}

async function runBgTests() {
  // 2A) 流式下载超限立即中止且不回退页面
  {
    let pageFallbackCalled = false;
    const h = createBgHarness({
      fetch: async () => ({
        ok: true,
        status: 200,
        headers: {
          get: (name) => (name.toLowerCase() === "content-length" ? String(250 * 1024 * 1024) : "video/mp4"),
        },
        body: { getReader: () => ({ read: async () => ({ done: true }) }) },
      }),
      sendMessage: async (_tabId, msg) => {
        if (msg.action === "fetchAsBase64") pageFallbackCalled = true;
        return { ok: true };
      },
    });
    await assert.rejects(
      () => h.context.downloadMedia(1, "https://cdn.test/huge.mp4", "video"),
      /200\.00 MB/
    );
    assert.equal(pageFallbackCalled, false, "超限错误不能回退页面上下文");
    console.log("PASS  超过 200 MB 的响应在下载前即中断，不触发页面上下文回退");
  }

  // 2B) 图片右键入口触发 Live Photo，视频下载 403/HTTP 错误时正确降级保存封面
  {
    const h = createBgHarness();
    const savedCalls = [];
    h.context.showToast = () => {};
    h.context.notifyFailure = () => {};
    h.context.resolveLivePhotoPair = async () => {
      const err = new Error("Could not download this file: HTTP 403");
      err.downloadFailed = true;
      throw err;
    };
    h.context.saveOne = async (tabId, url, kind, opts) => {
      savedCalls.push({ tabId, url, kind, opts });
      return "saved";
    };
    const outcome = await h.context.handleLivePhoto(
      { id: 9 },
      "https://cdn.test/photo-cover.jpg",
      "image",
      { found: true, videoUrl: "blob:https://site.test/123" } // 故意不带 ctx.imageUrl
    );
    assert.equal(outcome, "saved");
    assert.equal(savedCalls.length, 1);
    assert.equal(savedCalls[0].url, "https://cdn.test/photo-cover.jpg");
    console.log("PASS  HTTP 403 主动语态及缺失 ctx.imageUrl 时均能正确降级保存封面");
  }

  // 2C) 并发写 history 与 seen 不互相覆盖
  {
    const h = createBgHarness();
    await Promise.all([
      h.context.addHistory({ status: "saved", kind: "image", name: "a.jpg", url: "u1", message: "1" }),
      h.context.addHistory({ status: "saved", kind: "image", name: "b.jpg", url: "u2", message: "2" }),
      h.context.addHistory({ status: "saved", kind: "image", name: "c.jpg", url: "u3", message: "3" }),
      h.context.markSeen("fp1"),
      h.context.markSeen("fp2"),
      h.context.markSeen("fp3"),
    ]);
    assert.equal(h.storage.sgp_history.length, 3);
    assert.equal(h.storage.sgp_seen.length, 3);
    console.log("PASS  并发 addHistory / markSeen 串行加锁后无覆盖丢失");
  }

  // 2D) signOut 使用 POST body 发送 token
  {
    const h = createBgHarness();
    const listener = h.getRuntimeListener();
    await new Promise((resolve) => {
      listener({ action: "signOut" }, {}, resolve);
    });
    assert.equal(h.fetchCalls.length, 1);
    assert.equal(h.fetchCalls[0].url, "https://oauth2.googleapis.com/revoke");
    assert.equal(h.fetchCalls[0].init.method, "POST");
    assert.ok(!h.fetchCalls[0].url.includes("secret-oauth-token"), "token 不能出现在 URL 中");
    assert.ok(h.fetchCalls[0].init.body.includes("secret-oauth-token"));
    console.log("PASS  signOut 通过 POST body 撤销 OAuth token，不在 URL 中暴露");
  }

  // 2E) saveSelectedItems 过滤非法协议 URL
  {
    const h = createBgHarness();
    const calls = [];
    h.context.runBatch = async (_tabId, entries) => {
      calls.push(...entries);
      return { total: entries.length, saved: entries.length, skipped: 0, failed: 0 };
    };
    await h.context.saveSelectedItems(5, [
      { kind: "image", url: "javascript:alert(1)" },
      { kind: "image", url: "file:///etc/passwd" },
      { kind: "video", url: "blob:https://site.test/x" },
      { kind: "image", url: "https://cdn.test/good.jpg", candidates: ["ftp://bad/a", "https://cdn.test/good.jpg"] },
    ]);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://cdn.test/good.jpg");
    assert.deepEqual(calls[0].candidates, ["https://cdn.test/good.jpg"]);
    console.log("PASS  saveSelectedItems 过滤非 http/https 协议与非法 candidates");
  }

  // 2F) handleSaveAtCursor 支持覆盖层上的 Live Photo
  {
    const h = createBgHarness();
    const liveCalls = [];
    h.context.requestAtCursor = async () => ({
      ok: true,
      kind: "image",
      url: "https://cdn.test/cover.jpg",
      candidates: ["https://cdn.test/cover.jpg"],
      livePhoto: {
        found: true,
        imageUrl: "https://cdn.test/cover.jpg",
        videoUrl: "https://cdn.test/motion.mp4",
        videoDuration: 3,
        via: "页面组件数据",
      },
    });
    h.context.handleLivePhoto = async (_tab, url, mediaType, ctx) => {
      liveCalls.push({ url, mediaType, ctx });
      return "saved";
    };
    await h.context.handleSaveAtCursor({ id: 7 });
    assert.equal(liveCalls.length, 1);
    assert.equal(liveCalls[0].ctx.videoUrl, "https://cdn.test/motion.mp4");
    console.log("PASS  handleSaveAtCursor 对覆盖层上的 Live Photo 走合成流程");
  }
}

// ---------- 3. content.js 清理与 Toast 安全性 ----------
function runContentTests() {
  const contentSource = fs.readFileSync(
    path.resolve(__dirname, "../extension/content.js"),
    "utf8"
  );

  const docListeners = [];
  const runtimeListeners = [];
  const removedElements = [];

  function makeEl(tag) {
    const el = {
      tagName: String(tag).toUpperCase(),
      children: [],
      parentNode: null,
      style: {},
      className: "",
      _textContent: "",
      _innerHTML: "",
      attrs: {},
      set innerHTML(v) {
        throw new Error("不应通过 innerHTML 写入 toast 内容");
      },
      get innerHTML() {
        return this._innerHTML;
      },
      set textContent(v) {
        this._textContent = v;
      },
      get textContent() {
        return this._textContent;
      },
      setAttribute(k, v) {
        this.attrs[k] = v;
      },
      getAttribute(k) {
        return this.attrs[k] ?? null;
      },
      classList: { add() {}, remove() {}, toggle() {} },
      appendChild(child) {
        this.children.push(child);
        child.parentNode = this;
        return child;
      },
      removeChild(child) {
        const idx = this.children.indexOf(child);
        if (idx >= 0) this.children.splice(idx, 1);
        child.parentNode = null;
      },
      remove() {
        removedElements.push(this);
      },
      addEventListener() {},
      querySelector() {
        return null;
      },
      querySelectorAll() {
        return [];
      },
    };
    return el;
  }

  const root = makeEl("html");
  let pickerHost = makeEl("div");
  pickerHost.id = "sgp-picker-host";

  const document = {
    documentElement: root,
    createElement: (tag) => makeEl(tag),
    getElementById: (id) => (id === "sgp-picker-host" ? pickerHost : null),
    querySelectorAll: () => [],
    addEventListener: (type, fn) => docListeners.push({ type, fn }),
    removeEventListener: (type, fn) => {
      const idx = docListeners.findIndex((item) => item.type === type && item.fn === fn);
      if (idx >= 0) docListeners.splice(idx, 1);
    },
  };

  const sandbox = {
    document,
    URL,
    TextEncoder,
    AbortController,
    console,
    setTimeout,
    clearTimeout,
    location: { href: "https://example.test/" },
    requestAnimationFrame: (fn) => fn(),
    chrome: {
      runtime: {
        onMessage: {
          addListener: (fn) => runtimeListeners.push(fn),
          removeListener: (fn) => {
            const idx = runtimeListeners.indexOf(fn);
            if (idx >= 0) runtimeListeners.splice(idx, 1);
          },
        },
        sendMessage: () => Promise.resolve(),
      },
    },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);

  // 连续注入两次 content.js
  vm.runInContext(contentSource, sandbox);
  const firstDocCount = docListeners.length;
  const firstMsgCount = runtimeListeners.length;
  assert.equal(firstMsgCount, 1);

  vm.runInContext(contentSource, sandbox);
  assert.equal(docListeners.length, firstDocCount, "重复注入不应叠加 document 事件监听");
  assert.equal(runtimeListeners.length, 1, "重复注入不应叠加 runtime.onMessage 监听");
  assert.ok(removedElements.includes(pickerHost), "重复注入应清理残留的 #sgp-picker-host");

  // 注入恶意 type，校验白名单回退到 error 且不使用 innerHTML
  runtimeListeners[0](
    { action: "showToast", type: "evil\" onclick=\"alert(1)", title: "<b>hi</b>", message: "<script>" },
    {},
    () => {}
  );
  const containers = root.children.filter((el) => el.className === "sgp-toast-container");
  const container = containers[containers.length - 1];
  const toast = container.children[0];
  assert.equal(toast.className, "sgp-toast sgp-toast--error");
  assert.equal(toast.__sgpTitleEl.textContent, "<b>hi</b>");
  assert.equal(toast.__sgpMessageEl.textContent, "<script>");
  console.log("PASS  content.js 重复注入清理旧实例，Toast 使用纯 DOM 构建且校验 type 白名单");
}

(async () => {
  await runBgTests();
  runContentTests();
  console.log("\n全部通过");
})().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
