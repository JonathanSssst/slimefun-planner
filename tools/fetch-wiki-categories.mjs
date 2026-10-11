#!/usr/bin/env node
/**
 * 抓取粘液科技中文 Wiki 的分类页面，导出"分类 → 物品名"清单。
 *
 * 中文 Wiki（Docusaurus）每个分类页的 HTML 里就有该分类的物品链接列表，
 * 这比猜分类可靠得多。抓下来的结果用于和数据集物品名做匹配。
 *
 * 用法：node --use-system-ca tools/fetch-wiki-categories.mjs
 * 输出：research/wiki-categories.json （research/ 已在 .gitignore 中）
 */

import { writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const root = resolve(join(dirname(fileURLToPath(import.meta.url)), '..'));
const BASE = 'https://slimefun-wiki.guizhanss.cn';

/** 顶层分类页（对应 wiki 侧栏） */
const CATEGORY_PAGES = [
  ['武器', 'Weapons'],
  ['有用的物品', 'Items'],
  ['基础机器', 'Basic-Machines'],
  ['工具', 'Tools'],
  ['资源', 'Resources'],
  ['食物', 'Food'],
  ['魔法物品', 'Magical-Items'],
  ['魔法防具', 'Magical-Armor'],
  ['科技零件', 'Technical-Components'],
  ['杂项用品', 'Miscellaneous-Items'],
  ['防具', 'Armor'],
  ['护身符', 'Talismans'],
  ['魔法道具', 'Magical-Gadgets'],
  ['科技工具', 'Technical-Gadgets'],
  ['能源与电力', 'Electric-Machines'],
  ['GPS', 'GPS'],
  ['可编程式机器人', 'Androids'],
  ['货运管理', 'Cargo-Management'],
  ['节日物品', 'Seasonal-Categories'],
];

/** 常见子分类页（资源页下面的那些） */
const SUBCATEGORY_PAGES = [
  ['矿粉', 'Dusts'],
  ['锭', 'Ingots'],
  ['人造蓝宝石', 'Synthetic-Sapphire'],
  ['人造绿宝石', 'Synthetic-Emerald'],
  ['人造钻石', 'Synthetic-Diamond'],
  ['黑金刚石', 'Carbonado'],
  ['碳', 'Carbon'],
  ['镁盐', 'Magnesium-Salt'],
  ['硫酸盐', 'Sulfate'],
  ['硅', 'Silicon'],
  ['原油桶', 'Bucket-of-Oil'],
  ['燃料桶', 'Bucket-of-Fuel'],
  ['铀', 'Uranium'],
  ['镎', 'Neptunium'],
  ['钚', 'Plutonium'],
  ['下界冰', 'Nether-Ice'],
];

async function fetchText(path) {
  const response = await fetch(`${BASE}/${path}/`, { headers: { 'User-Agent': 'slimefun-planner-wiki' } });
  if (!response.ok) throw new Error(`${path} → HTTP ${response.status}`);
  return response.text();
}

/** 从 Docusaurus 页面里抽出物品链接（形如 /Iron-Dust 这种站内链接） */
function extractLinks(html) {
  const links = new Set();
  const re = /href="\/([A-Za-z0-9][A-Za-z0-9-]*)\/?"/g;
  let match;
  while ((match = re.exec(html)) !== null) links.add(match[1]);
  return [...links];
}

/** 抓页面 <main> 里出现的物品名（中文），用于和数据集名字比对 */
function extractTitles(html) {
  const titles = new Set();
  const re = /<a[^>]+href="\/([A-Za-z0-9][A-Za-z0-9-]*)\/?"[^>]*>([^<]{1,60})<\/a>/g;
  let match;
  while ((match = re.exec(html)) !== null) {
    const text = match[2].replace(/\s+/g, ' ').trim();
    if (text && !/[<>]/.test(text)) titles.add(`${match[1]}\t${text}`);
  }
  return [...titles];
}

async function main() {
  const result = { categories: {}, subcategories: {}, pages: [] };

  for (const [name, slug] of CATEGORY_PAGES) {
    try {
      const html = await fetchText(slug);
      const entries = extractTitles(html);
      result.categories[name] = entries.map((entry) => {
        const [page, text] = entry.split('\t');
        return { page, name: text };
      });
      result.pages.push({ name, slug, count: entries.length });
      console.log(`✔ ${name}（${slug}）：${entries.length} 条链接`);
    } catch (err) {
      console.log(`✖ ${name}（${slug}）：${err.message}`);
    }
  }

  for (const [name, slug] of SUBCATEGORY_PAGES) {
    try {
      const html = await fetchText(slug);
      const entries = extractTitles(html);
      result.subcategories[name] = entries.map((entry) => {
        const [page, text] = entry.split('\t');
        return { page, name: text };
      });
      console.log(`✔ 子分类 ${name}（${slug}）：${entries.length} 条`);
    } catch (err) {
      console.log(`✖ 子分类 ${name}（${slug}）：${err.message}`);
    }
  }

  await mkdir(join(root, 'research'), { recursive: true });
  await writeFile(join(root, 'research', 'wiki-categories.json'), `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  console.log('\n已写出 research/wiki-categories.json');
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
