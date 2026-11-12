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
| **Summary** (132字以内) | Right-click any image on the web and save it directly to your Google Photos library. Fast, secure, and private. |
| **Description** | 见下方 |
| **Category** | Photos |
| **Language** | English |

**Description（完整描述）**：

```
Save to Google Photos — The easiest way to save web images to your Google Photos library.

🖱️ SIMPLE TO USE
Just right-click any image on any web page and select "Save to Google Photos". That's it! The image will be uploaded directly to your Google Photos library.

🔒 SECURE & PRIVATE
• Uses Google's official OAuth 2.0 authentication
• No data is collected, stored, or shared
• Images are uploaded directly to your account
• Only "append" permission — cannot read or delete your photos

📸 WIDE FORMAT SUPPORT
Supports JPEG, PNG, GIF, WebP, AVIF, BMP, TIFF, and more.

🔔 INSTANT FEEDBACK
Get real-time notifications when your image is saved successfully.

✨ HOW IT WORKS
1. Click the extension icon and sign in with your Google account
2. Right-click any image on the web
3. Select "Save to Google Photos"
4. Done! Check your Google Photos library.
```

4. 上传截图:
   - `store-assets/screenshot1.png`
   - `store-assets/screenshot2.png`

5. 隐私相关:
   - **Privacy Policy URL**: 把 `PRIVACY_POLICY.md` 发布到 GitHub Pages 或其他公开 URL
   - **Single Purpose**: "Allows users to save images from web pages to their Google Photos library"
   - **Permissions Justification**:
     - `contextMenus`: "Adds a 'Save to Google Photos' option to the right-click menu on images"
     - `identity`: "Authenticates with the user's Google account to access Google Photos API"
     - `notifications`: "Shows upload status notifications (success or error)"
     - `activeTab`: "Needed to access the image URL from the current page"
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
