#!/usr/bin/env node
// 用最小 DOM 模拟验证 content.js 的配套视频查找分支。
// 不覆盖真实浏览器渲染，只验证查找决策逻辑。

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const contentSource = fs.readFileSync(
  path.resolve(__dirname, "../content.js"),
  "utf8"
);

let listeners = [];

function makeEl(tag, attrs = {}) {
  return {
    tagName: tag.toUpperCase(),
    className: "",
    style: {},
    textContent: "",
    innerHTML: "",
    children: [],
    parentElement: null,
    nodeType: 1,
    attrs,
    videoChild: null,
    classList: { add() {}, remove() {} },
    appendChild(child) {
      this.children.push(child);
      child.parentElement = this;
      return child;
    },
    removeChild() {},
    querySelector(selector) {
      if (selector === "video" && this.videoChild) return this.videoChild;
      return null;
    },
    querySelectorAll() { return []; },
    getAttribute(name) { return this.attrs[name] ?? null; },
    addEventListener() {},
  };
}

function makeImage(src, parent = null) {
  const img = makeEl("img");
  img.src = src;
  img.currentSrc = src;
  if (parent) parent.appendChild(img);
  return img;
}

function runCase(name, { images, imageUrl, wire }, assertion) {
  listeners = [];

  const htmlElement = makeEl("html");
  htmlElement.appendChild = function (child) {
    this.children.push(child);
    return child;
  };

  const document = {
    documentElement: htmlElement,
    images,
    createElement: (tag) => makeEl(tag),
    addEventListener() {},
  };

  const chrome = {
    runtime: {
      onMessage: { addListener(fn) { listeners.push(fn); } },
      lastError: null,
    },
  };

  const sandbox = {
    document,
    chrome,
    location: { href: "http://127.0.0.1:8765/index.html" },
    URL,
    TextEncoder,
    console,
    setTimeout,
    requestAnimationFrame: (fn) => fn(),
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;

  if (wire) wire({ document, sandbox });

  vm.createContext(sandbox);
  vm.runInContext(contentSource, sandbox);

  const listener = listeners[0];
  if (!listener) {
    console.log(`FAIL  ${name}  未注册消息监听器`);
    return false;
  }

  let response;
  listener({ action: "findLivePhotoVideo", imageUrl }, {}, (r) => { response = r; });

  const ok = assertion(response);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}  ${JSON.stringify(response)}`);
  return ok;
}

let failures = 0;
const record = (ok) => { if (!ok) failures++; };

// ---------- 用例 1：只有图片，靠同名推导 ----------
{
  const img = makeImage("http://127.0.0.1:8765/IMG_4038.jpg");
  record(runCase("只有图片时按同名推导视频", {
    images: [img],
    imageUrl: img.src,
  }, (r) =>
    r && r.found === false && Array.isArray(r.candidates) &&
    r.candidates.includes("http://127.0.0.1:8765/IMG_4038.MOV") &&
    r.candidates.includes("http://127.0.0.1:8765/IMG_4038.mp4")
  ));
}

// ---------- 用例 2：图片旁边有 video 元素 ----------
{
  const container = makeEl("div");
  const img = makeImage("http://127.0.0.1:8765/nearby.jpg", container);
  const video = makeEl("video");
  video.currentSrc = "http://127.0.0.1:8765/IMG_4038.MOV";
  video.src = video.currentSrc;
  container.videoChild = video;

  record(runCase("相邻 video 元素被识别", {
    images: [img],
    imageUrl: img.src,
  }, (r) =>
    r && r.found === true && r.videoUrl === "http://127.0.0.1:8765/IMG_4038.MOV"
  ));
}

// ---------- 用例 3：既无视频也无同名可能 ----------
{
  const img = makeImage("https://cdn.example.com/photo?id=42");
  record(runCase("无法推导时返回原因", {
    images: [img],
    imageUrl: img.src,
  }, (r) =>
    r && r.found === false && !r.candidates && typeof r.reason === "string"
  ));
}

console.log(failures === 0 ? "\n全部通过" : `\n${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
