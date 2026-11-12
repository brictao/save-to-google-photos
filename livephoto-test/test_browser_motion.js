#!/usr/bin/env node
// 验证浏览器端 motion-photo.js：
//   A. 与 Python 参考实现在同样输入下是否逐字节一致
//   B. moov 在尾部的视频能否正确重排为 faststart
//
// 用法: node test_browser_motion.js <primary.jpg> <motion.mp4> <python参考输出>

global.self = global;

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

require(path.resolve(__dirname, "../extension/motion-photo.js"));
const MP = self.MotionPhoto;

const [, , primaryPath, videoPath, refPath] = process.argv;
if (!primaryPath || !videoPath) {
  console.error("用法: node test_browser_motion.js <primary.jpg> <motion.mp4> [python参考输出]");
  process.exit(2);
}

const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");
const read = (p) => new Uint8Array(fs.readFileSync(p));

let failures = 0;
const check = (ok, label, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? "  " + detail : ""}`);
  if (!ok) failures++;
};

const primary = read(primaryPath);
const video = read(videoPath);

console.log(`主图      : ${primary.length} 字节`);
console.log(`动态段    : ${video.length} 字节`);
console.log(`视频结构  : ${MP.isMp4(video) ? "MP4" : "非 MP4"}`);
const info = MP.analyzeMp4(video);
console.log(`moov 位置 : ${info.needsFaststart ? "mdat 之后（需重排）" : "mdat 之前（已 faststart）"}`);
console.log("");

// ---------- A. 与 Python 参考输出比对 ----------
if (refPath) {
  const ref = read(refPath);
  const result = MP.assemble(primary, video, { timestampUs: 0 });
  check(sha256(result.bytes) === sha256(ref), "与 Python 参考输出逐字节一致",
    `${result.bytes.length} vs ${ref.length} 字节`);
}

// ---------- B. 合成结构校验 ----------
const merged = MP.assemble(primary, video, { timestampUs: 0 });
const buf = merged.bytes;

check(MP.isJpeg(buf), "输出以 JPEG SOI 开头");
check(buf.length === merged.stillSize + merged.videoSize, "总长度 = 静态段 + 动态段");

const text = Buffer.from(buf.subarray(0, merged.stillSize)).toString("latin1");
check(text.includes("<Camera:MotionPhoto>1</Camera:MotionPhoto>"), "XMP 含 MotionPhoto=1");
check(
  text.includes(`Item:Length="${merged.videoSize}"`),
  "XMP 声明的视频长度与实际一致",
  `${merged.videoSize}`
);
check(text.includes('Item:Semantic="Primary" Item:Length="0"'), "Primary 项 Length 为 0");
check(
  (text.match(/ns\.adobe\.com\/xap\/1\.0\//g) || []).length === 1,
  "只存在一段 XMP APP1"
);

const eoi = buf.lastIndexOf(0xff, merged.stillSize - 2);
check(
  buf[merged.stillSize - 2] === 0xff && buf[merged.stillSize - 1] === 0xd9,
  "静态段以 FFD9 结束"
);
check(
  MP.isMp4(buf.subarray(merged.stillSize)),
  "动态段是完整 MP4 容器"
);
check(
  MP.readDurationUs(buf.subarray(merged.stillSize)) !== null,
  "动态段能读出时长"
);

// 时间戳写入检查
const stamped = MP.assemble(primary, video, { timestampUs: 1234567 });
const stampText = Buffer.from(stamped.bytes.subarray(0, stamped.stillSize)).toString("latin1");
check(
  stampText.includes("<Camera:MotionPhotoPresentationTimestampUs>1234567</Camera:MotionPhotoPresentationTimestampUs>"),
  "封面帧时间戳按参数写入"
);

const outPath = path.join(__dirname, "build", "browser_test.MP.jpg");
fs.writeFileSync(outPath, buf);
console.log(`\n输出文件: ${outPath}`);

console.log(failures === 0 ? "\n全部通过" : `\n${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
