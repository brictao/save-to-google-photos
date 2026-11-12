#!/usr/bin/env python3
"""把 JPEG 主图与 MP4 合成为 Google Motion Photo 1.0 单文件。

用法: python3 -I make_motion_photo.py <primary.jpg> <motion.mp4> <out.MP.jpg>

规范依据: Android Motion Photo format 1.0
  - 物理布局: [JPEG 含 XMP] + [MP4 原样追加在 EOI 之后]
  - Container:Directory 第一项必须是 Primary(image/jpeg), Length 为 0
  - 最后一项是 MotionPhoto(video/mp4), Length 为视频真实字节数
  - 次要项不允许带 Item:Padding
"""
import sys

XMP_TEMPLATE = """<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about=""
    xmlns:Camera="http://ns.google.com/photos/1.0/camera/"
    xmlns:Container="http://ns.google.com/photos/1.0/container/"
    xmlns:Item="http://ns.google.com/photos/1.0/container/item/">
   <Camera:MotionPhoto>1</Camera:MotionPhoto>
   <Camera:MotionPhotoVersion>1</Camera:MotionPhotoVersion>
   <Camera:MotionPhotoPresentationTimestampUs>{timestamp_us}</Camera:MotionPhotoPresentationTimestampUs>
   <Container:Directory>
    <rdf:Seq>
     <rdf:li rdf:parseType="Resource">
      <Container:Item Item:Mime="image/jpeg" Item:Semantic="Primary" Item:Length="0"/>
     </rdf:li>
     <rdf:li rdf:parseType="Resource">
      <Container:Item Item:Mime="video/mp4" Item:Semantic="MotionPhoto" Item:Length="{video_len}"/>
     </rdf:li>
    </rdf:Seq>
   </Container:Directory>
  </rdf:Description>
 </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>"""

XMP_HEADER = b"http://ns.adobe.com/xap/1.0/\x00"


def build_xmp(video_len: int, timestamp_us: int = 0) -> bytes:
    return XMP_TEMPLATE.format(video_len=video_len, timestamp_us=timestamp_us).encode("utf-8")


def strip_existing_xmp(jpeg: bytes) -> bytes:
    """去掉 JPEG 里已有的 XMP APP1, 避免上传后出现两段冲突元数据。"""
    if jpeg[:2] != b"\xff\xd8":
        raise ValueError("输入不是合法 JPEG (缺少 SOI)")
    out = bytearray(jpeg[:2])
    i, n = 2, len(jpeg)
    while i < n - 1:
        if jpeg[i] != 0xFF:
            out += jpeg[i:]
            return bytes(out)
        marker = jpeg[i + 1]
        if marker in (0xDA, 0xD9):  # SOS / EOI 之后都是图像数据
            out += jpeg[i:]
            return bytes(out)
        if marker == 0x01 or 0xD0 <= marker <= 0xD7:  # 无长度字段的标记
            out += jpeg[i:i + 2]
            i += 2
            continue
        seg_len = int.from_bytes(jpeg[i + 2:i + 4], "big")
        seg_start = i + 4
        seg_end = i + 2 + seg_len
        is_xmp = marker == 0xE1 and jpeg[seg_start:seg_end].startswith(XMP_HEADER)
        if not is_xmp:
            out += jpeg[i:seg_end]
        i = seg_end
    out += jpeg[i:]
    return bytes(out)


def insert_app1(jpeg: bytes, xmp: bytes) -> bytes:
    payload = XMP_HEADER + xmp
    seg_len = len(payload) + 2
    if seg_len > 0xFFFF:
        raise ValueError(f"XMP 段过长 ({seg_len} 字节), 超过 APP1 上限 65535")
    app1 = b"\xff\xe1" + seg_len.to_bytes(2, "big") + payload
    return jpeg[:2] + app1 + jpeg[2:]


def main() -> int:
    if len(sys.argv) != 4:
        print(__doc__)
        return 2
    primary_path, video_path, out_path = sys.argv[1:4]

    with open(primary_path, "rb") as f:
        primary = strip_existing_xmp(f.read())
    with open(video_path, "rb") as f:
        video = f.read()

    still = insert_app1(primary, build_xmp(len(video)))
    total = still + video
    with open(out_path, "wb") as f:
        f.write(total)

    print(f"still段(JPEG+XMP) = {len(still)} 字节")
    print(f"动态段(MP4)       = {len(video)} 字节")
    print(f"总计              = {len(total)} 字节")
    print(f"输出              = {out_path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
