#!/usr/bin/env node
// 验证混合批量的分类路由、配对隔离，以及 Live Photo 成功/跳过/失败返回值。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const noop = () => {};
const listener = { addListener: noop };
const context = {
  console: { log: console.log, warn: noop, error: noop },
  Blob, URL, TextEncoder, setTimeout, clearTimeout, AbortController,
  importScripts: noop, self: { MotionPhoto: {} },
  chrome: {
    runtime: { onInstalled: listener, onStartup: listener, onMessage: listener },
    contextMenus: { create: noop, removeAll: cb => cb?.(), update: noop, onClicked: listener },
    tabs: { onActivated: listener },
  },
};
vm.createContext(context);
vm.runInContext(fs.readFileSync(path.join(__dirname, '../extension/background.js'), 'utf8'), context);

async function main() {
  const realLive = context.handleLivePhoto;
  const realResolve = context.resolveLivePhotoPair;
  const calls = [], notices = [], history = [];
  context.delay = async () => {};
  context.showToast = (...args) => notices.push(args);
  context.notifyFailureWhenHidden = async (...args) => notices.push(args);
  context.notifyFailure = (...args) => notices.push(args);
  context.saveOne = async (tabId, url, kind, options) => {
    calls.push({ tabId, url, kind, options });
    return 'saved';
  };
  context.handleLivePhoto = async (tab, url, type, pair, options) => {
    calls.push({ tabId: tab.id, url, type, kind: 'live', pair, options });
    return url.includes('fail') ? 'failed' : url.includes('skip') ? 'skipped' : 'saved';
  };
  const cover = 'https://cdn.test/cover.jpg';
  const input = [
    { url: 'https://cdn.test/plain.jpg' },
    { kind: 'live', url: 'https://cdn.test/short.mp4', imageUrl: cover, videoDuration: 10 },
    { kind: 'live', url: 'https://cdn.test/long.mp4', imageUrl: cover, videoDuration: 10.01 },
    { kind: 'video', url: 'https://cdn.test/nocover.mp4', videoDuration: 3 },
    { kind: 'live', url: 'https://cdn.test/skip.mp4', imageUrl: 'https://cdn.test/second.jpg' },
    { kind: 'live', url: 'https://cdn.test/fail.mp4', imageUrl: cover },
    { kind: 'video', url: 'blob:x', unavailableReason: 'unsupported' },
  ];
  const counts = await context.saveSelectedItems(42, input);
  assert.equal(counts.total, 6);
  assert.equal(counts.saved, 4);
  assert.equal(counts.skipped, 1);
  assert.equal(counts.failed, 1);
  assert.deepEqual(calls.map(call => call.kind), ['image', 'live', 'video', 'video', 'live', 'live']);
  assert(calls.every(call => call.tabId === 42 && call.options.quiet));
  assert.equal(calls[1].pair.imageUrl, cover);
  assert.equal(calls[4].pair.imageUrl, 'https://cdn.test/second.jpg');
  assert.equal(calls[1].pair.videoUrl, input[1].url);
  assert.equal(calls[4].pair.videoUrl, input[4].url);
  assert(!('undefined' in counts));
  console.log('PASS 混合批量分类、10 秒阈值、独立配对、结果汇总和不支持项过滤');

  // 保留真实 resolveLivePhotoPair，确保显式配对不会回头查询上次右键目标。
  const fetched = [];
  context.fetchBytes = async (url, _tab, progress) => {
    fetched.push(url);
    progress?.(4, 4);
    return { bytes: new Uint8Array([1, 2, 3, 4]).buffer };
  };
  context.requestCoverImage = async () => { throw new Error('不应查询页面封面'); };
  context.self.MotionPhoto.isMp4 = () => true;
  const pair = await realResolve(42, input[1].url, 'video', {
    found: true, imageUrl: cover, videoUrl: input[1].url,
  });
  assert.equal(pair.imageUrl, cover);
  assert.deepEqual(fetched, [input[1].url]);
  console.log('PASS 使用所选卡片的显式配对，不依赖最后一次右键');

  context.handleLivePhoto = realLive;
  context.resolveLivePhotoPair = async () => ({ imageUrl: cover, videoBytes: new Uint8Array([1, 2, 3]).buffer });
  context.ensureJpeg = async bytes => new Uint8Array(bytes);
  context.self.MotionPhoto.assemble = () => ({ bytes: new Uint8Array(16), warnings: [], stillSize: 13, videoSize: 3 });
  context.isSeen = async () => false;
  context.addHistory = async row => history.push(row);
  context.markSeen = async () => {};
  context.withAuthRetry = async fn => fn('mock-token');
  context.uploadBytes = async () => 'mock-upload';
  context.createMediaItem = async () => {};
  notices.length = 0;
  const save = () => realLive({ id: 42 }, input[1].url, 'video', { found: true }, { quiet: true });
  assert.equal(await save(), 'saved');
  assert.equal(history.at(-1).kind, 'live');
  assert.equal(history.at(-1).status, 'saved');
  context.isSeen = async () => true;
  assert.equal(await save(), 'skipped');
  assert.equal(history.at(-1).status, 'skipped');
  context.resolveLivePhotoPair = async () => { throw new Error('模拟下载失败'); };
  assert.equal(await save(), 'failed');
  assert.equal(history.at(-1).status, 'failed');
  assert.equal(notices.length, 0);
  console.log('PASS Live Photo 返回 saved/skipped/failed，静默批量不重复弹提示或通知');

  await realLive({ id: 42 }, input[1].url, 'video', { found: true });
  assert.equal(notices.length, 3);
  console.log('PASS 单张右键保留原有错误提示和通知');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
