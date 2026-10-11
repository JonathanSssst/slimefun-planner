#!/usr/bin/env node
/**
 * 把物品图标下载到本地缓存 data/icons/，让工具在离线状态下也能显示真实图标。
 *
 * 下载来源：
 *   1. 粘液科技官方资源包仓库的精灵图（按物品 ID 命名）——社区美术资源；
 *   2. 原版贴图镜像 misode/mcmeta（item 优先，block 兜底）——Mojang 素材；
 *   3. 已知头颅贴图（HeadTexture 枚举）——暂不处理，仍走徽章。
 *
 * 注意：Mojang 素材按官方指引不应再分发，所以默认**只下载第 1 类**（社区资源，
 * 体积约 85KB）。想连原版也缓存到本地，加 --with-vanilla（仅供自用，别提交到公开仓库）。
 *
 * 用法：
 *   node --use-system-ca tools/download-icons.mjs
 *   node --use-system-ca tools/download-icons.mjs --with-vanilla
 */

import { writeFile, mkdir, readFile, readdir, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const root = resolve(join(dirname(fileURLToPath(import.meta.url)), '..'));
const iconDir = join(root, 'data', 'icons');
const PACK = 'Slimefun/Resourcepack';
const PACK_BRANCH = 'master';
const PACK_PREFIX = 'assets/slimefun/textures/item/';
const MCMETA = 'https://raw.githubusercontent.com/misode/mcmeta/assets/assets/minecraft/textures';

const withVanilla = process.argv.includes('--with-vanilla');

function fileNameFor(id) {
  return `${id.replace(/[^A-Za-z0-9_.-]/g, '_')}.png`;
}

async function fetchBytes(url) {
  const response = await fetch(url, { headers: { 'User-Agent': 'slimefun-planner-icon-cache' } });
  if (!response.ok) return null;
  return Buffer.from(await response.arrayBuffer());
}

async function packTextures() {
  const response = await fetch(`https://api.github.com/repos/${PACK}/git/trees/HEAD?recursive=1`, {
    headers: { 'User-Agent': 'slimefun-planner-icon-cache' },
  });
  if (!response.ok) throw new Error(`拉取资源包文件树失败：HTTP ${response.status}`);
  const tree = (await response.json()).tree;
  return new Map(
    tree
      .filter((node) => node.path.startsWith(PACK_PREFIX) && node.path.endsWith('.png'))
      .map((node) => [node.path.slice(PACK_PREFIX.length).replace(/\.png$/i, ''), node.path]),
  );
}

async function main() {
  await mkdir(iconDir, { recursive: true });
  const items = (await readFile(join(root, 'data', 'recipes.core.jsonl'), 'utf8'))
    .split(/\r?\n/).filter(Boolean).slice(1).map((line) => JSON.parse(line));
  const pack = await packTextures();

  const map = {};
  let packed = 0;
  let vanilla = 0;
  const failed = [];

  for (const item of items) {
    const isSlimefun = item.id.includes(':') && !item.id.startsWith('minecraft:');
    const short = item.id.split(':').pop().toLowerCase();
    const file = fileNameFor(item.id);
    const target = join(iconDir, file);
    const rel = `data/icons/${file}`;

    // 已经有缓存就跳过（支持增量重跑）
    try {
      const info = await stat(target);
      if (info.size > 0) {
        map[item.id] = rel;
        continue;
      }
    } catch { /* 不存在，继续下载 */ }

    let bytes = null;
    if (isSlimefun && pack.has(short)) {
      bytes = await fetchBytes(`https://cdn.jsdelivr.net/gh/${PACK}@${PACK_BRANCH}/${pack.get(short)}`);
      if (bytes) packed += 1;
    } else if (!isSlimefun && withVanilla && /^[a-z0-9_]+$/.test(short)) {
      bytes = await fetchBytes(`${MCMETA}/item/${short}.png`) || await fetchBytes(`${MCMETA}/block/${short}.png`);
      if (bytes) vanilla += 1;
    }

    if (!bytes) {
      if (isSlimefun && !pack.has(short)) failed.push(item.id);
      continue;
    }
    await writeFile(target, bytes);
    map[item.id] = rel;
  }

  await writeFile(join(iconDir, 'icon-cache.json'), `${JSON.stringify(map, null, 2)}\n`, 'utf8');
  const files = await readdir(iconDir);
  const total = files.filter((name) => name.endsWith('.png')).length;
  console.log(`已写入 data/icons/：${total} 张图标（本次新增 粘液 ${packed} / 原版 ${vanilla}）`);
  console.log(`缓存索引 data/icons/icon-cache.json：${Object.keys(map).length} 条`);
  console.log(`资源包未覆盖的物品 ${failed.length} 个（会显示徽章，或原版贴图兜底）`);
  if (!withVanilla) {
    console.log('提示：原版物品仍走在线镜像 mcmeta；想连原版也缓存到本地，加 --with-vanilla。');
  }
}

main().catch((err) => {
  console.error(err.message);
  console.error('提示：证书报错时请加 --use-system-ca。');
  process.exit(1);
});
