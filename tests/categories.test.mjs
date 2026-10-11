import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const categoriesPath = join(here, '../data/categories.json');
const corePath = join(here, '../data/recipes.core.jsonl');

function load() {
  return JSON.parse(readFileSync(categoriesPath, 'utf8'));
}

function allIds(categories) {
  const ids = [];
  for (const group of categories.groups) {
    ids.push(...(group.items || []));
    for (const sub of group.subgroups || []) ids.push(...(sub.items || []));
  }
  return ids;
}

test('分类目录：覆盖全部物品且不重复', () => {
  const categories = load();
  const items = readFileSync(corePath, 'utf8')
    .split(/\r?\n/).filter(Boolean).slice(1).map((line) => JSON.parse(line).id);

  const ids = allIds(categories);
  const dupes = ids.filter((id, index) => ids.indexOf(id) !== index);
  assert.equal(dupes.length, 0, `有重复归类：${dupes.slice(0, 5).join(', ')}`);
  assert.equal(new Set(ids).size, items.length, `覆盖数量不符：${new Set(ids).size} vs ${items.length}`);

  const missing = items.filter((id) => !ids.includes(id));
  assert.equal(missing.length, 0, `未归类：${missing.slice(0, 10).join(', ')}`);
});

test('分类目录：分类名与关键分组齐全', () => {
  const categories = load();
  const names = categories.groups.map((group) => group.name);
  for (const expected of ['武器', '基础机器', '矿物资源', '能源与电力', '魔法物品（含护身符）', '可编程式机器人', '货物管理']) {
    assert.ok(names.includes(expected), `缺少分类：${expected}（现有：${names.join('、')}）`);
  }
  // 季节类是分开的，不应合并成一个
  for (const expected of ['圣诞节 (12 月)', '情人节 (2 月 14 日)', '复活节 (4 月)', '万圣节 (10 月 31 日)']) {
    assert.ok(names.includes(expected), `缺少季节分类：${expected}`);
  }
  assert.ok(!names.includes('其它 / 未分类') || categories.groups.find((g) => g.name.includes('其它')).items.length <= 5,
    '未分类物品不应过多');
});

test('分类目录：护身符合并在魔法物品下（与游戏内指南书一致）', () => {
  const categories = load();
  const names = categories.groups.map((group) => group.name);
  assert.ok(!names.some((name) => name.startsWith('护身符')), '不应把护身符拆成独立分类');
  const magic = categories.groups.find((group) => group.name.startsWith('魔法物品'));
  assert.ok(magic, '应有魔法物品分类');
  const talismans = magic.items.filter((id) => id.includes('TALISMAN'));
  assert.ok(talismans.length >= 30, `魔法物品里应包含护身符，实际只有 ${talismans.length} 个`);
  assert.equal(magic.items.filter((id) => id.includes('ENDER_') && id.includes('TALISMAN')).length, 16, '应有 16 个末影护身符');
});

test('分类目录：标注了来源统计', () => {
  const categories = load();
  const stats = categories.统计 || {};
  assert.ok(typeof stats.物品总数 === 'number' && stats.物品总数 > 500, '应有物品总数统计');
  assert.ok(typeof stats.源码导出 === 'number', '应有源码导出条数');
  assert.ok(!('生成时间' in categories) || /^\d{4}-\d{2}-\d{2}$/.test(categories.生成时间), '生成时间格式应为 YYYY-MM-DD');
});

test('若存在插件源码导出文件，覆盖率应很高', () => {
  const exportPath = join(here, '../research/item-category-map.json');
  if (!existsSync(exportPath)) return; // 没跑过导出就跳过
  const exported = JSON.parse(readFileSync(exportPath, 'utf8'));
  const list = Array.isArray(exported) ? exported : (exported.items || []);
  assert.ok(list.length > 500, `导出条目过少：${list.length}`);
  assert.ok(list.every((entry) => (entry.item || entry.id) && (entry.category || entry.group)), '每条都应有物品与分类');
});
