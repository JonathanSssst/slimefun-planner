#!/usr/bin/env node
/**
 * 重新生成粘液科技物品的图标映射表（data/icon-map.json）。
 *
 * 原理：Slimefun 官方资源包仓库里贴图按物品 ID 命名
 *   assets/slimefun/textures/item/<物品ID小写>.png
 * 所以可以按名字映射，不需要任何接口。脚本会核对文件确实存在，只写有效的映射。
 *
 * 用法：
 *   node --use-system-ca tools/build-icon-map.mjs
 *
 * 说明：仓库里不打包任何游戏素材，只保存"物品 ID → 公开镜像地址"的映射。
 */

import { writeFile, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const root = resolve(join(dirname(fileURLToPath(import.meta.url)), '..'));
const REPO = 'Slimefun/Resourcepack';
const BRANCH = 'master';
const CDN = `https://cdn.jsdelivr.net/gh/${REPO}@${BRANCH}/assets/slimefun/textures/`;
const TEXTURE_PREFIX = 'assets/slimefun/textures/';

async function fetchTree() {
  const response = await fetch(`https://api.github.com/repos/${REPO}/git/trees/HEAD?recursive=1`, {
    headers: { 'User-Agent': 'slimefun-planner-icon-map' },
  });
  if (!response.ok) throw new Error(`拉取资源包文件树失败：HTTP ${response.status}`);
  const json = await response.json();
  return json.tree.filter((node) => node.type === 'blob' && node.path.endsWith('.png')).map((node) => node.path);
}

async function main() {
  const files = new Set(await fetchTree());
  const lines = (await readFile(join(root, 'data', 'recipes.core.jsonl'), 'utf8'))
    .split(/\r?\n/)
    .filter(Boolean)
    .slice(1);

  const map = {};
  const missing = [];
  for (const line of lines) {
    const item = JSON.parse(line);
    const short = item.id.split(':').pop().toLowerCase();
    const path = `${TEXTURE_PREFIX}item/${short}.png`;
    if (files.has(path)) map[item.id] = CDN + path.slice(TEXTURE_PREFIX.length);
    else missing.push(item.id);
  }

  await writeFile(join(root, 'data', 'icon-map.json'), `${JSON.stringify(map, null, 2)}\n`, 'utf8');
  console.log(`已写入 data/icon-map.json：${Object.keys(map).length} 条映射`);
  console.log(`未覆盖 ${missing.length} 个物品（会显示首字母徽章）`);
  console.log(`示例：${Object.entries(map).slice(0, 3).map(([k, v]) => `${k} → ${v}`).join('  ')}`);
}

main().catch((err) => {
  console.error(err.message);
  console.error('提示：如果报证书错误，请加 --use-system-ca 再运行。');
  process.exit(1);
});
