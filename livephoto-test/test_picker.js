#!/usr/bin/env node
// 验证 content.js 的图片选择面板：
// 1) 收集到的每张图都渲染成一张卡片
// 2) 卡片下方的尺寸文字取自图片的真实宽高
// 3) 面板挂在 Shadow DOM 内，不污染页面样式
// 4) 没有可用图片时返回原因而不是抛错

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

const images = [
  makeImg({ currentSrc: "https://cdn.example.com/wide.jpg", width: 1600, height: 900 }),
  makeImg({ currentSrc: "https://cdn.example.com/tall.jpg", width: 1080, height: 1440 }),
  makeImg({ currentSrc: "https://cdn.example.com/icon.png", width: 64, height: 64 }),
];

const root = makeEl("html");

const document = {
  documentElement: root,
  createElement: (tag) => makeEl(tag),
  querySelectorAll: () => [],
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

function open(mode) {
  let result = null;
  listener({ action: "openPicker", mode }, {}, (value) => {
    result = value;
  });
  return result;
}

const opened = open("page");

check("面板打开成功", opened?.ok === true, opened?.reason);
check("只统计大图", opened?.count === 2, String(opened?.count));

const host = root.children[root.children.length - 1];
const shadow = host?.shadowRoot;
check("面板挂在 Shadow DOM 内", Boolean(shadow));

const overlay = shadow?.children?.find((el) => el.className === "sgp-overlay");
const panel = overlay?.children?.[0];
const grid = panel?.children?.find((el) => el.className === "sgp-grid");
const cards = grid?.children || [];

check("每张图一张卡片", cards.length === 2, String(cards.length));

const sizes = cards
  .map((card) => {
    const meta = card.children?.find((el) => el.className === "sgp-meta");
    return meta?.children?.find((el) => el.className === "sgp-size")?.textContent;
  })
  .filter(Boolean);

check("尺寸文字取自真实宽高", sizes.includes("1600 × 900"), sizes.join(" | "));
check("第二张尺寸也正确", sizes.includes("1080 × 1440"), sizes.join(" | "));

const counts = panel?.children?.[0]?.children?.find((el) => el.className === "sgp-count");
check("默认全部选中", /2 of 2 selected/.test(counts?.textContent || ""), counts?.textContent);

// 没有大图时不应该渲染面板
document.images = [makeImg({ currentSrc: "https://cdn.example.com/small.png", width: 40, height: 40 })];
root.children.length = 0;
const empty = open("page");
check(
  "没有可用图片时返回原因",
  empty?.ok === false && /No large images/.test(empty?.reason || ""),
  empty?.reason
);
check("失败时不残留面板", root.children.length === 0, String(root.children.length));

console.log(failures === 0 ? "\n全部通过" : `\n${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
