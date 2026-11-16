# Chrome Web Store 发布指南

## 📦 准备好的文件

| 文件 | 用途 |
|------|------|
| `release/save-to-google-photos-x.y.z.zip` | 上传到 Chrome Web Store 的扩展包 |
| `store-assets/screenshot1.png` | 商店截图 1 — 功能概览 (1280x800) |
| `store-assets/screenshot2.png` | 商店截图 2 — Popup UI 展示 (1280x800) |
| `PRIVACY_POLICY.md` | 隐私政策（必须提供） |

---

## 🚀 发布步骤

### 1. 注册开发者账号

- 前往 [Chrome Web Store Developer Dashboard](https://chrome.google.com/webstore/devconsole)
- 登录 Google 账号
- 支付一次性注册费 **$5 USD**
- 同意开发者协议

### 2. 设置 Google Cloud OAuth

> ⚠️ 这一步必须在上传扩展之前完成

1. 前往 [Google Cloud Console](https://console.cloud.google.com)
2. 创建项目 → 启用 **Photos Library API**
3. 配置 **OAuth 同意屏幕**:
   - User type: **External**
   - App name: `Save to Google Photos`
   - Scopes: 添加 `photoslibrary.appendonly`
   - 添加你的邮箱为测试用户
4. 创建 **OAuth 2.0 凭据**:
   - Application type: **Chrome Extension**
   - ⚠️ 暂时留空 Extension ID，先上传扩展获取 ID
5. 复制 Client ID，替换 `extension/manifest.json` 中的 `YOUR_CLIENT_ID`

### 3. 上传扩展

1. 在 Developer Dashboard 点击 **New Item**
2. 上传 `release/` 目录下的 zip 包
3. 填写商店信息:

#### Store Listing 信息

| 字段 | 内容 |
|------|------|
| **Title** | Save to Google Photos |
| **Summary** (132字以内) | Right-click any image or video to save it straight to your Google Photos library. Live Photo and batch support, no download step. |
| **Description** | 见下方 |
| **Category** | Photos |
| **Language** | English |

**Description（完整描述）**：

```
Save to Google Photos

Right-click any image or video on a web page and it lands in your Google Photos library at full size. No download folder, no manual upload, no quality loss.

WHY USE IT
The usual route takes five steps: save the file, find it in your Downloads folder, open photos.google.com, upload it, then delete the local copy. This extension removes all of it. The file travels from the page straight to your library, at the resolution the page actually serves.

WHAT YOU CAN SAVE
• Images in JPEG, PNG, WebP, HEIC and GIF.
• Videos in MP4 and MOV, up to 200 MB per file.
• Live Photos. When a page pairs a still image with a short clip, the two are merged into one Google Motion Photo. The motion segment is copied as-is and not re-encoded.
• Full-size files. The extension picks the largest source the page offers and strips CDN resize parameters, so you get the original file rather than the grid thumbnail.
• Up to 60 items at once. Open the popup to see every image and video on the page with its pixel size and an Image, Live Photo or Video label, then tick the ones you want.

ALBUMS
Create an album in the popup once, and everything you save afterwards is added to it automatically. You can unbind or switch albums at any time.

HOW IT WORKS
1. Install the extension and click the icon to sign in with Google.
2. Right-click any image or video, or open the popup to pick several.
3. Choose "Save to Google Photos". A progress toast shows the upload and links to the saved item.

On sites that put invisible links and gradient overlays on top of photos, Chrome suppresses the image right-click menu. Those pages get a second entry, "Save image under cursor to Google Photos", which reads the cursor position and resolves the media underneath.

NO DUPLICATES
Saving the same file twice does not create a second copy in your library. The last 100 results stay in local history, including the reason when something fails.

PRIVACY AND PERMISSIONS
• Append-only access. The extension can add items to your library. The permission it requests, photoslibrary.appendonly, cannot read, edit or delete anything already in your account.
• No servers. Files go from your browser directly to the Google Photos Library API. There is no backend, no analytics and no tracking.
• Local state only. Upload history and duplicate fingerprints live in chrome.storage.local on your device and are never transmitted.
• Sign-in uses Google OAuth 2.0 through the Chrome Identity API. No password ever reaches the extension.

BEFORE YOU INSTALL
• Images smaller than 300 by 300 pixels are skipped.
• The file has to be reachable without a login. Pages behind a paywall or a hotlink check may refuse the download, and the extension reports the failure instead of uploading a broken file.
• On pages Chrome protects, such as the Chrome Web Store, the on-page toast cannot appear even though the upload still runs. Open the popup to see the result in history.

Save to Google Photos is an independent extension. It is not made by, endorsed by, or affiliated with Google.
```

4. 上传截图:
   - `store-assets/screenshot1.png`
   - `store-assets/screenshot2.png`

5. 隐私相关:
   - **Privacy Policy URL**: 把 `PRIVACY_POLICY.md` 发布到 GitHub Pages 或其他公开 URL
   - **Single Purpose**: "Allows users to save images, videos and Live Photos from web pages to their Google Photos library"
   - **Permissions Justification**:
     - `contextMenus`: "Adds a 'Save to Google Photos' option to the right-click menu on images"
     - `identity`: "Authenticates with the user's Google account to access Google Photos API"
     - `scripting`: "Injects the in-page status toast when a page has no content script yet"
     - `storage`: "Keeps a local history of upload results, duplicate-detection fingerprints, and the album binding on this device"
     - `notifications`: "Shows a system notification when an upload fails while the page is in the background"
     - `host_permissions (<all_urls>)`: "Needed to download images from any website"
     - `host_permissions (photoslibrary)`: "Communicates with Google Photos API to upload images"

### 4. 获取 Extension ID 并更新 OAuth

上传后你会在 Dashboard 中看到分配的 **Extension ID**：

1. 复制 Extension ID
2. 回到 Google Cloud Console → OAuth 2.0 凭据
3. 在 "Application ID" 填入 Extension ID
4. 重新打包 ZIP 并重新上传（如果 Client ID 有变）

### 5. 提交审核

- 点击 **Submit for Review**
- 审核通常需要 **1-3 个工作日**
- 审核期间可能会收到邮件要求补充信息

### 6. OAuth 同意屏幕验证（可选但推荐）

如果要让所有用户使用（非仅测试用户），需要：

1. 在 Google Cloud Console → OAuth consent screen
2. 点击 **Publish App**（从 Testing 模式发布为 Production）
3. 如果使用敏感范围（如 `photoslibrary`），需要通过 Google 的验证流程

---

## ⚡ 快速检查清单

- [ ] Google Cloud 项目已创建
- [ ] Photos Library API 已启用
- [ ] OAuth 同意屏幕已配置
- [ ] OAuth Client ID 已创建（Chrome Extension 类型）
- [ ] `extension/manifest.json` 中已填入正确的 Client ID
- [ ] ZIP 包已生成并放入 `release/`
- [ ] 隐私政策已发布到公开 URL
- [ ] 截图已准备好
- [ ] Developer Dashboard 注册费已支付
- [ ] 扩展已上传并提交审核
