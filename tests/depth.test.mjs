import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { loadDatasetFromTexts } from '../engine/data.js';
import { plan } from '../engine/planner.js';
import { normalizeDepth } from '../engine/solver.js';

const here = dirname(fileURLToPath(import.meta.url));
const coreText = readFileSync(join(here, '../data/recipes.core.jsonl'), 'utf8');

function dataset() {
  return loadDatasetFromTexts([{ name: 'core', text: coreText }]);
}

const names = (result) => result.raw.map((item) => item.name);

test('normalizeDepth：不传=无限，数字照原样，非法值回退为无限', () => {
  assert.equal(normalizeDepth(undefined), Infinity);
  assert.equal(normalizeDepth(null), Infinity);
  assert.equal(normalizeDepth(''), Infinity);
  assert.equal(normalizeDepth('all'), Infinity);
  assert.equal(normalizeDepth('abc'), Infinity);
  assert.equal(normalizeDepth(-3), Infinity);
  assert.equal(normalizeDepth(0), 0);
  assert.equal(normalizeDepth(1), 1);
  assert.equal(normalizeDepth('2'), 2);
  assert.equal(normalizeDepth(2.7), 2);
});

test('展开 1 层：采集清单停在直接投料的中间产物，不再往下打', () => {
  const result = plan(dataset(), {
    targets: [{ id: 'simefun4:CARBON_CHUNK', count: 8 }],
    baseMaterials: [],
    materialDepth: 1,
  });
  const list = names(result);
  assert.ok(list.includes('压缩碳'), `应停在压缩碳，实际：${list.join('、')}`);
  assert.ok(!list.includes('煤炭'), '不应继续展开到煤炭');
  assert.equal(result.raw.find((item) => item.name === '压缩碳').kind, 'cutoff', '中间产物应标为可自制');
  assert.equal(result.raw.find((item) => item.name === '压缩碳').count, 64);
  // 压缩碳不再出现在合成工序里
  assert.ok(!result.workOrder.some((step) => step.name === '压缩碳'), '截断的中间产物不应出现在工序表');
  assert.ok(result.workOrder.some((step) => step.name === '碳块'));
});

test('展开 2 层：比 1 层再深一层', () => {
  const result = plan(dataset(), {
    targets: [{ id: 'simefun4:CARBON_CHUNK', count: 8 }],
    baseMaterials: [],
    materialDepth: 2,
  });
  const list = names(result);
  assert.ok(list.includes('碳'), `应停在碳，实际：${list.join('、')}`);
  assert.ok(!list.includes('煤炭'));
  assert.ok(result.workOrder.some((step) => step.name === '压缩碳'));
  assert.ok(!result.workOrder.some((step) => step.name === '碳'));
});

test('不传展开层数 = 老行为，一路展开到生料', () => {
  const result = plan(dataset(), {
    targets: [{ id: 'simefun4:CARBON_CHUNK', count: 8 }],
    baseMaterials: [],
  });
  const list = names(result);
  assert.ok(list.includes('煤炭'), `应展开到煤炭，实际：${list.join('、')}`);
  assert.ok(!list.includes('压缩碳'));
  assert.ok(result.workOrder.some((step) => step.name === '碳'));
});

test('展开 1 层：合成类目标给出直接投料清单（强化合金锭）', () => {
  const result = plan(dataset(), {
    targets: [{ id: 'simefun4:REINFORCED_ALLOY_INGOT', count: 16 }],
    baseMaterials: [],
    materialDepth: 1,
  });
  const list = names(result);
  for (const expected of ['大马士革钢锭', '硬化金属', '科林斯青铜锭', '焊锡锭']) {
    assert.ok(list.includes(expected), `缺少直接投料 ${expected}：${list.join('、')}`);
  }
  // 第一层只应有 6 种直接投料，且都在同一层
  assert.equal(result.raw.length, 6, `实际：${list.join('、')}`);
  // 每种直接投料的数量应等于配方里该材料的总格数
  assert.equal(result.raw.find((item) => item.name === '大马士革钢锭').count, 16);
});

test('展开 0 层：目标本身不展开，直接作为待办列出', () => {
  const result = plan(dataset(), {
    targets: [{ id: 'simefun4:CARBON_CHUNK', count: 8 }],
    baseMaterials: [],
    materialDepth: 0,
  });
  assert.equal(result.workOrder.length, 0);
  assert.equal(result.raw.length, 1);
  assert.equal(result.raw[0].name, '碳块');
  assert.equal(result.raw[0].count, 8);
  assert.equal(result.raw[0].kind, 'cutoff');
});

test('展开层数不影响目标自身的数量计算', () => {
  for (const depth of [0, 1, 2, undefined]) {
    const result = plan(dataset(), {
      targets: [{ id: 'simefun4:CARBON_CHUNK', count: 8 }],
      baseMaterials: [],
      materialDepth: depth,
    });
    const total = result.raw.reduce((sum, item) => sum + item.count, 0);
    assert.ok(total > 0, `深度 ${depth} 应有材料需求`);
  }
});

test('树状图上截断层的节点显示为叶子，且带"去弄多少"', () => {
  const result = plan(dataset(), {
    targets: [{ id: 'simefun4:CARBON_CHUNK', count: 8 }],
    baseMaterials: [],
    materialDepth: 1,
  });
  const root = result.tree.roots[0];
  const compressed = root.children.find((child) => child.name === '压缩碳');
  assert.ok(compressed, '树上应有压缩碳');
  assert.equal(compressed.leaf, true, '截断层在树上应是叶子');
  assert.equal(compressed.shortfall, 64);
});
