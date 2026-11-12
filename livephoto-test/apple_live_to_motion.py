#!/usr/bin/env python3
"""Apple Live Photo (HEIC/JPG + MOV) → Google Motion Photo 单文件。

用法:
  python3 apple_live_to_motion.py <heic-or-jpg> <mov> <out.MP.jpg>

处理链:
  1. sips 把 HEIC 解成 JPEG 主图 (保留 EXIF, sips 会应用 Orientation)
  2. ffmpeg 把 MOV 转成 H.264 / yuv420p 的 MP4, 只保留视频与音频流,
     顺带丢掉 Apple 的 mebx 元数据轨 (Google 不读这个轨)
  3. 用 Camera:MotionPhotoPresentationTimestampUs 指定封面帧时间

封面帧时间来源优先级:
  a. Apple MOV 里 com.apple.quicktime.still-image-time 轨能解析出值就用它
  b. 解析不到就用视频时长中点 (Apple Live Photo 的惯例是照片在中间)
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from make_motion_photo import build_xmp, insert_app1, strip_existing_xmp  # noqa: E402


def run(cmd: list[str], label: str) -> str:
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        raise RuntimeError(f"{label} 失败:\n{result.stderr.strip()}")
    return result.stdout


def heic_to_jpeg(src: str, dst: str) -> None:
    run(["sips", "-s", "format", "jpeg", "-s", "formatOptions", "best", src, "--out", dst], "HEIC 转 JPEG")


def mov_to_mp4(src: str, dst: str) -> None:
    """转成 H.264 MP4。宽高取偶数以满足 4:2:0 编码要求。"""
    run([
        "ffmpeg", "-y", "-loglevel", "error", "-i", src,
        "-map", "0:v:0", "-map", "0:a?",
        "-c:v", "libx264", "-preset", "medium", "-crf", "20",
        "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2",
        "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-b:a", "96k",
        "-movflags", "+faststart",
        dst,
    ], "MOV 转 H.264 MP4")


def probe_mp4(path: str) -> tuple[int, dict]:
    """返回 (duration_us, 关键流信息)。"""
    out = run(["ffprobe", "-v", "error", "-show_format", "-show_streams", "-of", "json", path], "ffprobe 读取")
    info = json.loads(out)
    duration = float(info.get("format", {}).get("duration", 0) or 0)
    streams = info.get("streams", [])
    video = next((s for s in streams if s.get("codec_type") == "video"), {})
    return int(duration * 1_000_000), {
        "codec": video.get("codec_name"),
        "width": video.get("width"),
        "height": video.get("height"),
        "frames": video.get("nb_frames"),
        "has_audio": any(s.get("codec_type") == "audio" for s in streams),
        "size": os.path.getsize(path),
    }


def read_still_image_time(mov_path: str) -> int | None:
    """尽力读取 Apple still-image-time 轨的时间戳, 读不到返回 None。"""
    try:
        out = run([
            "ffprobe", "-v", "error", "-select_streams", "d",
            "-show_frames", "-show_entries", "frame=best_effort_timestamp_time",
            "-of", "json", mov_path,
        ], "读取 still-image-time")
        frames = json.loads(out).get("frames", [])
        if frames:
            ts = frames[0].get("best_effort_timestamp_time")
            if ts is not None:
                return int(float(ts) * 1_000_000)
    except Exception:
        pass
    return None


def main() -> int:
    if len(sys.argv) != 4:
        print(__doc__)
        return 2
    heic_path, mov_path, out_path = sys.argv[1:4]
    for p in (heic_path, mov_path):
        if not os.path.isfile(p):
            print(f"找不到文件: {p}")
            return 1

    with tempfile.TemporaryDirectory() as tmp:
        jpeg_tmp = os.path.join(tmp, "primary.jpg")
        mp4_tmp = os.path.join(tmp, "motion.mp4")

        heic_to_jpeg(heic_path, jpeg_tmp)
        mov_to_mp4(mov_path, mp4_tmp)

        jpeg_size = os.path.getsize(jpeg_tmp)
        duration_us, vin = probe_mp4(mp4_tmp)

        still_us = read_still_image_time(mov_path)
        if still_us is not None:
            timestamp_us, source = still_us, "Apple still-image-time 轨"
        else:
            timestamp_us, source = duration_us // 2, "视频时长中点 (回退)"

        with open(jpeg_tmp, "rb") as f:
            primary = strip_existing_xmp(f.read())
        with open(mp4_tmp, "rb") as f:
            video = f.read()

        still = insert_app1(primary, build_xmp(len(video), timestamp_us))
        os.makedirs(os.path.dirname(os.path.abspath(out_path)), exist_ok=True)
        with open(out_path, "wb") as f:
            f.write(still + video)
        total = len(still) + len(video)

    print(f"主图 JPEG      : {jpeg_size} 字节")
    print(f"动态段 MP4     : {vin['size']} 字节  {vin['codec']} {vin['width']}x{vin['height']} 音频={vin['has_audio']}")
    print(f"视频时长       : {duration_us / 1_000_000:.3f} 秒")
    print(f"封面帧时间戳   : {timestamp_us} 微秒  来源: {source}")
    print(f"合成结果       : {total} 字节 -> {out_path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
