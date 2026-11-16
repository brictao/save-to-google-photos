#!/usr/bin/env node
// 验证相册创建、单张与批量归入相册，以及相册失效时的降级行为。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const noop = () => {};
const listener = { addListener: noop };

const storage = {};
const context = {
  console: { log: noop, warn: noop, error: noop },
  Blob, URL, TextEncoder, setTimeout, clearTimeout, AbortController,
  importScripts: noop,
  self: { MotionPhoto: {} },
  chrome: {
    runtime: { onInstalled: listener, onStartup: listener, onMessage: listener },
    contextMenus: { create: noop, removeAll: cb => cb?.(), update: noop, onClicked: listener },
    tabs: { onActivated: listener },
    storage: {
      local: {
        get: (key, cb) => cb({ [key]: storage[key] }),
        set: (obj, cb) => {
          Object.assign(storage, obj);
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
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
