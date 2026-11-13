// ============================================================
// Save to Google Photos — Motion Photo 1.0 合成
// ============================================================
// 纯字节操作，不重编码。规范：Android Motion Photo format 1.0
// 物理布局：[JPEG 含 XMP] + [MP4 原样追加在 JPEG EOI 之后]
//
// 对外暴露 self.MotionPhoto，供 background service worker 使用。

(function () {
  "use strict";

  const XMP_HEADER_STR = "http://ns.adobe.com/xap/1.0/\u0000";

  function utf8(str) {
    return new TextEncoder().encode(str);
  }

  function concat(chunks) {
    let total = 0;
    for (const c of chunks) total += c.length;
    const out = new Uint8Array(total);
    let offset = 0;
    for (const c of chunks) {
      out.set(c, offset);
      offset += c.length;
    }
    return out;
  }

  function startsWith(buf, prefix) {
    if (buf.length < prefix.length) return false;
    for (let i = 0; i < prefix.length; i++) {
      if (buf[i] !== prefix[i]) return false;
    }
    return true;
  }

  function readU32(buf, off) {
    return ((buf[off] << 24) | (buf[off + 1] << 16) | (buf[off + 2] << 8) | buf[off + 3]) >>> 0;
  }

  function writeU32(buf, off, value) {
    buf[off] = (value >>> 24) & 0xff;
    buf[off + 1] = (value >>> 16) & 0xff;
    buf[off + 2] = (value >>> 8) & 0xff;
    buf[off + 3] = value & 0xff;
  }

  function readU64(buf, off) {
    return readU32(buf, off) * 0x100000000 + readU32(buf, off + 4);
  }

  function boxType(buf, off) {
    return String.fromCharCode(buf[off + 4], buf[off + 5], buf[off + 6], buf[off + 7]);
  }

  // --------------------------------------------------
  // XMP
  // --------------------------------------------------
  function buildXmp(videoLen, timestampUs) {
    const xml = `<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about=""
    xmlns:Camera="http://ns.google.com/photos/1.0/camera/"
    xmlns:Container="http://ns.google.com/photos/1.0/container/"
    xmlns:Item="http://ns.google.com/photos/1.0/container/item/">
   <Camera:MotionPhoto>1</Camera:MotionPhoto>
   <Camera:MotionPhotoVersion>1</Camera:MotionPhotoVersion>
   <Camera:MotionPhotoPresentationTimestampUs>${timestampUs}</Camera:MotionPhotoPresentationTimestampUs>
   <Container:Directory>
    <rdf:Seq>
     <rdf:li rdf:parseType="Resource">
      <Container:Item Item:Mime="image/jpeg" Item:Semantic="Primary" Item:Length="0"/>
     </rdf:li>
     <rdf:li rdf:parseType="Resource">
      <Container:Item Item:Mime="video/mp4" Item:Semantic="MotionPhoto" Item:Length="${videoLen}"/>
     </rdf:li>
    </rdf:Seq>
   </Container:Directory>
  </rdf:Description>
 </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>`;
    return utf8(xml);
  }

  // --------------------------------------------------
  // JPEG 段操作
  // --------------------------------------------------
  function isJpeg(buf) {
    return buf.length > 2 && buf[0] === 0xff && buf[1] === 0xd8;
  }

  function stripExistingXmp(jpeg) {
    if (!isJpeg(jpeg)) throw new Error("The primary image is not a valid JPEG (missing SOI).");

    const parts = [jpeg.subarray(0, 2)];
    const xmpHeader = utf8(XMP_HEADER_STR);
    const n = jpeg.length;
    let i = 2;

    while (i < n - 1) {
      if (jpeg[i] !== 0xff) {
        parts.push(jpeg.subarray(i));
        return concat(parts);
      }
      const marker = jpeg[i + 1];
      // SOS / EOI 之后是图像数据，原样保留
      if (marker === 0xda || marker === 0xd9) {
        parts.push(jpeg.subarray(i));
        return concat(parts);
      }
      // 无长度字段的标记
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        parts.push(jpeg.subarray(i, i + 2));
        i += 2;
        continue;
      }
      const segLen = (jpeg[i + 2] << 8) | jpeg[i + 3];
      const segStart = i + 4;
      const segEnd = i + 2 + segLen;
      if (segEnd > n) {
        parts.push(jpeg.subarray(i));
        return concat(parts);
      }
      const isXmp = marker === 0xe1 && startsWith(jpeg.subarray(segStart, segEnd), xmpHeader);
      if (!isXmp) parts.push(jpeg.subarray(i, segEnd));
      i = segEnd;
    }
    parts.push(jpeg.subarray(i));
    return concat(parts);
  }

  function insertApp1(jpeg, xmp) {
    const payload = concat([utf8(XMP_HEADER_STR), xmp]);
    const segLen = payload.length + 2;
    if (segLen > 0xffff) {
      throw new Error(
        `The XMP segment is too large (${segLen} bytes), exceeding the 65535-byte APP1 limit.`
      );
    }
    const head = new Uint8Array([0xff, 0xe1, (segLen >> 8) & 0xff, segLen & 0xff]);
    return concat([jpeg.subarray(0, 2), head, payload, jpeg.subarray(2)]);
  }

  // --------------------------------------------------
  // MP4 结构解析
  // --------------------------------------------------
  function readBoxes(buf, start, end) {
    const boxes = [];
    let i = start;
    while (i + 8 <= end) {
      let size = readU32(buf, i);
      const type = boxType(buf, i);
      let headerSize = 8;
      if (size === 1) {
        if (i + 16 > end) break;
        size = readU64(buf, i + 8);
        headerSize = 16;
      } else if (size === 0) {
        size = end - i;
      }
      if (size < headerSize || i + size > end) break;
      boxes.push({ type, start: i, size, headerSize });
      i += size;
    }
    return boxes;
  }

  function isMp4(buf) {
    if (buf.length < 12) return false;
    const boxes = readBoxes(buf, 0, Math.min(buf.length, 64));
    return boxes.length > 0 && boxes[0].type === "ftyp";
  }

  // moov 是否位于 mdat 之后（未做 faststart）
  function analyzeMp4(buf) {
    const boxes = readBoxes(buf, 0, buf.length);
    const moovIndex = boxes.findIndex((b) => b.type === "moov");
    const mdatIndex = boxes.findIndex((b) => b.type === "mdat");
    return {
      boxes,
      hasMoov: moovIndex !== -1,
      hasMdat: mdatIndex !== -1,
      needsFaststart: moovIndex !== -1 && mdatIndex !== -1 && moovIndex > mdatIndex,
    };
  }

  const CONTAINER_TYPES = new Set([
    "moov", "trak", "mdia", "minf", "stbl", "edts", "udta", "mvex", "moof", "traf", "dinf",
  ]);

  // 把 stco / co64 的 chunk offset 平移 delta 字节
  function shiftChunkOffsets(buf, start, end, delta) {
    const boxes = readBoxes(buf, start, end);
    for (const box of boxes) {
      const bodyStart = box.start + box.headerSize;
      const bodyEnd = box.start + box.size;
      if (box.type === "stco" || box.type === "co64") {
        const entryCount = readU32(buf, bodyStart + 4);
        if (box.type === "stco") {
          for (let k = 0; k < entryCount; k++) {
            const p = bodyStart + 8 + k * 4;
            if (p + 4 > bodyEnd) break;
            writeU32(buf, p, readU32(buf, p) + delta);
          }
        } else {
          for (let k = 0; k < entryCount; k++) {
            const p = bodyStart + 8 + k * 8;
            if (p + 8 > bodyEnd) break;
            const value = readU64(buf, p) + delta;
            writeU32(buf, p, Math.floor(value / 0x100000000));
            writeU32(buf, p + 4, value >>> 0);
          }
        }
      } else if (CONTAINER_TYPES.has(box.type)) {
        shiftChunkOffsets(buf, bodyStart, bodyEnd, delta);
      }
    }
  }

  // 把 moov 移到 mdat 之前，并修正 chunk offset。返回新的视频字节。
  function applyFaststart(buf) {
    const { boxes, needsFaststart } = analyzeMp4(buf);
    if (!needsFaststart) return buf;

    const moovBox = boxes.find((b) => b.type === "moov");
    const mdatBox = boxes.find((b) => b.type === "mdat");

    const before = boxes.filter((b) => b.start < mdatBox.start);
    const after = boxes.filter((b) => b.start > mdatBox.start && b !== moovBox);

    // 旧布局中 mdat 数据区的绝对偏移
    const oldMdatDataStart = mdatBox.start + mdatBox.headerSize;
    // 新布局：mdat 之前的 box 依次排列，moov 插在最后
    let prefixLen = 0;
    for (const b of before) if (b !== moovBox) prefixLen += b.size;
    const newMdatDataStart = prefixLen + moovBox.size + mdatBox.headerSize;
    const delta = newMdatDataStart - oldMdatDataStart;

    const moovCopy = buf.slice(moovBox.start, moovBox.start + moovBox.size);
    // moov 内部的偏移按相对位置计算，delta 是文件绝对偏移差
    shiftChunkOffsets(moovCopy, 0, moovCopy.length, delta);

    const chunks = [];
    for (const b of before) {
      if (b === moovBox) continue;
      chunks.push(buf.subarray(b.start, b.start + b.size));
    }
    chunks.push(moovCopy);
    chunks.push(buf.subarray(mdatBox.start, mdatBox.start + mdatBox.size));
    for (const b of after) {
      chunks.push(buf.subarray(b.start, b.start + b.size));
    }
    return concat(chunks);
  }

  // 从 mvhd 读取时长（微秒），读不到返回 null
  function readDurationUs(buf) {
    const boxes = readBoxes(buf, 0, buf.length);
    const moov = boxes.find((b) => b.type === "moov");
    if (!moov) return null;
    const inner = readBoxes(buf, moov.start + moov.headerSize, moov.start + moov.size);
    const mvhd = inner.find((b) => b.type === "mvhd");
    if (!mvhd) return null;

    const body = mvhd.start + mvhd.headerSize;
    const version = buf[body];
    let timescale, duration;
    if (version === 1) {
      timescale = readU32(buf, body + 20);
      duration = readU64(buf, body + 24);
    } else {
      timescale = readU32(buf, body + 12);
      duration = readU32(buf, body + 16);
    }
    if (!timescale || !duration) return null;
    return Math.round((duration / timescale) * 1e6);
  }

  // --------------------------------------------------
  // 合成
  // --------------------------------------------------
  function assemble(primaryJpeg, videoBytes, options = {}) {
    if (!isJpeg(primaryJpeg)) {
      throw new Error(
        "The primary image is not a JPEG. Web images must be JPEG to be assembled into a Motion Photo."
      );
    }

    let video = videoBytes;
    if (!isMp4(video)) {
      throw new Error(
        "The motion segment is not an MP4 container. Only MP4/MOV videos are supported."
      );
    }

    const warnings = [];
    const info = analyzeMp4(video);
    if (!info.hasMoov) {
      throw new Error(
        "The motion segment has no moov box and cannot be used as a Motion Photo video track."
      );
    }

    if (info.needsFaststart) {
      video = applyFaststart(video);
      if (!isMp4(video)) {
        throw new Error(
          "Structural validation failed after reordering the motion segment; aborted to avoid producing a damaged file."
        );
      }
      warnings.push("The video had moov at the end; it was moved to the front so the motion segment is streamable.");
    }

    let timestampUs = options.timestampUs;
    if (typeof timestampUs !== "number") {
      const durationUs = readDurationUs(video);
      // Apple Live Photo 的照片通常对应片段中点
      timestampUs = durationUs ? Math.floor(durationUs / 2) : 0;
    }

    const primary = stripExistingXmp(primaryJpeg);
    const still = insertApp1(primary, buildXmp(video.length, timestampUs));
    const total = concat([still, video]);

    return {
      bytes: total,
      stillSize: still.length,
      videoSize: video.length,
      timestampUs,
      warnings,
    };
  }

  self.MotionPhoto = {
    isJpeg,
    isMp4,
    analyzeMp4,
    buildXmp,
    stripExistingXmp,
    insertApp1,
    applyFaststart,
    readDurationUs,
    assemble,
  };
})();
