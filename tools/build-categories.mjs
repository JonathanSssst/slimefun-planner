#!/usr/bin/env node
/**
 * 生成指南书式分类目录 data/categories.json。
 *
 * 优先级：
 *   1. 中文 Wiki 分类页/子分类页抓到的物品（最权威，见 research/wiki-categories.json）
 *   2. 规则推断（按物品 ID 关键词、配方类型），保证 549 个物品都能落到某个分类里
 * 每个物品会标注来源（wiki / inferred），界面可以据此提示。
 *
 * 用法：node tools/build-categories.mjs
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const root = resolve(join(dirname(fileURLToPath(import.meta.url)), '..'));

/** 分类顺序与图标（顺序参考游戏内指南书） */
const GROUPS = [
  { key: 'weapons', name: '武器', icon: '⚔' },
  { key: 'items', name: '有用的物品', icon: '🎒' },
  { key: 'basic', name: '基础机器', icon: '🧰' },
  { key: 'tools', name: '工具', icon: '⛏' },
  { key: 'resources', name: '资源', icon: '🪨', withSubgroups: true },
  { key: 'food', name: '食物', icon: '🍖' },
  { key: 'magic-items', name: '魔法物品', icon: '✨' },
  { key: 'magic-armor', name: '魔法防具', icon: '🥼' },
  { key: 'components', name: '科技零件', icon: '🔩' },
  { key: 'misc', name: '杂项用品', icon: '📦' },
  { key: 'armor', name: '防具', icon: '🛡' },
  { key: 'talismans', name: '护身符', icon: '🔮' },
  { key: 'gadgets', name: '魔法道具', icon: '🪄' },
  { key: 'tech-tools', name: '科技工具', icon: '🔧' },
  { key: 'energy', name: '能源与电力', icon: '⚡' },
  { key: 'gps', name: 'GPS', icon: '🛰' },
  { key: 'androids', name: '可编程式机器人', icon: '🤖' },
  { key: 'cargo', name: '货运管理', icon: '🚚' },
  { key: 'seasonal', name: '节日物品', icon: '🎄' },
  { key: 'other', name: '其它 / 未分类', icon: '❔' },
];

/** wiki 顶级分类名 → 我们的分组 key */
const WIKI_TO_GROUP = {
  武器: 'weapons',
  有用的物品: 'items',
  基础机器: 'basic',
  工具: 'tools',
  资源: 'resources',
  食物: 'food',
  魔法物品: 'magic-items',
  魔法防具: 'magic-armor',
  科技零件: 'components',
  杂项用品: 'misc',
  防具: 'armor',
  护身符: 'talismans',
  魔法道具: 'gadgets',
  科技工具: 'tech-tools',
  能源与电力: 'energy',
  GPS: 'gps',
  可编程式机器人: 'androids',
  货运管理: 'cargo',
  节日物品: 'seasonal',
};

/** wiki 子分类名 → 分组 key（资源类下面的细分） */
const WIKI_SUB_TO_GROUP = {
  矿粉: 'resources',
  锭: 'resources',
  人造蓝宝石: 'resources',
  人造绿宝石: 'resources',
  人造钻石: 'resources',
  黑金刚石: 'resources',
  碳: 'resources',
  镁盐: 'resources',
  硫酸盐: 'resources',
  硅: 'resources',
  铀: 'resources',
  镎: 'resources',
  钚: 'resources',
  下界冰: 'resources',
};

/** 规则推断：按 ID 关键词判断分类 */
const RULES = [
  [/(CHRISTMAS|EASTER|HALLOWEEN|VALENTINE|BIRTHDAY|XMAS)/, 'seasonal'],
  [/TALISMAN/, 'talismans'],
  [/(HELMET|CHESTPLATE|LEGGINGS|BOOTS)$/, 'armor'],
  [/(HELMET|CHESTPLATE|LEGGINGS|BOOTS)_(?!$)/, 'armor'],
  [/ANDROID/, 'androids'],
  [/(CARGO_|_NODE|_MOTOR)/, 'cargo'],
  [/(GPS_|GEO_|PORTABLE_GEO)/, 'gps'],
  [/(REACTOR|GENERATOR|CAPACITOR|SOLAR|COAL_GENERATOR|ENERGY_|_PANEL)/, 'energy'],
  [/(MULTI_TOOL|_TOOL|_PICK|_AXE|_SHOVEL|_HOE|_SHEARS|_CROWBAR)/, 'tools'],
  [/(DUST|INGOT|_ORE|CARBON|SILICON|URANIUM|PLUTONIUM|NEPTUNIUM|SALT|SULFATE|BUCKET_OF_OIL|FUEL)/, 'resources'],
  [/(GOLD_\d+K|GOLD_\d+_|_BLOCK|STONE|CLOTH|CAN\b|CHAIN|HOOK|SKULL|SHULKER|SLIME|WING|FLOUR|CRYSTAL)/, 'resources'],
  [/(CIRCUIT_BOARD|_CAPACITOR|_MOTOR|COIL|WIRE|_PLATE|ALLOY|MAGNET|_CHIP|_CORE|MULTIMETER|TAPE_MEASURE)/, 'components'],
  [/(PICKAXE|SWORD|BOW|_AXE|SHOVEL|_HOE|TRIDENT|_STAFF)/, 'weapons'],
  [/(JETPACK|JETBOOTS|PARACHUTE|ELYTRA|_BOOTS_OF|GRAPPLE|CLIMBING|NIGHT_VISION|GOGGLES|SHOES|TELEPORTER)/, 'tech-tools'],
  [/(AUTO_CRAFTER|AUTO_ENCHANTER|AUTO_DISENCHANTER|AUTO_ANVIL|AUTO_BREWER|AUTOMATED|_MACHINE|MACHINE_)/, 'basic'],
  [/(CRUSHER|COMPRESSOR|FURNACE|SMELTER|PRESSURE|MIXER|WASHER|GRIND|TABLE_SAW|SAW|PRESS|CRUCIBLE|COMPOSTER|FABRICATOR|BREEDER|ACCELERATOR|COLLECTOR|FREEZER|GOLD_PAN|PUMP|REFINERY|CHAMBER)/, 'basic'],
  [/(COOKIE|JERKY|JUICE|SOUP|STEW|CAKE|CARAMEL|CHOCOLATE|BREAD|APPLE|PIE|SMOOTHIE|MILK|TEA|COFFEE|CHEESE|BUTTER|CREAM|EGGNOG|ORGANIC_FOOD|ORGANIC_FERTILIZER|FERTILIZER)/, 'food'],
  [/(RUNE|MAGIC|_WAND|SCROLL|FLASK|BOOK|ESSENCE|LUMP|ENDER_|MAGICAL)/, 'magic-items'],
  [/(BACKPACK|_BAG|_CAN\b|TIN_CAN)/, 'items'],
  [/(_GUIDE|_BOOK|_MANUAL)/, 'misc'],
];

function ruleGroup(id) {
  const short = id.split(':').pop();
  for (const [re, group] of RULES) if (re.test(short)) return group;
  return null;
}

/** 名字归一化：去掉空格与括号里的补充说明（"金锭 (24克拉)" → "金锭"） */
function normalize(name) {
  return String(name || '').replace(/\s+/g, '').replace(/[（(][^）)]*[）)]/g, '');
}

async function main() {
  const items = (await readFile(join(root, 'data', 'recipes.core.jsonl'), 'utf8'))
    .split(/\r?\n/).filter(Boolean).slice(1).map((line) => JSON.parse(line));

  // 名字可能重复（例如 9 种「有机食物」），所以一个名字对应一组物品，逐个消费
  const byName = new Map();
  for (const item of items) {
    const key = normalize(item.name);
    if (!byName.has(key)) byName.set(key, []);
    byName.get(key).push(item.id);
  }
  const takeByName = (name) => {
    const list = byName.get(normalize(name));
    if (!list || list.length === 0) return null;
    return list.shift();
  };

  const wikiPath = join(root, 'research', 'wiki-categories.json');
  const wiki = existsSync(wikiPath) ? JSON.parse(await readFile(wikiPath, 'utf8')) : { categories: {}, subcategories: {} };

  /** 物品 → { group, subgroup, source } */
  const assigned = new Map();
  let wikiHits = 0;

  // 1) 子分类优先（更细，例如矿粉/锭）
  for (const [subName, list] of Object.entries(wiki.subcategories || {})) {
    const group = WIKI_SUB_TO_GROUP[subName];
    if (!group) continue;
    for (const entry of list) {
      const id = takeByName(entry.name);
      if (!id) continue;
      if (!assigned.has(id)) {
        assigned.set(id, { group, subgroup: subName, source: 'wiki' });
        wikiHits += 1;
      }
    }
  }

  // 2) 顶级分类
  for (const [catName, list] of Object.entries(wiki.categories || {})) {
    const group = WIKI_TO_GROUP[catName];
    if (!group) continue;
    for (const entry of list) {
      const id = takeByName(entry.name);
      if (!id) continue;
      if (!assigned.has(id)) {
        assigned.set(id, { group, subgroup: null, source: 'wiki' });
        wikiHits += 1;
      }
    }
  }

  // 3) 规则推断兜底：先按配方类型/ID 关键词定大类，再按名字补子分类
  let inferred = 0;
  for (const item of items) {
    if (assigned.has(item.id)) continue;
    const group = ruleGroup(item.id) || 'other';
    let subgroup = null;
    if (group === 'resources') {
      const name = String(item.name || '');
      if (/锭|块/.test(name)) subgroup = '锭';
      else if (/粉/.test(name)) subgroup = '矿粉';
      else if (/碳/.test(name)) subgroup = '碳';
    }
    assigned.set(item.id, { group, subgroup, source: 'inferred' });
    inferred += 1;
  }

  // 汇总成 groups
  const groups = GROUPS.map((group) => ({ key: group.key, name: group.name, icon: group.icon, items: [], subgroups: [] }));
  const byKey = new Map(groups.map((group) => [group.key, group]));

  const subgroupMap = new Map(); // groupKey -> Map(subName -> items[])
  for (const item of items) {
    const entry = assigned.get(item.id);
    if (!entry) continue;
    const group = byKey.get(entry.group) || byKey.get('other');
    if (entry.subgroup) {
      if (!subgroupMap.has(group.key)) subgroupMap.set(group.key, new Map());
      const subs = subgroupMap.get(group.key);
      if (!subs.has(entry.subgroup)) subs.set(entry.subgroup, []);
      subs.get(entry.subgroup).push(item.id);
    } else {
      group.items.push(item.id);
    }
  }

  for (const group of groups) {
    const subs = subgroupMap.get(group.key);
    if (!subs) continue;
    for (const [name, list] of subs) {
      group.subgroups.push({ name, items: list });
    }
    group.subgroups.sort((a, b) => b.items.length - a.items.length);
  }

  const total = groups.reduce((sum, group) => sum + group.items.length + group.subgroups.reduce((s, sub) => s + sub.items.length, 0), 0);
  const output = {
    _说明: '指南书式分类目录。source=wiki 表示来自中文 Wiki 分类页，source=inferred 表示按 ID 关键词规则推断。',
    生成时间: new Date().toISOString().slice(0, 10),
    统计: { 物品总数: total, wiki匹配: wikiHits, 规则推断: inferred },
    groups: groups.filter((group) => group.items.length + group.subgroups.length > 0)
      .map((group) => ({ name: group.name, key: group.key, icon: group.icon, items: group.items, subgroups: group.subgroups })),
  };

  await mkdir(join(root, 'data'), { recursive: true });
  await writeFile(join(root, 'data', 'categories.json'), `${JSON.stringify(output, null, 2)}\n`, 'utf8');

  console.log(`物品总数 ${total}：wiki 匹配 ${wikiHits}，规则推断 ${inferred}`);
  console.log('各分类数量：');
  for (const group of output.groups) {
    const count = group.items.length + group.subgroups.reduce((sum, sub) => sum + sub.items.length, 0);
    const subs = group.subgroups.length ? `（子分类 ${group.subgroups.map((sub) => `${sub.name} ${sub.items.length}`).join('、')}）` : '';
    console.log(`  ${group.name.padEnd(10, '　')} ${String(count).padStart(3)} ${subs}`);
  }
  console.log('\n已写出 data/categories.json');
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
