# Live Photo 上传可行性实测

目标：判断「Apple Live Photo 转成单文件动态照片后，能否经 Google Photos Library API 上传并保留动态效果」。

分两轮。第一轮用自制样本验证 API 通道本身，第二轮换真实 Apple 素材。

---

## 第一轮：自制 Motion Photo 通道验证

### 测试文件

| 文件 | 用途 | 地址 |
|---|---|---|
| `test.MP.jpg` | 实验组，Google Motion Photo 1.0 单文件，787963 字节（静态 10450 + 动态 777513） | http://127.0.0.1:8765/test.MP.jpg |
| `primary.jpg` | 对照组，纯静态 JPEG，9942 字节 | http://127.0.0.1:8765/primary.jpg |

本地服务已在 `127.0.0.1:8765` 运行。两个文件结构校验见下方记录。

### 操作步骤

1. 确认 Chrome 已加载本扩展且已登录 Google 账号（点扩展图标检查状态）。
2. 浏览器打开 http://127.0.0.1:8765/test.MP.jpg
3. 在图片上右键，选择 **Save to Google Photos**。页面右上角出现成功 toast 即上传完成。
4. 同样方式上传对照组 http://127.0.0.1:8765/primary.jpg
5. 打开 Google Photos，找到刚上传的两张 1080×1440 蓝色图。

### 判断标准

对照组是纯静态图，用来排除「上传本身失败」。实验组看动态是否保留。

按以下顺序检查，逐项记录实际看到的现象：

| 检查点 | 说明 |
|---|---|
| photos.google.com 网页版 | 打开实验组照片，是否出现动态播放控件或「动态照片」标记 |
| Google Photos iOS app | 长按照片是否播放，或详情里是否有 LIVE / 动态 标记 |
| 下载回来再比对 | 从 Google Photos 下载实验组，文件大小是否仍是 787963 字节，尾部 MP4 是否还在 |

第三项最关键。如果下载回来的文件变小、或者尾部 MP4 消失，说明 Google 在服务端做了转码，动态数据被丢弃。

### 结论判定

- 三项都能看到动态：API 通道可用，可以进入第二轮。
- 网页版看不到但 app 能看到：通道可用，网页版只是不渲染。
- 下载回来文件变小且无动态：API 上传会丢动态，方案需要换。

---

## 结构校验记录（本地已通过）

`python3 -I verify_motion_photo.py build/test.MP.jpg` 结果：13 项全部通过。

```
[PASS] 文件以 JPEG SOI (FFD8) 开头
[PASS] 找到 APP1 XMP 段
[PASS] Camera:MotionPhoto = 1
[PASS] Camera:MotionPhotoVersion = 1
[PASS] 存在 Primary 条目
[PASS] 存在 MotionPhoto 条目
[PASS] 动态段声明为 video/mp4
[PASS] Primary 的 Item:Length 为 0 (规范要求)
[PASS] 解析 MotionPhoto 的 Item:Length
[PASS] 静态段长度为正  still=10450
[PASS] 静态段以 JPEG EOI (FFD9) 结束, 与 Item:Length 对齐
[PASS] 尾部字节数等于声明的视频长度  实际=777513 声明=777513
[PASS] 动态段在偏移 4 处含 MP4 ftyp box
```

---

## 第二轮：真实 Apple Live Photo（本地验证通过，云端验证待完成）

2026-11-12 使用 `source/IMG_4038.HEIC` 与 `source/IMG_4038.mov`，生成 `output/IMG_4038.MP.jpg`。原始素材未修改。

| 检查项 | 实测结果 |
|---|---|
| 合成文件大小 | 9860228 字节 |
| JPEG 与 XMP 段 | 8044871 字节 |
| MP4 段 | 1815357 字节 |
| 动态视频 | H.264，1308×1744，2.314545 秒 |
| 音频 | AAC，2.280000 秒 |
| 主图方向 | HEIC 与 JPEG 均为 Orientation 6，存储尺寸 5712×4284，显示为竖屏 |
| 结构校验 | 13 项通过 |
| 完整解码 | ffmpeg 解码视频和音频通过 |
| 封面帧时间 | 1157272 微秒，使用视频中点回退，未读出 Apple 精确时间 |

SHA-256：`530b3a4ca0cf2c0ba6be332f38e4c46b2be3dbfdef15e05a849ed6ce1ab32709`

限制：HEIC 转 JPEG、HEVC 转 H.264、PCM 转 AAC 均不保证无损。主图方向元数据已保留，但仍需在 Google Photos 中确认实际显示方向及播放表现。本次未验证 Apple 配对标识，也未证明可还原为 Apple 原生 Live Photo。第一轮的云端播放和下载哈希一致结果只适用于此前的自制样本。

从项目根目录运行：

```bash
python3 -I livephoto-test/apple_live_to_motion.py livephoto-test/source/IMG_4038.HEIC livephoto-test/source/IMG_4038.mov livephoto-test/output/IMG_4038.MP.jpg
python3 -I livephoto-test/verify_motion_photo.py livephoto-test/output/IMG_4038.MP.jpg
python3 -I -m http.server 8765 --bind 127.0.0.1 --directory livephoto-test/output
```

本轮服务目录为 `output/`，与第一轮的 `build/` 不同。打开 http://127.0.0.1:8765/IMG_4038.MP.jpg ，在图片上右键选择 **Save to Google Photos**。检查网页与手机端的动态播放、方向、声音，并下载原文件与上面的 SHA-256 比较。文件大小相同不足以证明逐字节一致。

---

## 复现命令

```bash
# 合成
python3 -I make_motion_photo.py build/primary.jpg build/motion.mp4 build/test.MP.jpg

# 校验
python3 -I verify_motion_photo.py build/test.MP.jpg

# 提供文件
cd build && python3 -m http.server 8765 --bind 127.0.0.1
```
