#!/usr/bin/env node
// 验证 background.js 的失败路径修复：
// 1) 缓存 token 过期（401）时清缓存并重跑一次
// 2) 非鉴权错误不重试
// 3) description 去掉查询串并截断到 1000 字符
// 4) blob 图片在下载前被拦下

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const bgSource = fs.readFileSync(
  path.resolve(__dirname, "../extension/background.js"),
  "utf8"
);

let tokenQueue = [];
let invalidated = [];
let authCalls = 0;

const noop = () => {};
const addListener = { addListener: noop };

const context = {
  console,
  TextEncoder,
  Blob,
  URL,
  setTimeout,
  clearTimeout,
  AbortController,
  importScripts: noop,
  self: { MotionPhoto: {} },
  chrome: {
    runtime: {
      lastError: undefined,
      onInstalled: addListener,
      onStartup: addListener,
      onMessage: addListener,
    },
    contextMenus: {
      create: noop,
      removeAll: (cb) => cb && cb(),
      update: noop,
      onClicked: addListener,
    },
    tabs: {
      onActivated: addListener,
      sendMessage: () => Promise.reject(new Error("no receiver")),
    },
    scripting: { executeScript: () => Promise.resolve() },
    identity: {
      getAuthToken: (_opts, cb) => {
        authCalls++;
        cb(tokenQueue.shift());
      },
      removeCachedAuthToken: ({ token }, cb) => {
        invalidated.push(token);
        cb();
      },
    },
  },
};

vm.createContext(context);
vm.runInContext(bgSource, context, { filename: "background.js" });

let failures = 0;

function check(name, ok, detail) {
  if (ok) {
    console.log(`PASS  ${name}${detail ? `  ${detail}` : ""}`);
  } else {
    failures++;
    console.log(`FAIL  ${name}${detail ? `  ${detail}` : ""}`);
  }
}

(async () => {
  // 1) 401 后重试一次
  tokenQueue = ["stale-token", "fresh-token"];
  invalidated = [];
  authCalls = 0;
  let attempts = 0;

  const result = await context.withAuthRetry(async (token) => {
    attempts++;
    if (token === "stale-token") {
      throw Object.assign(new Error("Upload failed (HTTP 401)"), {
        status: 401,
        detail: "Invalid Credentials",
      });
    }
    return `uploaded with ${token}`;
  });

  check(
    "401 后清缓存并重试一次",
    result === "uploaded with fresh-token" &&
      attempts === 2 &&
      authCalls === 2 &&
      invalidated.length === 1 &&
      invalidated[0] === "stale-token",
    `attempts=${attempts} authCalls=${authCalls} invalidated=${invalidated.join(",")}`
  );

  // 2) 非鉴权错误不重试
  tokenQueue = ["t1"];
  invalidated = [];
  authCalls = 0;
  attempts = 0;

  try {
    await context.withAuthRetry(async () => {
      attempts++;
      throw Object.assign(new Error("Upload failed (HTTP 500)"), { status: 500 });
    });
  } catch (err) {
    check(
      "500 不重试",
      attempts === 1 && invalidated.length === 0 && /HTTP 500/.test(err.message),
      `attempts=${attempts} invalidated=${invalidated.length}`
    );
  }

  // 3) description 去查询串并截断
  const withQuery = context.buildDescription(
    "https://cdn.example.com/a/b.jpg?sign=secret&expires=999"
  );
  check(
    "description 去掉签名查询串",
    withQuery === "https://cdn.example.com/a/b.jpg",
    withQuery
  );

  const longUrl = "https://cdn.example.com/" + "x".repeat(1200) + ".jpg";
  const truncated = context.buildDescription(longUrl);
  check(
    "description 截断到 1000 字符",
    truncated.length === 1000,
    `len=${truncated.length}`
  );

  check("description 空值返回空串", context.buildDescription(null) === "", "null -> ''");

  // 4) blob 图片前置拦截
  let blocked = false;
  try {
    context.assertImageUrl("blob:https://example.com/2f8a-1c");
  } catch (err) {
    blocked = /blob URL/.test(err.message);
  }
  check("blob 图片在下载前被拦下", blocked);

  let passedThrough = true;
  try {
    context.assertImageUrl("https://cdn.example.com/photo.jpg");
  } catch {
    passedThrough = false;
  }
  check("普通 https 图片不受影响", passedThrough);

  console.log(failures === 0 ? "\n全部通过" : `\n${failures} 项失败`);
  process.exit(failures === 0 ? 0 : 1);
})();
