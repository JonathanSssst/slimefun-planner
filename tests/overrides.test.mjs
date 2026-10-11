import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { loadDatasetFromTexts } from '../engine/data.js';
import { plan } from '../engine/planner.js';

const here = dirname(fileURLToPath(import.meta.url));
const coreText = readFileSync(join(here, '../data/recipes.core.jsonl'), 'utf8');

test('补录能覆盖已有配方', () => {
  const plain = loadDatasetFromTexts([{ name: 'core', text: coreText }]);
  const before = plan(plain, { targets: [{ id: 'simefun4:CARBON', count: 8 }], baseMaterials: [] });
  const beforeMachine = before.routes.find((route) => route.id === 'simefun4:CARBON')?.machine;

  const overridden = loadDatasetFromTexts([{ name: 'core', text: coreText }], {
    overrides: [{
      id: 'simefun4:CARBON',
      name: '碳',
      recipeType: '增强型工作台',
      output: 1,
      materials: { COAL: 2 },
    }],
  });
  const after = plan(overridden, { targets: [{ id: 'simefun4:CARBON', count: 8 }], baseMaterials: [] });
  const carbon = after.routes.find((route) => route.id === 'simefun4:CARBON');
  assert.equal(carbon.machine, '增强型工作台');
  assert.notEqual(carbon.machine, beforeMachine);
  assert.equal(carbon.materials[0].id, 'COAL');
  assert.equal(carbon.materials[0].perCraft, 2);
  assert.equal(after.raw.find((item) => item.id === 'COAL').count, 16);
});

test('补录能新增数据里没有的物品', () => {
  const dataset = loadDatasetFromTexts([{ name: 'core', text: coreText }], {
    overrides: [{
      id: 'simefun4:MY_CUSTOM_ITEM',
      name: '我的自制物品',
      recipeType: '增强型工作台',
      output: 1,
      materials: { 'simefun4:STEEL_INGOT': 4 },
    }],
  });
  assert.ok(dataset.has('simefun4:MY_CUSTOM_ITEM'));
  const result = plan(dataset, {
    targets: [{ id: 'simefun4:MY_CUSTOM_ITEM', count: 2 }],
    baseMaterials: ['IRON_INGOT', 'COAL', 'IRON_ORE'],
  });
  const custom = result.routes.find((route) => route.id === 'simefun4:MY_CUSTOM_ITEM');
  assert.equal(custom.crafts, 2);
  assert.equal(custom.materials[0].total, 8);
  // 补录的物品能正常参与计算，且不该被报成"数据缺失"
  assert.ok(!result.missing.some((item) => item.id === 'simefun4:MY_CUSTOM_ITEM'),
    '补录后目标不应再报"无配方数据"');
  assert.equal(dataset.name('simefun4:MY_CUSTOM_ITEM'), '我的自制物品');
});

test('补录可以把物品设为采集终点', () => {
  const dataset = loadDatasetFromTexts([{ name: 'core', text: coreText }], {
    overrides: [{ id: 'simefun4:STEEL_INGOT', name: '钢锭', gather: true }],
  });
  const result = plan(dataset, { targets: [{ id: 'simefun4:STEEL_INGOT', count: 5 }], baseMaterials: [] });
  assert.equal(result.routes.length, 0, '设为采集终点后不应再有合成步骤');
  const item = result.raw.find((entry) => entry.id === 'simefun4:STEEL_INGOT');
  assert.equal(item.count, 5);
});

test('数据集自带的 549 条配方能全部装载', () => {
  const dataset = loadDatasetFromTexts([{ name: 'core', text: coreText }]);
  assert.equal(dataset.size, 549);
  assert.ok(dataset.has('simefun4:SYNTHETIC_DIAMOND'));
  assert.ok(dataset.name('simefun4:SYNTHETIC_DIAMOND').includes('人造钻石'));
});
