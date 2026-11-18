#!/usr/bin/env node
// 验证相册创建、单张与批量归入相册，以及相册失效时的降级行为。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const noop = () => {};
const listener = { addListener: noop };
// 单独捕获 onMessage 回调，用于验证消息层行为
let messageHandler = null;
const messageListener = { addListener: fn => { messageHandler = fn; } };

const storage = {};      // 旧版本使用的 local
const syncStorage = {};  // 1.4 起相册绑定与清单存放于此
let openTabs = [];       // 已打开的 photos.google.com 标签，用于标题推断
const context = {
  console: { log: noop, warn: noop, error: noop },
  Blob, URL, TextEncoder, setTimeout, clearTimeout, AbortController,
  importScripts: noop,
  self: { MotionPhoto: {} },
  chrome: {
    runtime: { onInstalled: listener, onStartup: listener, onMessage: messageListener },
    contextMenus: { create: noop, removeAll: cb => cb?.(), update: noop, onClicked: listener },
    tabs: { onActivated: listener, query: (filter, cb) => cb(openTabs) },
    storage: {
      local: {
        get: (key, cb) => cb({ [key]: storage[key] }),
        set: (obj, cb) => {
          Object.assign(storage, obj);
          cb?.();
        },
      },
      sync: {
        get: (key, cb) => cb({ [key]: syncStorage[key] }),
        set: (obj, cb) => {
          Object.assign(syncStorage, obj);
          cb?.();
        },
      },
    },
  },
};
vm.createContext(context);
vm.runInContext(
  fs.readFileSync(path.join(__dirname, '../extension/background.js'), 'utf8'),
  context
);

async function main() {
  // 授权流程单独测过，这里只模拟拿到的 token
  context.withAuthRetry = async fn => fn('token');

  // 1) 创建媒体项要回传 id，归入相册靠它
  context.fetch = async () => ({
    ok: true,
    json: async () => ({
      newMediaItemResults: [{ status: { message: 'Success' }, mediaItem: { id: 'media-1' } }],
    }),
  });
  const mediaId = await context.createMediaItem('token', 'upload', 'a.jpg', 'https://site/a.jpg');
  assert.equal(mediaId, 'media-1');
  console.log('PASS createMediaItem 返回 mediaItem id');

  // 2) 创建相册的请求体与本地绑定
  const posted = [];
  context.fetch = async (url, init) => {
    posted.push({ url, body: init.body });
    return {
      ok: true,
      json: async () => ({
        id: 'album-1',
        title: 'Saved from web',
        productUrl: 'https://photos.google.com/album/album-1',
      }),
    };
  };
  const album = await context.createAlbum('token', 'Saved from web');
  await context.setAlbumSetting(album);
  assert.equal(posted[0].url, 'https://photoslibrary.googleapis.com/v1/albums');
  assert.deepEqual(JSON.parse(posted[0].body), { album: { title: 'Saved from web' } });
  assert.equal((await context.getAlbumSetting()).id, 'album-1');
  console.log('PASS 创建相册并写入本地绑定');

  // 3) 归档按 50 项分组，相册 id 进 URL
  const added = [];
  context.fetch = async (url, init) => {
    added.push({ url, ids: JSON.parse(init.body).mediaItemIds });
    return { ok: true };
  };
  const many = Array.from({ length: 120 }, (_, i) => `m${i}`);
  const archived = await context.archiveToAlbum(many);
  assert.equal(archived.added, 120);
  assert.equal(archived.albumTitle, 'Saved from web');
  assert.deepEqual(added.map(call => call.ids.length), [50, 50, 20]);
  assert(added.every(call => call.url.endsWith('/albums/album-1:batchAddMediaItems')));
  assert.equal((await context.getAlbumSetting()).itemCount, 120);
  console.log('PASS 归档按 50 项分组，itemCount 累加');

  // 4) 相册被删掉：清空绑定，图片仍算保存成功
  context.fetch = async () => ({
    ok: false,
    status: 404,
    text: async () => 'Requested entity was not found.',
  });
  const gone = await context.archiveToAlbum(['m1']);
  assert.equal(gone.added, 0);
  assert.equal(gone.cleared, true);
  assert.match(gone.error, /no longer exists/);
  assert.equal(await context.getAlbumSetting(), null);
  console.log('PASS 相册 404 时清空绑定并给出提示');

  // 5) 没绑定相册时不发请求
  let hits = 0;
  context.fetch = async () => {
    hits += 1;
    return { ok: true };
  };
  const skipped = await context.archiveToAlbum(['m1']);
  assert.equal(skipped.added, 0);
  assert.equal(hits, 0);
  console.log('PASS 未绑定相册时跳过归档请求');

  // 6) 单张保存：自动归档，成功提示里带相册名
  await context.setAlbumSetting({ id: 'album-2', title: 'Clips', productUrl: '' });
  const toasts = [];
  const singleIds = [];
  context.showToast = (...args) => toasts.push(args);
  context.addHistory = async () => {};
  context.markSeen = async () => {};
  context.isSeen = async () => false;
  context.downloadMedia = async () => ({
    blob: 'blob',
    mimeType: 'image/jpeg',
    fileName: 'a.jpg',
    size: 10,
  });
  context.assertUploadable = () => {};
  context.uploadBytes = async () => 'upload-token';
  context.createMediaItem = async () => 'media-9';
  context.withAuthRetry = async fn => fn('token');
  context.fetch = async (url, init) => {
    singleIds.push(...JSON.parse(init.body).mediaItemIds);
    return { ok: true };
  };

  const outcome = await context.saveOne(1, 'https://site/a.jpg', 'image');
  assert.equal(outcome, 'saved');
  assert.deepEqual(singleIds, ['media-9']);
  const success = toasts.find(args => args[1] === 'success');
  assert.ok(success, '应出现成功提示');
  assert.match(success[3], /Clips/);
  console.log('PASS 单张保存自动归入相册并在提示里说明');

  // 7) 批量模式合并成一次归档，不逐张请求
  await context.setAlbumSetting({ id: 'album-3', title: 'Batch', productUrl: '' });
  const batchAdds = [];
  context.fetch = async (url, init) => {
    batchAdds.push(JSON.parse(init.body).mediaItemIds);
    return { ok: true };
  };
  context.showToast = () => {};
  context.notifyFailureWhenHidden = async () => {};
  context.delay = async () => {};
  context.saveWithCandidates = async (tabId, entry, options) => {
    options.albumIds.push(`media-${entry.url}`);
    return 'saved';
  };

  const counts = await context.runBatch(1, [{ url: 'a' }, { url: 'b' }, { url: 'c' }], '');
  assert.equal(counts.saved, 3);
  assert.deepEqual(batchAdds, [['media-a', 'media-b', 'media-c']]);
  console.log('PASS 批量保存只发一次归档请求');

  // 8) 清单：创建累积、切换绑定、相册失效后移出
  delete syncStorage.sgp_albums;
  delete syncStorage.sgp_album;
  delete storage.sgp_albums;
  delete storage.sgp_album;

  context.fetch = async (url, init) => {
    const title = JSON.parse(init.body).album.title;
    return {
      ok: true,
      json: async () => ({
        id: `id-${title}`,
        title,
        productUrl: `https://photos.google.com/album/id-${title}`,
      }),
    };
  };

  const first = await context.createAlbum('token', 'Trips');
  await context.setAlbumSetting(first);
  await context.rememberAlbum(first);

  const second = await context.createAlbum('token', 'Work');
  await context.setAlbumSetting(second);
  await context.rememberAlbum(second);

  let albumList = await context.getAlbumList();
  assert.equal(albumList.map(item => item.id).join(','), 'id-Work,id-Trips');
  assert.equal((await context.getAlbumSetting()).id, 'id-Work');

  // 切回先创建的那个
  await context.setAlbumSetting(albumList.find(item => item.id === 'id-Trips'));
  assert.equal((await context.getAlbumSetting()).id, 'id-Trips');

  // 被选中的相册在 Google 侧删掉后，绑定和清单都要清掉它
  context.fetch = async () => ({
    ok: false,
    status: 404,
    text: async () => 'Requested entity was not found.',
  });
  await context.archiveToAlbum(['m1']);
  albumList = await context.getAlbumList();
  assert.equal(albumList.map(item => item.id).join(','), 'id-Work');
  assert.equal(await context.getAlbumSetting(), null);
  assert.ok(Array.isArray(syncStorage.sgp_albums), '清单应写入 sync');
  assert.equal(storage.sgp_albums, undefined, '清单不应写入 local');
  console.log('PASS 清单累积、切换绑定、失效后移出，数据写入 sync');

  // 9) 1.3 只存单个绑定且在 local，升级后搬到 sync 并清掉旧值
  delete syncStorage.sgp_albums;
  delete syncStorage.sgp_album;
  storage.sgp_album = { id: 'legacy', title: 'Legacy', productUrl: '', itemCount: 7 };
  const migrated = await context.ensureAlbumList();
  assert.equal(migrated.length, 1);
  assert.equal(migrated[0].id, 'legacy');
  assert.equal(migrated[0].itemCount, 7);
  assert.equal(syncStorage.sgp_album.id, 'legacy');
  assert.equal(storage.sgp_album, null);
  console.log('PASS 旧版 local 绑定迁移到 sync 并清理');

  // 10) 清单有上限，超出后淘汰最早的一条
  delete syncStorage.sgp_albums;
  delete syncStorage.sgp_album;
  for (let i = 0; i < 35; i += 1) {
    await context.rememberAlbum({
      id: `cap-${i}`,
      title: `Cap ${i}`,
      productUrl: '',
      itemCount: 0,
    });
  }
  const capped = await context.getAlbumList();
  assert.equal(capped.length, 20);
  assert.equal(capped[0].id, 'cap-34');
  assert.equal(capped.some(item => item.id === 'cap-0'), false);
  console.log('PASS 清单上限 20，超出的最早条目被淘汰');

  // 11) 同名相册被拦下，不发创建请求，提示切换到已有相册
  delete syncStorage.sgp_albums;
  delete syncStorage.sgp_album;
  delete storage.sgp_albums;
  delete storage.sgp_album;
  await context.rememberAlbum({ id: 'trip-1', title: 'Trips', itemCount: 0 });

  let fetchCalls = 0;
  context.fetch = async () => {
    fetchCalls += 1;
    return { ok: true, json: async () => ({}) };
  };

  const duplicate = await new Promise(resolve => {
    messageHandler({ action: 'createAlbum', title: 'Trips' }, {}, resolve);
  });
  assert.equal(duplicate.success, false);
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.existing.id, 'trip-1');
  assert.equal(fetchCalls, 0, '同名时不应发起创建请求');
  console.log('PASS 同名相册被拦下，不发创建请求');

  // 12) 相册链接绑定：元数据不可读时仍按链接里的 id 绑定
  delete syncStorage.sgp_albums;
  delete syncStorage.sgp_album;
  delete storage.sgp_albums;
  delete storage.sgp_album;
  context.fetch = async () => ({
    ok: false,
    status: 403,
    text: async () => 'PERMISSION_DENIED',
  });
  const albumId = 'AF1QipOFp_mmPMJ-GScK0Jbb0AASC7N87NNqJBTdXyqx';
  const linked = await new Promise(resolve => {
    messageHandler(
      { action: 'bindAlbum', input: `https://photos.google.com/album/${albumId}` },
      {},
      resolve
    );
  });
  assert.equal(linked.success, true);
  assert.equal(linked.unverified, true);
  assert.equal(linked.album.id, albumId);
  assert.equal(syncStorage.sgp_album.id, albumId);
  console.log('PASS 相册链接绑定，元数据不可读时按 id 记录');

  // 13) 超时兜底：只给回调且永远不回调的接口不能把消息挂住
  const started = Date.now();
  assert.equal(await context.withTimeout(new Promise(() => {}), 40, 'fallback'), 'fallback');
  assert.ok(Date.now() - started < 1000, 'withTimeout 应及时返回兜底值');

  const originalSyncGet = context.chrome.storage.sync.get;
  context.chrome.storage.sync.get = () => {};
  const syncStarted = Date.now();
  const emptyList = await context.getAlbumList();
  assert.equal(Array.isArray(emptyList) && emptyList.length, 0);
  context.chrome.storage.sync.get = originalSyncGet;
  assert.ok(Date.now() - syncStarted < 6000, 'storage.sync 无响应时不能挂起消息');
  console.log('PASS 存储回调无响应时按超时兜底');

  // 14) albums.get 下线后，名称从已打开的相册标签页标题推断
  assert.equal(context.cleanAlbumTitle('旅行 - Google 相册'), '旅行');
  assert.equal(context.cleanAlbumTitle('Trips - Google Photos'), 'Trips');
  assert.equal(context.cleanAlbumTitle('Google 相册'), '');
  assert.equal(context.cleanAlbumTitle(''), '');

  delete syncStorage.sgp_albums;
  delete syncStorage.sgp_album;
  delete storage.sgp_albums;
  delete storage.sgp_album;
  context.fetch = async () => ({ ok: false, status: 404, text: async () => 'not found' });
  openTabs = [
    { url: 'https://photos.google.com/', title: 'Google 相册' },
    { url: `https://photos.google.com/album/${albumId}?key=1`, title: '旅行照片 - Google 相册' },
  ];
  const named = await new Promise(resolve => {
    messageHandler({ action: 'bindAlbum', input: albumId }, {}, resolve);
  });
  assert.equal(named.success, true);
  assert.equal(named.album.title, '旅行照片');
  assert.equal(syncStorage.sgp_album.title, '旅行照片');

  // 清单里已存占位名时，重新绑定也要修正
  syncStorage.sgp_albums = [{ id: albumId, title: 'Album', itemCount: 0 }];
  const renamed = await new Promise(resolve => {
    messageHandler({ action: 'bindAlbum', input: albumId }, {}, resolve);
  });
  assert.equal(renamed.album.title, '旅行照片');
  console.log('PASS 相册名称从标签页标题推断，并修正已有占位名');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
