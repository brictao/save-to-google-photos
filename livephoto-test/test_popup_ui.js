// 用隔离的无头 Chrome 验证真实 popup 文件，Google 与扩展 API 使用桩。
// 运行：node livephoto-test/test_popup_ui.js
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { pathToFileURL } = require('node:url');
const { spawnSync } = require('node:child_process');
const assert = require('node:assert/strict');

const root = path.resolve(__dirname, '..');
const chrome = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
assert.ok(fs.existsSync(chrome), '请通过 CHROME_PATH 指定 Chrome 可执行文件');
const output = path.join(__dirname, 'output', 'popup-ui');
fs.mkdirSync(output, { recursive: true });
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'sgp-popup-ui-'));
const html = fs.readFileSync(path.join(root, 'extension/popup.html'), 'utf8');
const ids = [...html.matchAll(/id="([^"]+)"/g)].map(m => m[1]);
assert.equal(ids.length, new Set(ids).size, 'HTML id 不应重复');
const script = fs.readFileSync(path.join(root, 'extension/popup.js'), 'utf8');
for (const [, id] of script.matchAll(/getElementById\("([^"]+)"\)/g)) {
  assert.ok(ids.includes(id), `缺少元素 ${id}`);
}

const mock = `
const albums = [
  {id: 'travel', title: 'Travel inspiration', productUrl: 'https://photos.google.com/albums'},
  {id: 'design', title: 'Design references', productUrl: 'https://photos.google.com/albums'}
];
let selected = albums[0];
const fixtureHistory = [
  {name: 'coastal-morning.jpg', status: 'saved', time: Date.now(), message: 'Added to Travel inspiration'},
  {name: 'studio-reference.png', status: 'saved', time: Date.now() - 180000},
  {name: 'short-film.mp4', status: 'failed', time: Date.now() - 600000, message: 'Could not download media.'}
];
window.chrome = {runtime: {sendMessage(message, callback) {
  let response = {success: true};
  switch (message.action) {
    case 'getAuthToken': response.token = 'test-token'; break;
    case 'getAlbums': response = {...response, album: selected, albums}; break;
    case 'getHistory': response.items = fixtureHistory; break;
    case 'selectAlbum': selected = albums.find(a => a.id === message.albumId); response = {...response, album: selected, albums}; break;
    case 'clearAlbum': selected = null; break;
    case 'createAlbum': {
      const existing = albums.find(a => a.title === message.title);
      if (existing) response = {success: false, duplicate: true, existing};
      else { selected = {id: 'new', title: message.title}; albums.push(selected); response = {...response, album: selected, albums}; }
      break;
    }
  }
  queueMicrotask(() => callback(response));
}}};
window.addEventListener('error', event => { document.body.dataset.uiError = event.message; });
`;
const tests = `
(async () => {
  const tick = () => new Promise(resolve => setTimeout(resolve, 0));
  const check = (condition, message) => { if (!condition) throw new Error(message); };
  const visible = id => getComputedStyle(document.getElementById(id)).display !== 'none';
  try {
    await tick();
    check(document.body.getBoundingClientRect().width === 360, '窄初始视口下 body 仍须为 360px');
    check(document.documentElement.getBoundingClientRect().width === 360, '根元素须提供 360px 固有宽度');
    check(saveAllBtn.getBoundingClientRect().height <= 46, '主按钮不得因挤压变为多行');
    check(albumTitle.getBoundingClientRect().width >= 160, '创建相册输入框不得被挤空');
    check(visible('saveAllBtn') && visible('albumCard'), '登录态');
    check(albumSelect.options.length === 2, '相册清单');
    check(signOutBtn.closest('#statusCard'), '退出按钮位置');
    check(getComputedStyle(albumSelect).backgroundPosition.includes('12px'), '箭头间距');
    albumSelect.value = 'design';
    albumSelect.dispatchEvent(new Event('change'));
    await tick();
    check(albumLink.textContent === 'Design references', '切换相册');
    albumUnbindBtn.click();
    await tick();
    check(!visible('albumCurrent') && visible('albumSwitchRow'), '解绑后清单保留');
    albumTitle.value = 'Travel inspiration';
    albumCreateBtn.click();
    await tick();
    check(visible('albumDuplicateBtn'), '同名提示');
    albumDuplicateBtn.click();
    await tick();
    check(albumLink.textContent === 'Travel inspiration', '同名切换');
    albumTitle.value = 'New collection';
    albumTitle.dispatchEvent(new KeyboardEvent('keydown', {key: 'Enter', bubbles: true}));
    await tick();
    check(albumLink.textContent === 'New collection', '回车创建');
    const longTitle = '这是一个很长的相册名称'.repeat(10);
    renderAlbum({id: 'long', title: longTitle}, [{id: 'long', title: longTitle}, ...albums]);
    showDuplicate({id: 'long', title: longTitle});
    check(document.body.scrollWidth <= document.body.clientWidth, '长名称不得横向溢出');
    signOutBtn.click();
    await tick();
    check(visible('signInBtn') && !visible('albumCard') && !visible('saveAllBtn'), '退出态');
    signInBtn.click();
    await tick();
    check(visible('albumCard'), '重新登录');
    renderAlbum(null, []);
    renderHistory([]);
    check(!visible('albumSwitchRow') && visible('albumCreateBtn'), '首次安装空状态');
    check(historyList.textContent.includes('No recent saves'), '空历史');
    renderAlbum(albums[0], albums.slice(0, 2));
    renderHistory(fixtureHistory);
    albumTitle.value = '';
    document.activeElement.blur();
    check(document.body.scrollWidth <= document.body.clientWidth, '面板宽度');
    check(!document.body.dataset.uiError, document.body.dataset.uiError);
    const panelHeight = document.querySelector('.container').getBoundingClientRect().height;
    document.body.dataset.panelHeight = String(Math.round(panelHeight));
    check(panelHeight <= 600, '常规状态高度不得超过 600px（实测 ' + Math.round(panelHeight) + 'px）');
    document.body.dataset.testResult = 'PASS';
  } catch (error) { document.body.dataset.testResult = 'FAIL: ' + error.message; }
  parent.postMessage({result: document.body.dataset.testResult, height: document.body.dataset.panelHeight, viewport: innerWidth}, '*');
})();
`;
const fixture = html.replace('<head>', `<head><base href="${pathToFileURL(path.join(root, 'extension') + path.sep).href}">`)
  .replace('<script src="popup.js"></script>', `<script>${mock}</script><script src="popup.js"></script><script>${tests}</script>`);
const fixturePath = path.join(output, 'fixture.html');
fs.writeFileSync(fixturePath, fixture);
// iframe 确保真实 CSS 视口宽度，避免 Chrome 命令行窗口最小宽度掩盖问题。
// 140px 模拟扩展弹窗初始窄视口；360px 和 720px 检查布局不随宿主宽度变化。
const harnessPath = path.join(output, 'harness.html');
fs.writeFileSync(harnessPath, `<!doctype html><html><head><meta charset="utf-8"><style>
html, body { margin: 0; background: #14171c; }
iframe { border: 0; display: block; height: 600px; }
</style></head><body><script>
const widths = [140, 360, 720];
const results = new Map();
const frames = widths.map(width => {
  const frame = document.createElement('iframe');
  frame.style.width = width + 'px';
  frame.src = ${JSON.stringify(pathToFileURL(fixturePath).href)};
  document.body.append(frame);
  return frame;
});
addEventListener('message', event => {
  const index = frames.findIndex(frame => frame.contentWindow === event.source);
  if (index < 0) return;
  const data = event.data;
  results.set(index, data);
  if (results.size !== frames.length) return;
  const errors = [...results].filter(([i, data]) => data.result !== 'PASS' || data.viewport !== widths[i]);
  document.body.dataset.testResult = errors.length ? 'FAIL: ' + JSON.stringify(errors) : 'PASS';
  document.body.dataset.panelHeight = results.get(1).height || '';
  document.body.dataset.viewports = JSON.stringify([...results.values()]);
  frames[0].remove();
  frames[2].remove();
});
</script></body></html>`);
try {
  const result = spawnSync(chrome, [
    '--headless', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--allow-file-access-from-files', '--hide-scrollbars', '--force-device-scale-factor=2',
    '--window-size=360,600', '--virtual-time-budget=3000', `--user-data-dir=${profile}`,
    `--screenshot=${path.join(output, 'popup.png')}`, '--dump-dom', pathToFileURL(harnessPath).href
  ], {encoding: 'utf8', timeout: 30000, maxBuffer: 5 * 1024 * 1024});
  fs.writeFileSync(path.join(output, 'chrome.log'), result.stderr || '');
  assert.equal(result.status, 0, result.error?.message || 'Chrome 失败，请查看 chrome.log');
  fs.writeFileSync(path.join(output, 'result.html'), result.stdout);
  assert.ok(result.stdout.includes('data-test-result="PASS"'), result.stdout.match(/data-test-result="([^"]+)"/)?.[1] || '浏览器测试未完成');
  console.log('PASS HTML 元素引用、登录与退出、切换、解绑、同名提示、回车创建、空状态、长名称布局');
  console.log('面板高度:', result.stdout.match(/data-panel-height="([^"]+)"/)?.[1]);
  console.log('截图:', path.join(output, 'popup.png'));
} finally {
  fs.rmSync(profile, {recursive: true, force: true});
}
