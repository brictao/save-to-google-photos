#!/usr/bin/env node
// 验证 background.js 上传前的本地校验与命名规则：
// 1) 超过 200 MB 或空文件在本地拦下
// 2) 不支持的格式给出可读原因
// 3) 指纹忽略查询串，同图不同签名仍算重复
// 4) 文件名清洗成 ASCII，中文名不会让 fetch 抛错

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const bgSource = fs.readFileSync(
  path.resolve(__dirname, "../extension/background.js"),
  "utf8"
);

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
    contextMenus: { create: noop, removeAll: (cb) => cb && cb(), update: noop, onClicked: addListener },
    tabs: { onActivated: addListener, sendMessage: () => Promise.reject(new Error("no receiver")) },
    scripting: { executeScript: () => Promise.resolve() },
    identity: { getAuthToken: (_o, cb) => cb("t"), removeCachedAuthToken: (_o, cb) => cb() },
  },
};

vm.createContext(context);
vm.runInContext(bgSource, context, { filename: "background.js" });

let failures = 0;
function check(name, ok, detail) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  ${detail}` : ""}`);
  if (!ok) failures++;
}

function rejects(kind, media) {
  try {
    context.assertUploadable(media, kind);
    return null;
  } catch (err) {
    return err.message;
  }
}

// 1) 大小
const tooBig = rejects("image", { size: 250 * 1024 * 1024, mimeType: "image/jpeg" });
check("超过 200 MB 被拦下", Boolean(tooBig) && /200\.00 MB/.test(tooBig), tooBig || "");

const empty = rejects("image", { size: 0, mimeType: "image/jpeg" });
check("空文件被拦下", Boolean(empty) && /empty/.test(empty), empty || "");

// 2) 格式
const svg = rejects("image", { size: 1024, mimeType: "image/svg+xml" });
check("SVG 被拒绝", Boolean(svg) && /Unsupported image format/.test(svg), svg || "");

const webm = rejects("video", { size: 1024, mimeType: "video/webm" });
check("WebM 视频被拒绝", Boolean(webm) && /MP4 and MOV/.test(webm), webm || "");

check("JPEG 图片放行", rejects("image", { size: 1024, mimeType: "image/jpeg" }) === null);
check("PNG 图片放行", rejects("image", { size: 1024, mimeType: "image/png" }) === null);
check("HEIC 图片放行", rejects("image", { size: 1024, mimeType: "image/heic" }) === null);
check("MP4 视频放行", rejects("video", { size: 1024, mimeType: "video/mp4" }) === null);
check("MOV 视频放行", rejects("video", { size: 1024, mimeType: "video/quicktime" }) === null);

// 3) 指纹
const a = context.fingerprint("https://cdn.example.com/a.jpg?sign=1&exp=2", 100);
const b = context.fingerprint("https://cdn.example.com/a.jpg?sign=9&exp=8", 100);
const c = context.fingerprint("https://cdn.example.com/a.jpg", 200);
check("同图不同签名指纹一致", a === b, `${a} | ${b}`);
check("字节数不同指纹不同", a !== c, `${a} | ${c}`);

// 4) 文件名
const cnName = context.buildFileName("https://cdn.example.com/%E7%85%A7%E7%89%87.jpg", "image/jpeg", "image");
check(
  "中文文件名转成 ASCII",
  /^[\x20-\x7E]+$/.test(cnName) && /\.jpg$/.test(cnName),
  cnName
);

const noExt = context.buildFileName("https://cdn.example.com/photo", "video/quicktime", "video");
check("无扩展名按 MIME 补扩展名", /\.mov$/.test(noExt), noExt);

const octet = context.normalizeMime("application/octet-stream", "https://cdn.example.com/a.png", "image");
check("octet-stream 按扩展名补类型", octet === "image/png", octet);

const videoMime = context.normalizeMime("", "https://cdn.example.com/clip.mp4", "video");
check("空 Content-Type 推断视频类型", videoMime === "video/mp4", videoMime);

// 5) 视频时长判定
// Apple 原生 Live Photo 3 秒，第三方工具上限一般 5 秒，阈值取 10 秒
check("3 秒视频仍按 Live Photo 处理", context.isLongVideo(3) === false);
check("5 秒视频仍按 Live Photo 处理", context.isLongVideo(5) === false);
check("10 秒视频仍按 Live Photo 处理", context.isLongVideo(10) === false);
check("11 秒视频按视频原文件处理", context.isLongVideo(11) === true);
check("60 秒视频按视频原文件处理", context.isLongVideo(60) === true);
check(
  "时长未知时不改判",
  context.isLongVideo(undefined) === false && context.isLongVideo(NaN) === false,
  "undefined / NaN 都返回 false"
);
check("直播流的 Infinity 不改判", context.isLongVideo(Infinity) === false);

// 6) 批量条目归一化
const withItems = context.normalizeBatchEntries(
  { items: [{ url: "https://a.sgp/1.jpg", candidates: ["https://a.sgp/1.jpg", "https://a.sgp/1-full.jpg"] }] },
  20
);
check(
  "优先采用 items 候选列表",
  withItems.length === 1 && withItems[0].candidates.length === 2,
  JSON.stringify(withItems)
);

const legacy = context.normalizeBatchEntries(
  { images: ["https://a.sgp/1.jpg", "https://a.sgp/2.jpg"] },
  20
);
check(
  "兼容旧版 images 数组",
  legacy.length === 2 && legacy[0].candidates[0] === "https://a.sgp/1.jpg",
  JSON.stringify(legacy)
);

check("limit 对条目生效", context.normalizeBatchEntries({ images: ["1", "2", "3"] }, 2).length === 2);
check("空输入返回空数组", context.normalizeBatchEntries(null, 20).length === 0);

console.log(failures === 0 ? "\n全部通过" : `\n${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
