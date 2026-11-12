#!/usr/bin/env node
// 验证 content.js 从右键元素解析配对信息的分支。
// 覆盖「视频没有 src，地址只在组件数据里」这种站点结构。

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const contentSource = fs.readFileSync(
  path.resolve(__dirname, "../extension/content.js"),
  "utf8"
);

let listeners = [];
let contextMenuHandlers = [];

const FIBER_KEY = "__reactFiber$test123";

function makeEl(tag, attrs = {}) {
  return {
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
}

// 在元素上挂一条 React fiber 链
function attachFiber(el, propsChain) {
  let fiber = null;
  for (let i = propsChain.length - 1; i >= 0; i--) {
    fiber = { memoizedProps: propsChain[i], return: fiber };
  }
  el[FIBER_KEY] = fiber;
}

function runCase(name, { tree, fireContextMenuOn }, assertion) {
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
    location: { href: "https://web.okjike.com/u/test/post/test" },
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

  if (fireContextMenuOn) {
    for (const handler of contextMenuHandlers) handler({ target: fireContextMenuOn });
  }

  const listener = listeners[0];
  if (!listener) {
    console.log(`FAIL  ${name}  未注册消息监听器`);
    return false;
  }

  let response;
  listener({ action: "findLivePhotoFromContext" }, {}, (r) => { response = r; });

  const ok = assertion(response);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  console.log(`      ${JSON.stringify(response)}`);
  return ok;
}

let failures = 0;
const record = (ok) => { if (!ok) failures++; };

// ---------- 用例 1：即刻结构，video 无 src，数据在 props.data ----------
{
  const container = makeEl("div");
  const img = makeEl("img");
  img.src = "https://cdnv2.ruguoapp.com/LPFgQy.heic?imageMogr2/format/jpeg/thumbnail/400x2000%3E";
  img.currentSrc = img.src;

  const video = makeEl("video", { class: "live-photo-video", playsinline: "" });

  container.appendChild(img);
  container.appendChild(video);

  // 组件数据在父容器的 fiber 上，路径与即刻实际结构一致
  attachFiber(container, [
    { className: "outer" },
    {
      data: {
        imageUrl: "https://cdnv2.ruguoapp.com/LPFgQy.heic?imageMogr2/meta-keep-list/ZXhpZixVc2VyQ29tbWVudA==/format/jpeg",
        videoUrl: "https://cdnv2.ruguoapp.com/LPltNS96INq20-mBK9VBeBgB-vtVtW.mp4",
      },
    },
  ]);

  record(runCase("即刻结构：视频无 src，从组件数据取地址", {
    tree: container,
    fireContextMenuOn: video,
  }, (r) =>
    r && r.found === true &&
    r.videoUrl === "https://cdnv2.ruguoapp.com/LPltNS96INq20-mBK9VBeBgB-vtVtW.mp4" &&
    r.imageUrl.includes("meta-keep-list") &&
    r.via === "页面组件数据"
  ));
}

// ---------- 用例 2：数据挂在 props.livePhoto ----------
{
  const container = makeEl("div");
  const video = makeEl("video");
  container.appendChild(video);

  attachFiber(video, [
    {
      livePhoto: {
        imageUrl: "/photo-full.jpg",
        videoUrl: "/clip.mp4",
      },
    },
  ]);

  record(runCase("props.livePhoto 结构", {
    tree: container,
    fireContextMenuOn: video,
  }, (r) =>
    r && r.found === true &&
    r.videoUrl === "https://web.okjike.com/clip.mp4" &&
    r.imageUrl === "https://web.okjike.com/photo-full.jpg"
  ));
}

// ---------- 用例 3：video 自身有 src，优先用自身 ----------
{
  const container = makeEl("div");
  const video = makeEl("video");
  video.currentSrc = "https://cdn.example.com/own.mp4";
  video.src = video.currentSrc;
  const img = makeEl("img", { poster: "https://cdn.example.com/cover.jpg" });
  img.src = "https://cdn.example.com/cover.jpg";
  img.currentSrc = img.src;
  container.appendChild(video);
  container.appendChild(img);

  record(runCase("video 自身有 src 时直接使用", {
    tree: container,
    fireContextMenuOn: video,
  }, (r) =>
    r && r.found === true &&
    r.videoUrl === "https://cdn.example.com/own.mp4" &&
    r.imageUrl === "https://cdn.example.com/cover.jpg"
  ));
}

// ---------- 用例 4：既无 src 也无组件数据 ----------
{
  const container = makeEl("div");
  const video = makeEl("video");
  const img = makeEl("img");
  img.src = "https://cdn.example.com/only-cover.jpg";
  img.currentSrc = img.src;
  container.appendChild(video);
  container.appendChild(img);

  record(runCase("无视频地址时给出原因", {
    tree: container,
    fireContextMenuOn: video,
  }, (r) =>
    r && r.found === false && typeof r.reason === "string"
  ));
}

// ---------- 用例 5：右键在图片上，数据取到视频 ----------
{
  const container = makeEl("div");
  const img = makeEl("img");
  img.src = "https://cdnv2.ruguoapp.com/LPFgQy.heic?thumbnail/400";
  img.currentSrc = img.src;
  const video = makeEl("video");
  container.appendChild(img);
  container.appendChild(video);

  attachFiber(container, [
    {
      data: {
        imageUrl: "https://cdnv2.ruguoapp.com/LPFgQy.heic?format/jpeg",
        videoUrl: "https://cdnv2.ruguoapp.com/LPltNS96.mp4",
      },
    },
  ]);

  record(runCase("图片入口也能取到组件里的视频", {
    tree: container,
    fireContextMenuOn: img,
  }, (r) =>
    r && r.found === true &&
    r.videoUrl === "https://cdnv2.ruguoapp.com/LPltNS96.mp4"
  ));
}

console.log(failures === 0 ? "\n全部通过" : `\n${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
