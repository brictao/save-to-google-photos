#!/usr/bin/env node
// 验证 content.js 的批量收集：
// 1) 只收大图，跳过图标与占位
// 2) 去重、跳过 blob 与 data 地址、相对地址补全
// 3) 缩略图参数会被剥离，format 段保留
// 4) srcset 里取最大的一项

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const contentSource = fs.readFileSync(
  path.resolve(__dirname, "../extension/content.js"),
  "utf8"
);

let listeners = [];

function makeEl(tag) {
  return {
    tagName: String(tag).toUpperCase(),
    children: [],
    parentNode: null,
    style: {},
    className: "",
    textContent: "",
    innerHTML: "",
    setAttribute() {},
    classList: { add() {}, remove() {}, contains() { return false; } },
    appendChild(child) {
      this.children.push(child);
      child.parentNode = this;
      return child;
    },
    removeChild(child) {
      const i = this.children.indexOf(child);
      if (i >= 0) this.children.splice(i, 1);
      child.parentNode = null;
    },
    querySelector(selector) {
      if (selector === ".sgp-toast-close") return { addEventListener() {} };
      return null;
    },
    querySelectorAll() { return []; },
    addEventListener() {},
  };
}

const root = makeEl("html");

function makeImg(options) {
  const {
    currentSrc = "",
    src = "",
    srcset = "",
    dataset = {},
    width = 0,
    height = 0,
  } = options;

  return {
    tagName: "IMG",
    currentSrc,
    src,
    naturalWidth: width,
    naturalHeight: height,
    width,
    height,
    dataset,
    getAttribute(name) {
      if (name === "src") return src || null;
      if (name === "srcset") return srcset || null;
      return null;
    },
    getBoundingClientRect() {
      return { width, height };
    },
  };
}

const images = [
  // 普通大图
  makeImg({ currentSrc: "https://cdn.example.com/hero.jpg", width: 1600, height: 900 }),
  // 小图应当被跳过
  makeImg({ currentSrc: "https://cdn.example.com/thumb.jpg", width: 120, height: 120 }),
  // 重复地址
  makeImg({ currentSrc: "https://cdn.example.com/hero.jpg", width: 1600, height: 900 }),
  // blob 地址
  makeImg({ currentSrc: "blob:https://example.com/2f8a", width: 900, height: 900 }),
  // 相对地址
  makeImg({ currentSrc: "", src: "/relative/photo.png", width: 800, height: 600 }),
  // data 地址
  makeImg({ currentSrc: "data:image/png;base64,AAAA", width: 800, height: 600 }),
  // 七牛缩放参数：应剥离到原始地址
  makeImg({
    currentSrc: "https://cdnv2.ruguoapp.com/thumb.jpg?imageView2/2/w/400/q/90",
    width: 1200,
    height: 900,
  }),
  // 七牛缩放加 format：只保留 format
  makeImg({
    currentSrc: "https://cdnv2.ruguoapp.com/plain.jpg?imageView2/2/w/400/format/jpeg",
    width: 1200,
    height: 900,
  }),
  // imageMogr2 形态
  makeImg({
    currentSrc: "https://cdnv2.ruguoapp.com/mogr.jpg?imageMogr2/thumbnail/300x",
    width: 1000,
    height: 1000,
  }),
  // srcset：应取 2000w 那一项
  makeImg({
    currentSrc: "https://cdn.example.com/small.jpg",
    src: "https://cdn.example.com/small.jpg",
    srcset: "https://cdn.example.com/small.jpg 200w, https://cdn.example.com/large.jpg 2000w",
    width: 400,
    height: 300,
  }),
  // 小红书预览域：应换成原图域并去掉 webp 样式
  makeImg({
    currentSrc: "https://sns-webpic-qc.xhscdn.com/202401/note!nd_dft_wlteh_webp_3",
    width: 1080,
    height: 1440,
  }),
  // 懒加载：真实地址在 data-src 里
  makeImg({
    currentSrc: "https://cdn.example.com/placeholder.jpg",
    dataset: { src: "https://cdn.example.com/lazy-full.jpg" },
    width: 800,
    height: 600,
  }),
];

const document = {
  documentElement: root,
  createElement: (tag) => makeEl(tag),
  querySelectorAll: () => [],
  addEventListener() {},
  images,
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
  location: { href: "https://example.com/post/1" },
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
let result = null;
listener({ action: "collectImages", limit: 20 }, {}, (value) => { result = value; });

const urls = result?.images || [];
const items = result?.items || [];

// 基础规则
check("只保留大图", urls.includes("https://cdn.example.com/hero.jpg"));
check("小于 300px 的图被跳过", !urls.includes("https://cdn.example.com/thumb.jpg"));
check("blob 地址被跳过", !urls.some((u) => u.startsWith("blob:")));
check("data 地址被跳过", !urls.some((u) => u.startsWith("data:")));
check("相对地址补成绝对地址", urls.includes("https://example.com/relative/photo.png"), urls.join(" | "));
check("重复地址只保留一份", urls.filter((u) => u.includes("hero.jpg")).length === 1, urls.join(" | "));

// 缩略图参数
check(
  "七牛 imageView2 缩放参数被剥离",
  urls.includes("https://cdnv2.ruguoapp.com/thumb.jpg"),
  urls.filter((u) => u.includes("ruguoapp")).join(" | ")
);
check(
  "imageView2 的 format 段保留",
  urls.includes("https://cdnv2.ruguoapp.com/plain.jpg?format=jpeg"),
  urls.filter((u) => u.includes("plain")).join(" | ")
);
check(
  "imageMogr2 缩放参数被剥离",
  urls.includes("https://cdnv2.ruguoapp.com/mogr.jpg"),
  urls.filter((u) => u.includes("mogr")).join(" | ")
);
check(
  "原始缩略地址保留为回退候选",
  items.some((item) => (item.candidates || []).some((c) => c.includes("imageView2/2/w/400"))),
  items.find((item) => item.url.includes("thumb.jpg"))?.candidates?.join(" | ") || "none"
);

// 小红书预览域
check(
  "小红书预览地址换成原图域",
  urls.includes("https://sns-img-qc.xhscdn.com/202401/note"),
  urls.filter((u) => u.includes("xhscdn")).join(" | ")
);

// srcset 与懒加载
check("srcset 取最大一项", urls.includes("https://cdn.example.com/large.jpg"), urls.filter((u) => u.includes("example.com/small") || u.includes("large")).join(" | "));
check("懒加载 data-src 被采用", urls.includes("https://cdn.example.com/lazy-full.jpg"));

// limit 生效
let limited = null;
listener({ action: "collectImages", limit: 1 }, {}, (value) => { limited = value; });
check("limit 限制返回数量", (limited?.images || []).length === 1, JSON.stringify(limited?.images));

console.log(failures === 0 ? "\n全部通过" : `\n${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
