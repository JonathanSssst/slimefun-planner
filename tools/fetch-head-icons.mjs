#!/usr/bin/env node
/**
 * 给"玩家头颅"类物品生成图标：从皮肤 CDN 取皮肤，裁出**脸部**（8,8 - 16,16）做成 16×16 图标。
 *
 * 背景：粘液科技里很多自定义物品（导能水晶、碳、各种粉、护身符…）在游戏里是玩家头颅，
 * 贴图以"皮肤哈希"形式写在插件的 HeadTexture.java 里。这类物品没有平面的物品贴图，
 * 资源包里也常常只给盔甲图层，所以本机抽取会漏掉它们。
 * 皮肤哈希对应的皮肤是公开可取的：http://textures.minecraft.net/texture/<hash>
 * 把脸裁出来当图标，虽然和游戏里"整个头颅"的样子略有差别（少了侧面），但一眼能认出物品。
 *
 * 产物同样写进 data/icons/（已 gitignore，不入库）。
 *
 * 用法：
 *   node tools/fetch-head-icons.mjs            # 只补缺失的
 *   node tools/fetch-head-icons.mjs --all      # 全部重新生成
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { decodePng, encodePng, cropScale } from './lib/png.mjs';

const root = resolve(join(dirname(fileURLToPath(import.meta.url)), '..'));
const iconDir = join(root, 'data', 'icons');
const force = process.argv.includes('--all');
const SKIN_URL = (hash) => `http://textures.minecraft.net/texture/${hash}`;

async function main() {
  const headPath = join(root, 'research', 'head-textures.json');
  if (!existsSync(headPath)) {
    throw new Error('缺少 research/head-textures.json，请先跑 node --use-system-ca tools/extract-head-textures.mjs');
  }
  const heads = JSON.parse(await readFile(headPath, 'utf8'));

  const items = (await readFile(join(root, 'data', 'recipes.core.jsonl'), 'utf8'))
    .split(/\r?\n/).filter(Boolean).slice(1).map((line) => JSON.parse(line));
  const cachePath = join(iconDir, 'icon-cache.json');
  const cache = existsSync(cachePath) ? JSON.parse(await readFile(cachePath, 'utf8')) : {};
  const provenancePath = join(iconDir, 'icon-provenance.json');
  const provenance = existsSync(provenancePath) ? JSON.parse(await readFile(provenancePath, 'utf8')) : {};

  await mkdir(iconDir, { recursive: true });

  let written = 0;
  let skipped = 0;
  let tlsFailed = 0;
  const failed = [];

  for (const item of items) {
    const short = item.id.split(':').pop();
    const hash = heads[short];
    if (!hash) continue;
    if (!force && cache[item.id] && existsSync(join(root, cache[item.id]))) { skipped += 1; continue; }

    try {
      const response = await fetch(SKIN_URL(hash), { headers: { 'User-Agent': 'slimefun-planner-head-icons' } });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const skin = decodePng(Buffer.from(await response.arrayBuffer()));
      if (skin.width < 16 || skin.height < 16) throw new Error(`皮肤尺寸异常 ${skin.width}×${skin.height}`);
      // 1.8 老格式皮肤是 64×32，头脸在 (8,8)，大小 8×8
      const face = cropScale(skin, 8, 8, 8, 8, 16, 16);
      const file = `${item.id.replace(/[^A-Za-z0-9_.-]/g, '_')}.png`;
      await writeFile(join(iconDir, file), encodePng(16, 16, face.rgba));
      cache[item.id] = `data/icons/${file}`;
      provenance[item.id] = `head:${hash.slice(0, 12)}`;
      written += 1;
    } catch (err) {
      const cause = err.cause?.message || err.message;
      if (/certificate|CA/i.test(cause)) {
        failed.push(`${item.id}: TLS 证书校验失败`);
        tlsFailed += 1;
      } else {
        failed.push(`${item.id}: ${cause}`);
      }
    }
  }

  await writeFile(cachePath, `${JSON.stringify(cache, null, 2)}\n`, 'utf8');
  await writeFile(provenancePath, `${JSON.stringify(provenance, null, 2)}\n`, 'utf8');

  console.log(`头颅类物品：新生成 ${written} 张，跳过（已有）${skipped} 张，失败 ${failed.length} 张`);
  if (tlsFailed > 0) {
    console.log(`\n⚠ 有 ${tlsFailed} 张因为 TLS 证书校验失败。这台机器的 Node 证书链不完整，加参数重跑即可：`);
    console.log('   node --use-system-ca tools/fetch-head-icons.mjs --all');
  } else if (failed.length > 0) {
    console.log('  失败：' + failed.slice(0, 10).join('；'));
  }
  console.log(`icon-cache.json 现有 ${Object.keys(cache).length} 条`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
