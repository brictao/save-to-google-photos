#!/usr/bin/env node
// 验证 content.js 从 video 入口查找封面图的分支。
// 只验证查找决策，不覆盖真实浏览器渲染。

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const contentSource = fs.readFileSync(
  path.resolve(__dirname, "../extension/content.js"),
  "utf8"
);

let listeners = [];
let contextMenuHandlers = [];

function makeEl(tag, attrs = {}) {
  const el = {
    tagName: tag.toUpperCase(),
    children: [],
    parentElement: null,
    attrs,
    src: "",
    currentSrc: "",
    naturalWidth: 0,
    naturalHeight: 0,
    style: {},
    className: "",
    textContent: "",
    innerHTML: "",
    classList: { add() {}, remove() {}, contains() { return false; } },
    appendChild(child) {
      this.children.push(child);
      child.parentElement = this;
      return child;
    },
    removeChild() {},
    querySelector(selector) {
      return this.querySelectorAll(selector)[0] || null;
    },
    querySelectorAll(selector) {
      const tag = selector.toUpperCase();
      const out = [];
      const walk = (node) => {
        for (const child of node.children) {
          if (child.tagName === tag) out.push(child);
          walk(child);
        }
      };
      walk(this);
      return out;
    },
    getAttribute(name) {
      return this.attrs[name] ?? null;
    },
    setAttribute(name, value) {
      this.attrs[name] = value;
    },
    addEventListener() {},
  };
  return el;
}

function runCase(name, { tree, videoUrl, fireContextMenuOn }, assertion) {
  listeners = [];
  contextMenuHandlers = [];

  const htmlElement = makeEl("html");
  htmlElement.appendChild(tree);

  const document = {
    documentElement: htmlElement,
    get images() {
      return htmlElement.querySelectorAll("img");
    },
    createElement: (tag) => makeEl(tag),
    querySelectorAll: (sel) => htmlElement.querySelectorAll(sel),
    addEventListener(type, fn) {
      if (type === "contextmenu") contextMenuHandlers.push(fn);
    },
  };

  const chrome = {
    runtime: {
      onMessage: { addListener(fn) { listeners.push(fn); } },
      sendMessage: () => Promise.resolve({ ok: true }),
      lastError: null,
    },
  };

  const sandbox = {
    document,
    chrome,
    location: { href: "http://127.0.0.1:8765/video-entry.html" },
    URL,
    TextEncoder,
    console,
    setTimeout,
    requestAnimationFrame: (fn) => fn(),
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;

  vm.createContext(sandbox);
  vm.runInContext(contentSource, sandbox);

  // 模拟右键发生在 video 上
  if (fireContextMenuOn) {
    for (const handler of contextMenuHandlers) {
      handler({ target: fireContextMenuOn });
    }
  }

  const listener = listeners[0];
  if (!listener) {
    console.log(`FAIL  ${name}  未注册消息监听器`);
    return false;
  }

  let response;
  listener({ action: "findLivePhotoCover", videoUrl }, {}, (r) => { response = r; });

  const ok = assertion(response);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}  ${JSON.stringify(response)}`);
  return ok;
}

let failures = 0;
const record = (ok) => { if (!ok) failures++; };

// ---------- 用例 1：video 自带 poster ----------
{
  const container = makeEl("div");
  const video = makeEl("video", { poster: "/IMG_4038.jpg" });
  video.currentSrc = "http://127.0.0.1:8765/IMG_4038.MOV";
  video.src = video.currentSrc;
  container.appendChild(video);

  record(runCase("video 的 poster 被用作封面", {
    tree: container,
    videoUrl: video.currentSrc,
    fireContextMenuOn: video,
  }, (r) =>
    r && r.found === true &&
    r.imageUrl === "http://127.0.0.1:8765/IMG_4038.jpg" &&
    r.via === "video 的 poster 属性"
  ));
}

// ---------- 用例 2：无 poster，旁边有 img ----------
{
  const container = makeEl("div");
  const video = makeEl("video");
  video.currentSrc = "http://127.0.0.1:8765/clip.mp4";
  video.src = video.currentSrc;
  const img = makeEl("img");
  img.src = "http://127.0.0.1:8765/cover.jpg";
  img.currentSrc = img.src;
  img.naturalWidth = 1200;
  img.naturalHeight = 1600;
  container.appendChild(video);
  container.appendChild(img);

  record(runCase("无 poster 时取附近的图片元素", {
    tree: container,
    videoUrl: video.currentSrc,
    fireContextMenuOn: video,
  }, (r) =>
    r && r.found === true &&
    r.imageUrl === "http://127.0.0.1:8765/cover.jpg" &&
    r.via === "video 附近的图片元素"
  ));
}

// ---------- 用例 3：多个 img，取面积最大的 ----------
{
  const container = makeEl("div");
  const video = makeEl("video");
  video.currentSrc = "http://127.0.0.1:8765/clip2.mp4";
  video.src = video.currentSrc;

  const icon = makeEl("img");
  icon.src = "http://127.0.0.1:8765/icon.png";
  icon.currentSrc = icon.src;
  icon.naturalWidth = 16;
  icon.naturalHeight = 16;

  const cover = makeEl("img");
  cover.src = "http://127.0.0.1:8765/big-cover.jpg";
  cover.currentSrc = cover.src;
  cover.naturalWidth = 2000;
  cover.naturalHeight = 1500;

  container.appendChild(video);
  container.appendChild(icon);
  container.appendChild(cover);

  record(runCase("多个图片时优先取面积最大的", {
    tree: container,
    videoUrl: video.currentSrc,
    fireContextMenuOn: video,
  }, (r) =>
    r && r.found === true &&
    r.imageUrl === "http://127.0.0.1:8765/big-cover.jpg"
  ));
}

// ---------- 用例 4：既无 poster 也无图片 ----------
{
  const container = makeEl("div");
  const video = makeEl("video");
  video.currentSrc = "http://127.0.0.1:8765/lonely.mp4";
  video.src = video.currentSrc;
  container.appendChild(video);

  record(runCase("找不到封面图时返回原因", {
    tree: container,
    videoUrl: video.currentSrc,
    fireContextMenuOn: video,
  }, (r) =>
    r && r.found === false && typeof r.reason === "string"
  ));
}

// ---------- 用例 5：右键元素丢失时按 URL 回查 ----------
{
  const container = makeEl("div");
  const video = makeEl("video", { poster: "/fallback.jpg" });
  video.currentSrc = "http://127.0.0.1:8765/fallback.mp4";
  video.src = video.currentSrc;
  container.appendChild(video);

  record(runCase("未捕获右键元素时按 URL 回查 video", {
    tree: container,
    videoUrl: video.currentSrc,
    fireContextMenuOn: null,
  }, (r) =>
    r && r.found === true &&
    r.imageUrl === "http://127.0.0.1:8765/fallback.jpg"
  ));
}

console.log(failures === 0 ? "\n全部通过" : `\n${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
