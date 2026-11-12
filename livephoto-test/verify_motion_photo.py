#!/usr/bin/env python3
"""独立校验 Motion Photo 文件结构, 不复用合成脚本的任何逻辑。

用法: python3 -I verify_motion_photo.py <file.MP.jpg>
退出码 0 表示所有断言通过。
"""
from __future__ import annotations

import re
import sys

XMP_HEADER = b"http://ns.adobe.com/xap/1.0/\x00"


def find_xmp(jpeg: bytes) -> bytes | None:
    """遍历 JPEG 段, 返回 APP1 里的 XMP 载荷。"""
    i, n = 2, len(jpeg)
    while i < n - 1:
        if jpeg[i] != 0xFF:
            return None
        marker = jpeg[i + 1]
        if marker in (0xDA, 0xD9):
            return None
        if marker == 0x01 or 0xD0 <= marker <= 0xD7:
            i += 2
            continue
        seg_len = int.from_bytes(jpeg[i + 2:i + 4], "big")
        start, end = i + 4, i + 2 + seg_len
        if marker == 0xE1 and jpeg[start:end].startswith(XMP_HEADER):
            return jpeg[start + len(XMP_HEADER):end]
        i = end
    return None


def main() -> int:
    if len(sys.argv) != 2:
        print(__doc__)
        return 2
    path = sys.argv[1]
    with open(path, "rb") as f:
        data = f.read()

    failures: list[str] = []

    def check(cond: bool, label: str, detail: str = "") -> None:
        status = "PASS" if cond else "FAIL"
        print(f"[{status}] {label}" + (f"  {detail}" if detail else ""))
        if not cond:
            failures.append(label)

    check(data[:2] == b"\xff\xd8", "文件以 JPEG SOI (FFD8) 开头")

    xmp = find_xmp(data)
    check(xmp is not None, "找到 APP1 XMP 段")
    if xmp is None:
        return 1

    text = xmp.decode("utf-8", errors="replace")
    check("<Camera:MotionPhoto>1</Camera:MotionPhoto>" in text, "Camera:MotionPhoto = 1")
    check("Camera:MotionPhotoVersion>1<" in text, "Camera:MotionPhotoVersion = 1")
    check('Item:Semantic="Primary"' in text, "存在 Primary 条目")
    check('Item:Semantic="MotionPhoto"' in text, "存在 MotionPhoto 条目")
    check('Item:Mime="video/mp4"' in text, "动态段声明为 video/mp4")

    primary_len = re.search(r'Item:Semantic="Primary"[^/]*?Item:Length="(\d+)"', text)
    check(primary_len is not None and primary_len.group(1) == "0",
          "Primary 的 Item:Length 为 0 (规范要求)", primary_len.group(1) if primary_len else "未找到")

    video_match = re.search(r'Item:Semantic="MotionPhoto"[^/]*?Item:Length="(\d+)"', text)
    check(video_match is not None, "解析 MotionPhoto 的 Item:Length")
    if not video_match:
        return 1
    video_len = int(video_match.group(1))

    still_len = len(data) - video_len
    check(still_len > 0, "静态段长度为正", f"still={still_len}")
    check(data[still_len - 2:still_len] == b"\xff\xd9",
          "静态段以 JPEG EOI (FFD9) 结束, 与 Item:Length 对齐",
          f"实际字节 {data[still_len - 2:still_len].hex()}")

    tail = data[still_len:]
    check(len(tail) == video_len, "尾部字节数等于声明的视频长度",
          f"实际={len(tail)} 声明={video_len}")
    ftyp_pos = tail.find(b"ftyp")
    check(ftyp_pos == 4, "动态段在偏移 4 处含 MP4 ftyp box", f"ftyp 偏移={ftyp_pos}")

    print()
    if failures:
        print(f"结果: {len(failures)} 项未通过 -> {', '.join(failures)}")
        return 1
    print(f"结果: 全部通过 (静态 {still_len} 字节 + 动态 {video_len} 字节, 合计 {len(data)})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
