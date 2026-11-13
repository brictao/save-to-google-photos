#!/usr/bin/env node
// 验证 content.js 的坐标反查：
// 1) 右键落在覆盖层上时仍能找到下层的 img
// 2) 渐变遮罩不会误判成图片
// 3) 背景图地址会被提取并剥离缩放参数
// 4) video 元素单独识别
// 5) 没记录坐标或坐标过期时给出可读原因

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const contentSource = fs.readFileSync(
  path.resolve(__dirname, "../extension/content.js"),
  "utf8"
);

let listeners = [];
let contextHandler = null;
let fakeNow = 1000;

// Date.now 用可控值，才能验证 120 秒过期逻辑
const RealDate = Date;
const SandboxDate = new Proxy(RealDate, {
  get(target, prop) {
    if (prop === "now") return () => fakeNow;
    return Reflect.get(target, prop);
  },
  construct(target, args) {
    return new RealDate(...args);
  },
});

function makeEl(tag, extra = {}) {
  return {
    tagName: String(tag).toUpperCase(),
    children: [],
    parentNode: null,
    style: {},
    className: "",
    textContent: "",
    innerHTML: "",
    dataset: {},
    setAttribute() {},
    getAttribute() { return null; },
    classList: { add() {}, remove() {}, contains() { return false; } },
    appendChild(child) {
      this.children.push(child);
      child.parentNode = this;
      return child;
    },
    removeChild() {},
    querySelector() { return null; },
    querySelectorAll() { return []; },
    addEventListener() {},
    ...extra,
  };
}

function makeImg(options) {
  const { currentSrc = "", src = "", srcset = "", dataset = {} } = options;
  return makeEl("img", {
    currentSrc,
    src,
    dataset,
    naturalWidth: 1200,
    naturalHeight: 900,
    width: 1200,
    height: 900,
    getAttribute(name) {
      if (name === "src") return src || null;
      if (name === "srcset") return srcset || null;
      return null;
    },
    getBoundingClientRect() {
      return { width: 1200, height: 900 };
    },
  });
}

// 小红书/Instagram 的典型结构：图片上面盖一层链接或遮罩
const photo = makeImg({
  currentSrc: "https://sns-webpic-qc.xhscdn.com/202401/abc!nd_dft_wlteh_webp_3",
});
const mask = makeEl("div");
mask.__bg = "linear-gradient(180deg, rgba(0,0,0,0.35), rgba(0,0,0,0))";

// 背景图形态的卡片
const bgCard = makeEl("div");
bgCard.__bg = 'url("https://cdn.example.com/cover.jpg?imageMogr2/thumbnail/300x")';

// 只有渐变，没有任何媒体
const emptyLayer = makeEl("div");
emptyLayer.__bg = "linear-gradient(90deg, #000, #fff)";

const clip = makeEl("video", {
  currentSrc: "",
  getAttribute(name) {
    if (name === "src") return "https://cdn.example.com/clip.mp4";
    return null;
  },
});

const stacks = new Map([
  ["10,10", [mask, photo]],
  ["20,20", [emptyLayer]],
  ["30,30", [bgCard]],
  ["40,40", [clip]],
  ["50,50", [emptyLayer]],
]);

const root = makeEl("html");

const document = {
  documentElement: root,
  createElement: (tag) => makeEl(tag),
  querySelectorAll: () => [],
  images: [photo],
  addEventListener(type, fn) {
    if (type === "contextmenu") contextHandler = fn;
  },
  elementsFromPoint(x, y) {
    return stacks.get(`${x},${y}`) || [];
  },
};

const chrome = {
  runtime: {
    onMessage: { addListener(fn) { listeners.push(fn); } },
    lastError: null,
    sendMessage: () => Promise.resolve(),
  },
};

const sandbox = {
  document,
  chrome,
  Date: SandboxDate,
  location: { href: "https://www.xiaohongshu.com/explore" },
  getComputedStyle: (el) => ({ backgroundImage: el.__bg || "none" }),
  URL,
  TextEncoder,
  console,
  setTimeout,
  clearTimeout,
  requestAnimationFrame: (fn) => fn(),
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;

vm.createContext(sandbox);
vm.runInContext(contentSource, sandbox);

let failures = 0;
function check(name, ok, detail) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  ${detail}` : ""}`);
  if (!ok) failures++;
}

const listener = listeners[0];

function ask() {
  let result = null;
  listener({ action: "resolveAtCursor" }, {}, (value) => {
    result = value;
  });
  return result;
}

function rightClick(x, y) {
  contextHandler({ isTrusted: true, clientX: x, clientY: y });
}

check("没有右键记录时给出原因", ask()?.ok === false && /No right-click/.test(ask()?.reason || ""));

rightClick(10, 10);
const throughMask = ask();
check("穿过覆盖层找到下层图片", throughMask?.ok === true && throughMask?.kind === "image");
check(
  "小红书预览地址换成原图域",
  throughMask?.url === "https://sns-img-qc.xhscdn.com/202401/abc",
  throughMask?.url
);
check(
  "原始预览地址留作回退",
  (throughMask?.candidates || []).includes(
    "https://sns-webpic-qc.xhscdn.com/202401/abc!nd_dft_wlteh_webp_3"
  ),
  (throughMask?.candidates || []).join(" | ")
);

rightClick(20, 20);
const gradientOnly = ask();
check("渐变遮罩不会被当成图片", gradientOnly?.ok === false);

rightClick(30, 30);
const bg = ask();
check("背景图地址被提取", bg?.ok === true && bg?.url === "https://cdn.example.com/cover.jpg", bg?.url);

rightClick(40, 40);
const video = ask();
check("video 元素被识别", video?.ok === true && video?.kind === "video" && video?.url === "https://cdn.example.com/clip.mp4");

rightClick(50, 50);
fakeNow = 1000 + 130000;
const expired = ask();
check("坐标超过 120 秒后失效", expired?.ok === false && /too long ago/.test(expired?.reason || ""), expired?.reason);

console.log(failures === 0 ? "\n全部通过" : `\n${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
