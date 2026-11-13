#!/usr/bin/env node
// 验证 content.js 从小红书笔记数据里取全部图片：
// 1) 从 React fiber 的 memoizedProps 里找到 imageList
// 2) 当前组件没有数据时继续向上找
// 3) urlDefault / urlPre / 字符串三种写法都能解析
// 4) 预览域换成原图域，原始地址留在候选里
// 5) 页面上没有组件数据时返回可读原因

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const contentSource = fs.readFileSync(
  path.resolve(__dirname, "../extension/content.js"),
  "utf8"
);

let listeners = [];

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
    appendChild(child) { this.children.push(child); return child; },
    removeChild() {},
    querySelector() { return null; },
    querySelectorAll() { return []; },
    addEventListener() {},
    getBoundingClientRect() { return { width: 1080, height: 1440 }; },
    ...extra,
  };
}

const noteFiber = {
  memoizedProps: {
    data: {
      noteCard: {
        imageList: [
          { urlDefault: "https://sns-img-qc.xhscdn.com/202401/p1" },
          { urlPre: "https://sns-webpic-qc.xhscdn.com/202401/p2!nd_dft_wlteh_webp_3" },
          "https://sns-img-qc.xhscdn.com/202401/p3",
          { url: "https://sns-webpic-qc.xhscdn.com/202401/p4!nd_dft_wlteh_webp_3" },
        ],
      },
    },
  },
  return: null,
};

// 图片自己的 fiber 上没有笔记数据，需要向上找到父级
const leafFiber = { memoizedProps: { alt: "note image" }, return: noteFiber };

const img = makeEl("img", {
  currentSrc: "https://sns-webpic-qc.xhscdn.com/202401/p1!nd_dft_wlteh_webp_3",
  naturalWidth: 1080,
  naturalHeight: 1440,
  width: 1080,
  height: 1440,
});
img["__reactFiber$test"] = leafFiber;

const plainImg = makeEl("img", {
  currentSrc: "https://example.com/plain.jpg",
  naturalWidth: 800,
  naturalHeight: 600,
  width: 800,
  height: 600,
});

const document = {
  documentElement: makeEl("html"),
  createElement: (tag) => makeEl(tag),
  querySelectorAll: () => [],
  images: [img],
  addEventListener() {},
  elementsFromPoint: () => [],
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
  listener({ action: "collectNoteImages" }, {}, (value) => {
    result = value;
  });
  return result;
}

const found = ask();

check("识别到笔记的图片列表", found?.ok === true, found?.reason);
check("取到全部 4 张", found?.count === 4, String(found?.count));

const urls = (found?.items || []).map((item) => item.url);
check(
  "urlDefault 直接可用",
  urls.includes("https://sns-img-qc.xhscdn.com/202401/p1"),
  urls.join(" | ")
);
check(
  "urlPre 换成原图域",
  urls.includes("https://sns-img-qc.xhscdn.com/202401/p2"),
  urls.join(" | ")
);
check(
  "字符串项被保留",
  urls.includes("https://sns-img-qc.xhscdn.com/202401/p3"),
  urls.join(" | ")
);
check(
  "url 字段也支持",
  urls.includes("https://sns-img-qc.xhscdn.com/202401/p4"),
  urls.join(" | ")
);

const p2 = (found?.items || []).find((item) => item.url.includes("/p2"));
check(
  "原始预览地址留作回退",
  (p2?.candidates || []).includes(
    "https://sns-webpic-qc.xhscdn.com/202401/p2!nd_dft_wlteh_webp_3"
  ),
  (p2?.candidates || []).join(" | ")
);
check(
  "fiber 向上查找生效",
  found?.ok === true,
  "图片自身的 fiber 没有数据，数据在父级"
);

document.images = [plainImg];
const empty = ask();
check(
  "没有组件数据时给出原因",
  empty?.ok === false && /No post image list/.test(empty?.reason || ""),
  empty?.reason
);

console.log(failures === 0 ? "\n全部通过" : `\n${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
