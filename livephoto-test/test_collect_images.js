#!/usr/bin/env node
// 验证 content.js 的批量收集：只收大图、去重、跳过 blob 与非 http 地址。

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

const images = [
  { currentSrc: "https://cdn.example.com/hero.jpg", src: "", naturalWidth: 1600, naturalHeight: 900 },
  { currentSrc: "https://cdn.example.com/thumb.jpg", src: "", naturalWidth: 120, naturalHeight: 120 },
  { currentSrc: "https://cdn.example.com/hero.jpg", src: "", naturalWidth: 1600, naturalHeight: 900 },
  { currentSrc: "blob:https://example.com/2f8a", src: "", naturalWidth: 900, naturalHeight: 900 },
  { currentSrc: "", src: "/relative/photo.png", naturalWidth: 800, naturalHeight: 600 },
  { currentSrc: "data:image/png;base64,AAAA", src: "", naturalWidth: 800, naturalHeight: 600 },
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
check("只保留大图", urls.includes("https://cdn.example.com/hero.jpg"));
check("小于 300px 的图被跳过", !urls.includes("https://cdn.example.com/thumb.jpg"));
check("blob 地址被跳过", !urls.some((u) => u.startsWith("blob:")));
check("data 地址被跳过", !urls.some((u) => u.startsWith("data:")));
check("相对地址补成绝对地址", urls.includes("https://example.com/relative/photo.png"), urls.join(" | "));
check("重复地址只保留一份", urls.filter((u) => u.includes("hero.jpg")).length === 1, urls.join(" | "));

// limit 生效
let limited = null;
listener({ action: "collectImages", limit: 1 }, {}, (value) => { limited = value; });
check("limit 限制返回数量", (limited?.images || []).length === 1, JSON.stringify(limited));

console.log(failures === 0 ? "\n全部通过" : `\n${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
