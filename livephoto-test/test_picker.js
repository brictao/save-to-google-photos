#!/usr/bin/env node
// 验证 content.js 的图片选择面板：
// 1) 收集到的每张图都渲染成一张卡片，尺寸文字取自图片真实宽高
// 2) 缩略图按图片自身宽高比占位，不用统一高度
// 3) 缩略图优先用页面已经加载成功的地址，而不是猜出来的原图域
// 4) 页内浮层打开时只收浮层里的图，不混进背后的信息流封面
// 5) 面板挂在 Shadow DOM 内，没有可用图片时返回原因而不是抛错

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
    dataset: {},
    disabled: false,
    setAttribute() {},
    removeAttribute() {},
    getAttribute() { return null; },
    classList: {
      add() {},
      remove() {},
      toggle() {},
      contains() { return false; },
    },
    appendChild(child) {
      this.children.push(child);
      child.parentNode = this;
      return child;
    },
    remove() {},
    removeChild() {},
    querySelector(selector) {
      if (selector === ".sgp-toast-close") return { addEventListener() {} };
      if (selector === ".sgp-toast") return { offsetHeight: 0 };
      return null;
    },
    querySelectorAll() { return []; },
    addEventListener() {},
    getBoundingClientRect() { return { width: 0, height: 0 }; },
    attachShadow() {
      this.shadowRoot = makeEl("shadow-root");
      return this.shadowRoot;
    },
  };
}

function makeImg(options) {
  const { currentSrc = "", width = 0, height = 0 } = options;
  return {
    tagName: "IMG",
    currentSrc,
    src: currentSrc,
    naturalWidth: width,
    naturalHeight: height,
    width,
    height,
    dataset: {},
    getAttribute(name) {
      if (name === "src") return currentSrc || null;
      return null;
    },
    getBoundingClientRect() {
      return { width, height };
    },
  };
}

// 小红书：页面加载的是 sns-webpic 预览域，原图域是改写出来的候选
const xhsPreview = "https://sns-webpic-qc.xhscdn.com/note-a.jpg!nd_dft_wlteh_webp_3";

const images = [
  makeImg({ currentSrc: "https://cdn.example.com/wide.jpg", width: 1600, height: 900 }),
  makeImg({ currentSrc: "https://cdn.example.com/tall.jpg", width: 1080, height: 1440 }),
  makeImg({ currentSrc: xhsPreview, width: 1200, height: 1600 }),
  makeImg({ currentSrc: "https://cdn.example.com/icon.png", width: 64, height: 64 }),
];

const root = makeEl("html");

// 浮层内的图片，用于验证收集范围
let dialogOpen = false;
const dialogImages = [
  makeImg({ currentSrc: "https://cdn.example.com/dialog.jpg", width: 1080, height: 1350 }),
];
const dialogNode = {
  querySelectorAll: (selector) => (selector === "img" ? dialogImages : []),
};

const document = {
  documentElement: root,
  createElement: (tag) => makeEl(tag),
  querySelectorAll: (selector) =>
    dialogOpen && selector === '[role="dialog"]' ? [dialogNode] : [],
  getElementById: () => null,
  images,
  addEventListener() {},
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

function open() {
  let result = null;
  listener({ action: "openPicker" }, {}, (value) => {
    result = value;
  });
  return result;
}

function panelOf(topRoot) {
  const host = topRoot.children[topRoot.children.length - 1];
  const shadow = host?.shadowRoot;
  const overlay = shadow?.children?.find((el) => el.className === "sgp-overlay");
  const panel = overlay?.children?.[0];
  const scroll = panel?.children?.find((el) => el.className === "sgp-scroll");
  const grid = scroll?.children?.find((el) => el.className === "sgp-grid");
  return { host, shadow, overlay, panel, scroll, grid, cards: grid?.children || [] };
}

const opened = open();

check("面板打开成功", opened?.ok === true, opened?.reason);
check("只统计大图", opened?.count === 3, String(opened?.count));

const { shadow, panel, scroll, grid, cards } = panelOf(root);
check("面板挂在 Shadow DOM 内", Boolean(shadow));
check("滚动区与自然高度的多列容器分开", Boolean(scroll) && grid?.parentNode === scroll);
check("每张图一张卡片", cards.length === 3, String(cards.length));

const sizes = cards
  .map((card) => {
    const meta = card.children?.find((el) => el.className === "sgp-meta");
    return meta?.children?.find((el) => el.className === "sgp-size")?.textContent;
  })
  .filter(Boolean);

check("尺寸文字取自真实宽高", sizes.includes("1600 × 900"), sizes.join(" | "));
check("竖图尺寸也正确", sizes.includes("1080 × 1440"), sizes.join(" | "));

const thumbs = cards.map((card) => card.children?.find((el) => el.className === "sgp-thumb"));
const ratios = thumbs.map((thumb) => thumb?.style?.aspectRatio).filter(Boolean);
check("缩略图按原图宽高比占位", ratios.includes("1600 / 900"), ratios.join(" | "));
check("竖图按自身比例占位", ratios.includes("1080 / 1440"), ratios.join(" | "));

const xhsThumb = thumbs.find((thumb) => /xhscdn\.com/.test(thumb?.src || ""));
check(
  "小红书缩略图用页面已加载的预览地址",
  /sns-webpic-qc/.test(xhsThumb?.src || ""),
  xhsThumb?.src
);

const counts = panel?.children?.[0]?.children?.find((el) => el.className === "sgp-count");
check("默认全部选中", /3 of 3 selected/.test(counts?.textContent || ""), counts?.textContent);

// 浮层打开后只收浮层里的图
dialogOpen = true;
root.children.length = 0;
const scoped = open();
check("浮层内只收一张", scoped?.count === 1, String(scoped?.count));
const scopedPanel = panelOf(root);
check(
  "浮层内收的是浮层那张",
  /dialog\.jpg/.test(scopedPanel.cards[0]?.children?.[0]?.src || ""),
  scopedPanel.cards[0]?.children?.[0]?.src
);

// 没有大图时不应该渲染面板
dialogOpen = false;
document.images = [makeImg({ currentSrc: "https://cdn.example.com/small.png", width: 40, height: 40 })];
root.children.length = 0;
const empty = open();
check(
  "没有可用图片时返回原因",
  empty?.ok === false && /No large images/.test(empty?.reason || ""),
  empty?.reason
);
check("失败时不残留面板", root.children.length === 0, String(root.children.length));

console.log(failures === 0 ? "\n全部通过" : `\n${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
