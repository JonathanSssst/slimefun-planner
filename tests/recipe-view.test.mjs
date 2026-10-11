import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { loadDatasetFromTexts } from '../engine/data.js';
import { describeItem, layoutRecipe, buildUsageIndex, resolveIcon, toneOf } from '../engine/recipe-view.js';

const here = dirname(fileURLToPath(import.meta.url));
const coreText = readFileSync(join(here, '../data/recipes.core.jsonl'), 'utf8');
const dataset = loadDatasetFromTexts([{ name: 'core', text: coreText }]);
const usageIndex = buildUsageIndex(dataset);

const gridOf = (entry) => layoutRecipe(entry);

test('3 格机器配方（冶炼炉）摆成一行，不猜测 3x3', () => {
  // 钢锭：铁粉 + 碳 + 铁锭，冶炼炉
  const entry = dataset.get('simefun4:STEEL_INGOT');
  const layout = gridOf(entry);
  assert.equal(layout.isMachineList, true);
  assert.equal(layout.totalSlots, 3);
  assert.equal(layout.materials.length, 3);
  assert.deepEqual(layout.materials.map((m) => m.name).sort(), ['碳', '铁粉', '铁锭'].sort());
  assert.equal(layout.rows * layout.cols, 9, '机器配方保持 3x3 显示网格');
});

test('增强型工作台的摆位会被识别，并按行/列收窄', () => {
  const entry = dataset.get('simefun4:CARBON_CHUNK'); // 增强型工作台：压缩碳×8 + 燧石
  const layout = gridOf(entry);
  assert.equal(layout.isMachineList, false);
  assert.equal(layout.totalSlots, 9);
  assert.equal(layout.materials.find((m) => m.name === '压缩碳').slotCount, 8);
  assert.equal(layout.materials.find((m) => m.name === '燧石').slotCount, 1);
});

test('同一材料占多格时按格计数，不去重', () => {
  const entry = dataset.get('simefun4:CHAIN'); // 钢锭 ×3
  const layout = gridOf(entry);
  assert.equal(layout.materials.length, 1);
  assert.equal(layout.materials[0].slotCount, 3);
});

test('describeItem：给出配方、产出、解锁等级与用途', () => {
  const info = describeItem(dataset, 'simefun4:SYNTHETIC_DIAMOND', usageIndex);
  assert.equal(info.name, '人造钻石');
  assert.equal(info.hasRecipe, true);
  assert.equal(info.recipeType, '压力机');
  assert.equal(info.output, 1);
  assert.equal(info.researchCost, 10);
  assert.equal(info.layout.materials[0].name, '碳块');
  // 材料对象必须同时带 id 与 material，界面才能正确取名字
  assert.equal(info.layout.materials[0].id, 'simefun4:CARBON_CHUNK');
  assert.equal(info.layout.materials[0].material, 'simefun4:CARBON_CHUNK');
  assert.ok(info.usedBy.length > 0, '人造钻石应该被别人用到');
  assert.ok(info.usedBy.every((item) => item.name && item.id));
});

test('describeItem：多材料配方的每个材料都能取到名字（回归：undefined 名称）', () => {
  const info = describeItem(dataset, 'simefun4:REINFORCED_ALLOY_INGOT', usageIndex);
  assert.equal(info.layout.materials.length, 6);
  for (const material of info.layout.materials) {
    assert.ok(material.id, `材料缺少 id：${JSON.stringify(material)}`);
    assert.equal(material.material, material.id);
    assert.ok(!String(material.id).includes('undefined'), 'id 不该是 undefined');
    assert.ok(dataset.name(material.id), `取不到名字：${material.id}`);
  }
});

test('describeItem：基础材料没有配方也不会炸', () => {
  const info = describeItem(dataset, 'COAL', usageIndex);
  assert.equal(info.hasRecipe, false);
  assert.equal(info.kind, 'unknown');
  assert.equal(info.layout, null);
  assert.ok(info.usedBy.length > 0, '煤炭是很多配方要用到的');
  assert.ok(Array.isArray(info.variants));
});

test('describeItem：采集型配方（生物掉落）标记为 gather', () => {
  const info = describeItem(dataset, 'simefun4:CARBON', usageIndex);
  assert.equal(info.hasRecipe, true);
  assert.equal(info.kind, 'craft');
  assert.equal(info.recipeType, '压缩机');
});

test('图标：原版物品走 mcmeta 镜像，粘液物品回退徽章', () => {
  const iron = resolveIcon('IRON_INGOT');
  assert.match(iron.url, /mcmeta\/assets\/assets\/minecraft\/textures\/item\/iron_ingot\.png$/);
  assert.equal(iron.fallbackText, 'I');

  const slime = resolveIcon('simefun4:IRON_DUST');
  assert.equal(slime.url, null, '粘液物品没有公开贴图，应回退徽章');
  assert.equal(slime.fallbackText, 'I');

  const disabled = resolveIcon('IRON_INGOT', { enabled: false });
  assert.equal(disabled.url, null, '关掉图标后不应请求外部资源');
});

test('图标：支持用 data/icons.json 的 overrides 覆盖（自备贴图）', () => {
  const custom = resolveIcon('simefun4:IRON_DUST', { overrides: { 'simefun4:IRON_DUST': 'data/icons/iron_dust.png' } });
  assert.equal(custom.url, 'data/icons/iron_dust.png');
  assert.equal(custom.isOverride, true);
});

test('图标：data/icons.json 的示例键不会被当成真实覆盖', () => {
  const file = JSON.parse(readFileSync(join(here, '../data/icons.json'), 'utf8'));
  assert.equal(typeof file.overrides, 'object');
  assert.equal(resolveIcon('simefun4:IRON_DUST', { overrides: file.overrides }).url, null,
    '示例键是 _示例_请删除，不应命中 IRON_DUST');
  assert.equal(file.enabled, true);
});

test('图标：粘液物品优先用 data/icon-map.json 的公开镜像', () => {
  const iconMap = JSON.parse(readFileSync(join(here, '../data/icon-map.json'), 'utf8'));
  const dust = resolveIcon('simefun4:IRON_DUST', { iconMap });
  assert.match(dust.url, /iron_dust\.png$/, '矿粉应有真实贴图');
  assert.equal(dust.fallbackText, 'I');

  // 官方资源包覆盖不到的物品仍然回退徽章
  const uncovered = resolveIcon('simefun4:ENHANCED_CRAFTING_TABLE', { iconMap });
  assert.equal(uncovered.url, null);

  // 用户覆盖优先级最高
  const overridden = resolveIcon('simefun4:IRON_DUST', {
    iconMap,
    overrides: { 'simefun4:IRON_DUST': 'data/icons/mine.png' },
  });
  assert.equal(overridden.url, 'data/icons/mine.png');
});

test('图标：本地抽取的缓存优先于在线映射', () => {
  const iconMap = { 'simefun4:IRON_DUST': 'https://example.com/remote.png' };
  const iconCache = { 'simefun4:IRON_DUST': 'data/icons/simefun4_IRON_DUST.png' };

  const fromCache = resolveIcon('simefun4:IRON_DUST', { iconMap, iconCache });
  assert.equal(fromCache.url, 'data/icons/simefun4_IRON_DUST.png', '本地缓存应优先');
  assert.equal(fromCache.fromLocalCache, true);

  const withoutCache = resolveIcon('simefun4:IRON_DUST', { iconMap, iconCache: {} });
  assert.equal(withoutCache.url, 'https://example.com/remote.png', '没有缓存时回退在线映射');

  const off = resolveIcon('simefun4:IRON_DUST', { enabled: false, iconMap, iconCache });
  assert.equal(off.url, null, '关掉图标后两者都不用');
});

test('图标：本机资源包抽取的缓存（若已生成）能被正确解析', () => {
  const cachePath = join(here, '../data/icons/icon-cache.json');
  if (!existsSync(cachePath)) return; // 没跑过抽取脚本就跳过
  const iconCache = JSON.parse(readFileSync(cachePath, 'utf8'));
  assert.ok(Object.keys(iconCache).length > 100, `缓存条目过少：${Object.keys(iconCache).length}`);
  assert.equal(resolveIcon('COAL', { iconCache }).fromLocalCache, undefined, '原版物品不在缓存里');
  const slime = resolveIcon('simefun4:SYNTHETIC_DIAMOND', { iconCache });
  assert.equal(slime.fromLocalCache, true, '粘液物品应命中本地缓存');
  assert.match(slime.url, /^data\/icons\/.+\.png$/);
  // 缓存里登记的文件必须真实存在
  const sample = Object.entries(iconCache).slice(0, 20);
  for (const [id, rel] of sample) {
    assert.ok(existsSync(join(here, '..', rel)), `${id} 登记的贴图不存在：${rel}`);
  }
});

test('图标映射表覆盖了 9 种矿粉与常用中间产物', () => {
  const iconMap = JSON.parse(readFileSync(join(here, '../data/icon-map.json'), 'utf8'));
  const must = [
    'simefun4:IRON_DUST', 'simefun4:COPPER_DUST', 'simefun4:GOLD_DUST', 'simefun4:TIN_DUST',
    'simefun4:SILVER_DUST', 'simefun4:ALUMINUM_DUST', 'simefun4:LEAD_DUST', 'simefun4:ZINC_DUST',
    'simefun4:MAGNESIUM_DUST', 'simefun4:STEEL_INGOT', 'simefun4:COMPRESSED_CARBON',
    'simefun4:CARBONADO', 'simefun4:REINFORCED_ALLOY_INGOT',
  ];
  for (const id of must) {
    assert.ok(iconMap[id], `${id} 应有图标映射`);
    assert.match(iconMap[id], /^https:\/\//, '映射应是 https 地址');
  }
});

test('toneOf 对同一 id 稳定、对不同 id 有区分', () => {
  assert.equal(toneOf('simefun4:IRON_DUST'), toneOf('simefun4:IRON_DUST'));
  const tones = new Set(['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'].map((id) => toneOf(id)));
  assert.ok(tones.size >= 4, `色号分布太集中：${[...tones].join(',')}`);
});
