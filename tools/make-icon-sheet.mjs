#!/usr/bin/env node
/**
 * 生成图标核对用的 PNG 总表：把抽取出来的图标拼成一张大图，按分类分块。
 *
 * 抽出的贴图大多是 16×16/32×32，直接看很小，所以原样放大 N 倍后拼图，
 * 再用 modlens 视觉工具核对"图标与名字是否一致"。
 *
 * 用法：
 *   node tools/make-icon-sheet.mjs              # 默认输出 research/icon-sheet.png
 *   node tools/make-icon-sheet.mjs --scale=6 --cols=12 --filter=dust
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { inflateSync, deflateSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const root = resolve(join(dirname(fileURLToPath(import.meta.url)), '..'));

function arg(name, fallback) {
  const prefix = `--${name}=`;
  const hit = process.argv.find((value) => value.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : fallback;
}

// ---------------------------------------------------------------- PNG 编解码

/** 解码 PNG（只支持 8 位 RGB/RGBA/灰度，足够处理贴图） */
function decodePng(buffer) {
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

  // 统一转成 RGBA
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

function encodePng(width, height, rgba) {
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

// ---------------------------------------------------------------- 拼图

async function main() {
  const scale = Number(arg('scale', 6));
  const cols = Number(arg('cols', 16));
  const filter = arg('filter', '');
  const outPath = join(root, 'research', arg('out', 'icon-sheet.png'));

  const categories = JSON.parse(await readFile(join(root, 'data', 'categories.json'), 'utf8'));
  const items = (await readFile(join(root, 'data', 'recipes.core.jsonl'), 'utf8'))
    .split(/\r?\n/).filter(Boolean).slice(1).map((line) => JSON.parse(line));
  const names = new Map(items.map((item) => [item.id, item.name]));
  const cache = JSON.parse(await readFile(join(root, 'data', 'icons', 'icon-cache.json'), 'utf8'));

  // 按分类收集物品（跳过没有图标的）
  const entries = [];
  for (const group of categories.groups) {
    if (filter && !group.name.includes(filter) && !group.key.includes(filter)) continue;
    const ids = [...(group.items || [])];
    for (const sub of group.subgroups || []) ids.push(...sub.items);
    const withIcon = ids.filter((id) => cache[id] && existsSync(join(root, cache[id])));
    if (withIcon.length === 0) continue;
    entries.push({ title: group.name, ids: withIcon });
  }

  const total = entries.reduce((sum, entry) => sum + entry.ids.length, 0);
  const cell = 16 * scale;
  const pad = 8;
  const labelHeight = 14;
  const headerHeight = 30;
  const rows = entries.map((entry) => Math.ceil(entry.ids.length / cols));
  const width = cols * (cell + pad) + pad * 2;
  const height = headerHeight * entries.length + rows.reduce((sum, r) => sum + r * (cell + labelHeight + pad) + pad, 0) + pad;
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new Error(`拼图尺寸非法：scale=${scale} cols=${cols} width=${width} height=${height} entries=${entries.length}`);
  }

  const rgba = Buffer.alloc(width * height * 4, 0xff);
  // 背景改浅灰，避免白色图标看不见
  for (let i = 0; i < width * height; i += 1) {
    rgba[i * 4] = 245; rgba[i * 4 + 1] = 246; rgba[i * 4 + 2] = 248;
  }

  function fillRect(x0, y0, w, h, color) {
    for (let y = y0; y < y0 + h && y < height; y += 1) {
      for (let x = x0; x < x0 + w && x < width; x += 1) {
        if (x < 0 || y < 0) continue;
        const index = (y * width + x) * 4;
        rgba[index] = color[0]; rgba[index + 1] = color[1]; rgba[index + 2] = color[2]; rgba[index + 3] = 255;
      }
    }
  }

  let cursorY = pad;
  for (const entry of entries) {
    fillRect(pad, cursorY, width - pad * 2, 22, [60, 90, 130]);
    cursorY += headerHeight;
    entry.ids.forEach((id, index) => {
      const col = index % cols;
      const row = Math.floor(index / cols);
      const x = pad + col * (cell + pad);
      const y = cursorY + row * (cell + labelHeight + pad);
      try {
        const png = decodePng(readFileSync(join(root, cache[id])));
        // 最近邻放大
        for (let sy = 0; sy < cell; sy += 1) {
          for (let sx = 0; sx < cell; sx += 1) {
            const px = Math.floor((sx / cell) * png.width);
            const py = Math.floor((sy / cell) * png.height);
            const src = (py * png.width + px) * 4;
            const alpha = png.rgba[src + 3] / 255;
            const dst = ((y + sy) * width + (x + sx)) * 4;
            rgba[dst] = Math.round(png.rgba[src] * alpha + rgba[dst] * (1 - alpha));
            rgba[dst + 1] = Math.round(png.rgba[src + 1] * alpha + rgba[dst + 1] * (1 - alpha));
            rgba[dst + 2] = Math.round(png.rgba[src + 2] * alpha + rgba[dst + 2] * (1 - alpha));
          }
        }
      } catch (err) {
        fillRect(x, y, cell, cell, [200, 60, 60]);
      }
    });
    cursorY += rows[entries.indexOf(entry)] * (cell + labelHeight + pad) + pad;
  }

  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, encodePng(width, height, rgba));
  console.log(`已写出 ${outPath}：${total} 个图标，${entries.length} 个分类，尺寸 ${width}×${height}`);
  console.log('每个分类一块，顺序与 data/categories.json 一致；分类名印在色块上，但物品名没有印（用序号对齐数据）。');
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
