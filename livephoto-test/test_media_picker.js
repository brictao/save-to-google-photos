#!/usr/bin/env node
// 验证混合媒体的收集、时长分类、不可保存状态和选择快照。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function element(tag) {
  const handlers = {};
  return {
    tagName: tag.toUpperCase(), children: [], style: {}, dataset: {}, className: '',
    classList: { add() {}, toggle() {}, remove() {} },
    appendChild(child) { this.children.push(child); child.parentNode = this; return child; },
    attachShadow() { return this.shadowRoot = element('shadow-root'); },
    addEventListener(name, fn) { handlers[name] = fn; },
    emit(name, target = this) { handlers[name]?.({ target }); },
    querySelector() { return null; }, querySelectorAll() { return []; },
    getAttribute(name) { return this[name] || null; },
    setAttribute(name, value) { this[name] = value; },
    removeAttribute(name) { delete this[name]; },
    getBoundingClientRect() { return { width: this.width || 640, height: this.height || 360 }; },
    remove() {},
  };
}
const image = (url) => Object.assign(element('img'), {
  src: url, currentSrc: url, naturalWidth: 1200, naturalHeight: 900,
});
const video = (url, duration, poster = '') => Object.assign(element('video'), {
  src: url, currentSrc: url, duration, poster, videoWidth: 1920, videoHeight: 1080,
});
const cover = 'https://cdn.test/cover.jpg';
const root = element('html');
let videos = [], dialog = null, sent;
const document = {
  images: [], documentElement: root, createElement: element,
  getElementById() { return null; }, addEventListener() {},
  querySelectorAll(selector) {
    if (selector === 'video') return videos;
    if (selector === '[role="dialog"]' && dialog) return [dialog];
    return [];
  },
};
const context = {
  document, URL, TextEncoder, console, setTimeout, clearTimeout,
  location: { href: 'https://example.test/feed' }, requestAnimationFrame: fn => fn(),
  chrome: { runtime: { onMessage: { addListener() {} }, sendMessage: message => { sent = message; return Promise.resolve(); } } },
};
context.window = context;
vm.createContext(context);
const source = fs.readFileSync(path.join(__dirname, '../extension/content.js'), 'utf8');
vm.runInContext(source.replace('function openPicker() {',
  'globalThis.mediaTest = {collectMedia, renderPicker, pickerVideoKind}; function openPicker() {'), context);
const api = context.mediaTest;

for (const duration of [3, 5, 10, undefined, NaN, Infinity]) {
  assert.equal(api.pickerVideoKind(duration, cover), 'live');
}
for (const duration of [10.01, 11, 60]) assert.equal(api.pickerVideoKind(duration, cover), 'video');
assert.equal(api.pickerVideoKind(3, ''), 'video');
console.log('PASS 10 秒边界、时长未知和无封面分类');

document.images = [image(cover), image('https://cdn.test/still.jpg')];
videos = [video('https://cdn.test/short.mp4', 3, cover), video('https://cdn.test/long.mov', 60, cover),
  video('https://cdn.test/nocover.mp4', 3), video('blob:https://example.test/id', 3, cover),
  video('https://cdn.test/stream.m3u8?token=x', 30), video('https://cdn.test/stream.mpd', 30),
  video('https://cdn.test/clip.webm', 30), video('', NaN, cover)];
videos.push(videos[0]);
let items = api.collectMedia();
assert.equal(items.length, 9);
assert.equal(items.filter(item => item.url === videos[0].src).length, 1);
assert.equal(items.filter(item => item.kind === 'image').length, 1);
assert.equal(items.find(item => item.url.includes('nocover')).kind, 'video');
assert.equal(items.find(item => item.url.includes('long.mov')).kind, 'video');
// blob 的 Live Photo 不再整张禁用，改用封面兜底后仍可保存
assert.equal(items.filter(item => item.unavailableReason).length, 4);
assert.equal(api.collectMedia(2).length, 2);
console.log('PASS 图片和视频混合收集、封面去重、视频去重、总数限制与不支持来源');

const fromSource = video('', 5, cover);
fromSource.querySelector = selector => selector === 'source' ? { getAttribute: () => 'https://cdn.test/source.mp4' } : null;
videos = [fromSource];
assert.equal(api.collectMedia().find(item => item.kind === 'live').url, 'https://cdn.test/source.mp4');
const reactImage = image(cover);
reactImage.__reactFiber$test = { memoizedProps: { livePhoto: { videoUrl: 'https://cdn.test/react.mp4', imageUrl: cover } } };
document.images = [reactImage];
videos = [];
items = api.collectMedia();
assert.equal(items.length, 1);
assert.equal(items[0].kind, 'live');
assert.equal(items[0].url, 'https://cdn.test/react.mp4');
console.log('PASS source 元素地址与图片组件中的 Live Photo 配对');

document.images = [image('https://cdn.test/feed.jpg')];
videos = [video('https://cdn.test/feed.mp4', 60)];
const modalVideo = video('https://cdn.test/modal.mp4', 60);
dialog = { querySelectorAll: selector => selector === 'video' ? [modalVideo] : [] };
items = api.collectMedia();
assert.equal(items.length, 1);
assert.equal(items[0].url, modalVideo.src);
dialog = null;
console.log('PASS 只有视频的详情浮层不混入背后的信息流');

videos = [video('https://cdn.test/unknown.mp4', NaN, cover), video('https://cdn.test/normal.mp4', 60), video('blob:x', 10, cover)];
document.images = [image('https://cdn.test/still.jpg')];
items = api.collectMedia();
api.renderPicker(items);
const walk = node => [node, ...(node.children || []).flatMap(walk)];
const nodes = walk(root.children.at(-1).shadowRoot);
const cards = nodes.filter(node => node.className.startsWith('sgp-card'));
const boxes = nodes.filter(node => node.tagName === 'INPUT');
const byClass = (card, name) => walk(card).find(node => node.className === name);
assert.deepEqual(nodes.filter(node => node.className === 'sgp-kind').map(node => node.textContent), ['Live Photo', 'Video', 'Live Photo', 'Image']);
// blob 动态段的 Live Photo 也默认可选，不允许的项降到 0
assert.equal(boxes.filter(box => box.checked).length, 4);
assert.equal(boxes.filter(box => box.disabled).length, 0);
const unknown = cards[0];
const preview = byClass(unknown, 'sgp-thumb');
assert.equal(preview.tagName, 'VIDEO');
assert.equal(preview.preload, 'none');
assert.equal(preview.poster, cover);
assert.equal(byClass(unknown, 'sgp-duration').textContent, 'Duration unknown');
unknown.emit('click', preview);
assert.equal(boxes[0].checked, true);
preview.duration = 32;
preview.videoWidth = 1280;
preview.videoHeight = 720;
preview.emit('loadedmetadata');
assert.equal(byClass(unknown, 'sgp-kind').textContent, 'Video');
assert.equal(byClass(unknown, 'sgp-duration').textContent, '0:32');
assert.equal(byClass(unknown, 'sgp-size').textContent, '1280 × 720');
const button = text => nodes.find(node => node.tagName === 'BUTTON' && node.textContent === text);
button('Select none').emit('click');
assert.equal(boxes.filter(box => box.checked).length, 0);
button('Select all').emit('click');
assert.equal(boxes.filter(box => box.checked).length, 4);
button('Save 4').emit('click');
assert.equal(sent.action, 'saveSelectedItems');
assert.equal(sent.items.length, 4);
assert.equal(sent.items[0].kind, 'video');
assert.equal(sent.items[0].videoDuration, 32);
assert.equal(sent.items[0].imageUrl, cover);
// blob 动态段作为 Live Photo 提交是允许的；纯视频仍然不允许
assert(!sent.items.some(item => item.kind === 'video' && item.url.startsWith('blob:')));
const blobLive = sent.items.find(item => item.kind === 'live' && item.url.startsWith('blob:'));
assert(blobLive, 'blob 动态段的 Live Photo 应可提交');
assert.equal(blobLive.coverFallback, true);
assert.equal(blobLive.imageUrl, cover);
console.log('PASS 类型与时长标注、手动预览、类型更新、禁用选择和提交快照');
