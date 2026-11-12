#!/usr/bin/env node
// 验证 content.js 的提示卡片不会堆叠：
// 多步流程连续创建 loading 时，页面上应当只保留最新一条。

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const contentSource = fs.readFileSync(
  path.resolve(__dirname, "../extension/content.js"),
  "utf8"
);

let listeners = [];

function makeEl(tag) {
  const el = {
    tagName: tag.toUpperCase(),
    children: [],
    parentNode: null,
    style: {},
    className: "",
    textContent: "",
    innerHTML: "",
    setAttribute() {},
    classList: {
      add() {},
      remove() {},
      contains() { return false; },
    },
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
      if (selector === ".sgp-toast-close") {
        return { addEventListener() {} };
      }
      return null;
    },
    querySelectorAll() { return []; },
    addEventListener() {},
  };
  return el;
}

const root = makeEl("html");

const document = {
  documentElement: root,
  createElement: (tag) => makeEl(tag),
  querySelectorAll: () => [],
  addEventListener() {},
};

// 容器是挂到 documentElement 上的那个 div，不能按创建顺序猜
const getContainer = () =>
  root.children.find((el) => el.className === "sgp-toast-container");

// 结果卡片本身会停留几秒，这里只统计加载中的卡片
const loadingCount = () =>
  getContainer().children.filter((el) =>
    String(el.className).includes("sgp-toast--loading")
  ).length;

const chrome = {
  runtime: {
    onMessage: { addListener(fn) { listeners.push(fn); } },
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

const listener = listeners[0];
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let failures = 0;
const check = (ok, label, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? "  " + detail : ""}`);
  if (!ok) failures++;
};

function send(type, title) {
  listener({ action: "showToast", type, title, message: "test" }, {}, () => {});
}

async function run() {
  // 多步流程：连续的 loading 应当互相替换
  send("loading", "Looking for the pair…");
  send("loading", "Building Live Photo…");
  send("loading", "Uploading…");
  await wait(600);

  const afterLoadings = loadingCount();
  check(afterLoadings === 1, "连续三条 loading 只保留一条", `当前 ${afterLoadings} 条`);

  // 结果出现后不应当再有加载中的卡片
  send("success", "Live Photo Saved!");
  await wait(600);

  const afterSuccess = loadingCount();
  check(afterSuccess === 0, "成功提示出现后 loading 被移除", `当前 ${afterSuccess} 条`);

  // 失败路径同样不应当留下加载中的卡片
  send("loading", "Uploading…");
  await wait(50);
  send("error", "Live Photo Failed");
  await wait(600);

  const afterError = loadingCount();
  check(afterError === 0, "失败提示出现后 loading 被移除", `当前 ${afterError} 条`);

  console.log(failures === 0 ? "\n全部通过" : `\n${failures} 项失败`);
  process.exit(failures === 0 ? 0 : 1);
}

run();
