/**
 * 极简 PNG 编解码（只处理 8 位色的常见贴图），供图标相关工具复用。
 */

import { inflateSync, deflateSync } from 'node:zlib';

/** 解码 PNG，统一返回 RGBA */
export function decodePng(buffer) {
  if (buffer.readUInt32BE(0) !== 0x89504e47) throw new Error('不是 PNG');
  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 8;
  let colorType = 6;
  const idat = [];
  let palette = null;
  let trns = null;

  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
    } else if (type === 'PLTE') {
      palette = Buffer.from(data);
    } else if (type === 'tRNS') {
      trns = Buffer.from(data);
    } else if (type === 'IDAT') {
      idat.push(Buffer.from(data));
    } else if (type === 'IEND') {
      break;
    }
    offset += 12 + length;
  }
  if (bitDepth !== 8) throw new Error(`暂不支持 ${bitDepth} 位色深`);
  const raw = inflateSync(Buffer.concat(idat));
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType];
  if (!channels) throw new Error(`不支持的颜色类型 ${colorType}`);
  const stride = width * channels;
  const pixels = Buffer.alloc(height * stride);

  let pos = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = raw[pos];
    pos += 1;
    const line = raw.subarray(pos, pos + stride);
    pos += stride;
    const out = pixels.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? pixels.subarray((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x += 1) {
      const a = x >= channels ? out[x - channels] : 0;
      const b = prev ? prev[x] : 0;
      const c = prev && x >= channels ? prev[x - channels] : 0;
      let value = line[x];
      if (filter === 1) value += a;
      else if (filter === 2) value += b;
      else if (filter === 3) value += (a + b) >> 1;
      else if (filter === 4) {
        const pa = Math.abs(b - c);
        const pb = Math.abs(a - c);
        const pc = Math.abs(a + b - 2 * c);
        value += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
      }
      out[x] = value & 0xff;
    }
  }

  const rgba = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i += 1) {
    let r; let g; let b; let a = 255;
    if (colorType === 6) { r = pixels[i * 4]; g = pixels[i * 4 + 1]; b = pixels[i * 4 + 2]; a = pixels[i * 4 + 3]; }
    else if (colorType === 2) { r = pixels[i * 3]; g = pixels[i * 3 + 1]; b = pixels[i * 3 + 2]; }
    else if (colorType === 0) { r = pixels[i]; g = pixels[i]; b = pixels[i]; }
    else if (colorType === 4) { r = pixels[i * 2]; g = pixels[i * 2]; b = pixels[i * 2]; a = pixels[i * 2 + 1]; }
    else { const index = pixels[i]; r = palette[index * 3]; g = palette[index * 3 + 1]; b = palette[index * 3 + 2]; a = trns && index < trns.length ? trns[index] : 255; }
    rgba[i * 4] = r; rgba[i * 4 + 1] = g; rgba[i * 4 + 2] = b; rgba[i * 4 + 3] = a;
  }
  return { width, height, rgba };
}

function crc32(buffer) {
  let crc = ~0;
  for (const byte of buffer) {
    crc ^= byte;
    for (let i = 0; i < 8; i += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return ~crc >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/** 把 RGBA 数据编码成 PNG */
export function encodePng(width, height, rgba) {
  const stride = width * 4;
  const raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** 从大图里裁一块，并缩放到目标尺寸（最近邻） */
export function cropScale(image, sx, sy, sw, sh, targetWidth, targetHeight) {
  const out = Buffer.alloc(targetWidth * targetHeight * 4);
  for (let y = 0; y < targetHeight; y += 1) {
    for (let x = 0; x < targetWidth; x += 1) {
      const px = sx + Math.floor((x / targetWidth) * sw);
      const py = sy + Math.floor((y / targetHeight) * sh);
      const src = (py * image.width + px) * 4;
      const dst = (y * targetWidth + x) * 4;
      out[dst] = image.rgba[src];
      out[dst + 1] = image.rgba[src + 1];
      out[dst + 2] = image.rgba[src + 2];
      out[dst + 3] = image.rgba[src + 3];
    }
  }
  return { width: targetWidth, height: targetHeight, rgba: out };
}

/** 写一张放大后的 PNG（用于人眼/视觉模型核对） */
export function upscale(image, scale) {
  return cropScale(image, 0, 0, image.width, image.height, image.width * scale, image.height * scale);
}
