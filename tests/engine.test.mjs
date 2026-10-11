import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { loadDatasetFromTexts } from '../engine/data.js';
import { plan } from '../engine/planner.js';

const here = dirname(fileURLToPath(import.meta.url));
const coreText = readFileSync(join(here, 'fixtures/core.jsonl'), 'utf8');

function fixture() {
  return loadDatasetFromTexts([{ name: 'core', text: coreText }]);
}

function rawOf(result, id) {
  return result.raw.find((item) => item.id === id);
}

test('按格计数 + 一次产出多件时向上取整', () => {
  const dataset = fixture();
  const result = plan(dataset, {
    targets: [{ id: 'simefun4:IRON_DUST', count: 13 }],
    baseMaterials: [],
  });
  const ore = rawOf(result, 'IRON_ORE');
  assert.ok(ore, '铁矿石应出现在采集清单');
  assert.equal(ore.count, 7, '13 份铁粉、每次产 2 → 7 次 → 7 个铁矿石');
  const route = result.routes.find((r) => r.id === 'simefun4:IRON_DUST');
  assert.equal(route.crafts, 7);
  assert.equal(route.produced, 14);
  const leftover = result.leftover.find((l) => l.id === 'simefun4:IRON_DUST');
  assert.equal(leftover.count, 14 - 13, '做 7 次共 14 份，用掉 13 份，多出 1 份');
});

test('共享中间产物只算一次总量', () => {
  const dataset = fixture();
  const result = plan(dataset, {
    targets: [
      { id: 'simefun4:STEEL_INGOT', count: 2 },
      { id: 'simefun4:NICKEL_INGOT', count: 1 },
    ],
    baseMaterials: [],
  });
  // 钢锭 x2 需铁粉 2，镍锭 x1 需铁粉 1 → 合计 3 份 → 每次产 2 → 2 次 → 2 个铁矿石
  assert.equal(rawOf(result, 'IRON_ORE').count, 2, '铁粉需求应合并为 3 份后统一取整');
  const dust = result.routes.find((r) => r.id === 'simefun4:IRON_DUST');
  assert.equal(dust.crafts, 2);
  // 铁矿石等基础材料默认不被展开（无配方）
  assert.equal(rawOf(result, 'IRON_INGOT').count, 3, '钢锭 2 + 镍锭 1 共需 3 个铁锭');
});

test('基础材料名单会截断展开', () => {
  const dataset = fixture();
  const result = plan(dataset, {
    targets: [{ id: 'simefun4:STEEL_INGOT', count: 3 }],
    baseMaterials: ['simefun4:IRON_DUST', 'C', 'IRON_INGOT'],
  });
  assert.equal(rawOf(result, 'simefun4:IRON_DUST').count, 3);
  assert.equal(rawOf(result, 'IRON_ORE'), undefined, '铁粉被视为采集终点后不应再展开成铁矿石');
  assert.equal(result.workOrder.length, 1, '只剩钢锭一步合成');
});

test('库存抵扣采购清单（合成次数仍按配方树计算）', () => {
  const dataset = fixture();
  const result = plan(dataset, {
    targets: [{ id: 'simefun4:STEEL_INGOT', count: 9 }],
    baseMaterials: [],
    inventory: { IRON_INGOT: 5 },
  });
  const steel = result.routes.find((r) => r.id === 'simefun4:STEEL_INGOT');
  assert.equal(steel.crafts, 9, '合成次数由配方树决定，不受库存影响');
  assert.equal(rawOf(result, 'IRON_INGOT').count, 4, '9 个铁锭里 5 个用库存，只需再弄 4 个');
  assert.equal(rawOf(result, 'IRON_INGOT').demand, 9, '需求仍是 9');
  const used = result.usedInventory.find((u) => u.id === 'IRON_INGOT');
  assert.equal(used.used, 5, '库存用掉 5 个');
});

test('循环配方被检出且不会无限展开', () => {
  const dataset = fixture();
  const result = plan(dataset, {
    targets: [{ id: 'simefun4:CYCLE_A', count: 1 }],
    baseMaterials: [],
  });
  assert.ok(result.cycles.length >= 1, '应报告循环依赖');
  const ids = result.cycles.map((c) => c.id);
  assert.ok(ids.includes('simefun4:CYCLE_A') || ids.includes('simefun4:CYCLE_B'));
  assert.ok(result.raw.length >= 1, '循环节点应作为待人工确认的材料列出');
});

test('多路线自动选最省生料', () => {
  const dataset = loadDatasetFromTexts([
    {
      name: 'core',
      text: [
        JSON.stringify({
          id: 'X:DUST',
          name: '粉末',
          recipeType: '矿石粉碎机',
          recipe: [{ material: 'ORE', name: '矿' }],
          output: 2,
        }),
        JSON.stringify({
          id: 'X:DUST',
          name: '粉末',
          recipeType: '洗矿机',
          recipe: [{ material: 'SIFTED', name: '筛矿' }],
          output: 1,
        }),
        JSON.stringify({
          id: 'X:TARGET',
          name: '目标',
          recipeType: '增强型工作台',
          recipe: [{ material: 'X:DUST', name: '粉末' }],
          output: 1,
        }),
      ].join('\n'),
    },
  ]);

  const result = plan(dataset, {
    targets: [{ id: 'X:TARGET', count: 1 }],
    baseMaterials: [],
  });
  const dust = result.routes.find((r) => r.id === 'X:DUST');
  assert.equal(dust.machine, '矿石粉碎机', '单次产出 2 的路线单位成本更低，应被选中');

  // 手动切到另一条路线（洗矿机）应当生效
  const washerKey = dataset
    .variants('X:DUST')
    .find((v) => v.recipeType === '洗矿机');
  const forced = plan(dataset, {
    targets: [{ id: 'X:TARGET', count: 1 }],
    baseMaterials: [],
    autoSelect: false,
    recipeChoice: { 'X:DUST': `${washerKey.source}:${washerKey.recipeType}:${washerKey.output}:${washerKey.materials
      .map((m) => `${m.material}x${m.slotCount}`)
      .join(',')}` },
  });
  const forcedDust = forced.routes.find((r) => r.id === 'X:DUST');
  assert.equal(forcedDust.machine, '洗矿机', '手动指定的路线应被采用');
});

test('采集型条目（生物掉落）不会继续展开', () => {
  const dataset = fixture();
  const result = plan(dataset, {
    targets: [{ id: 'simefun4:GATHER_ONLY', count: 4 }],
    baseMaterials: [],
  });
  const item = rawOf(result, 'simefun4:GATHER_ONLY');
  assert.equal(item.count, 4);
  assert.equal(item.kind, 'gather');
  assert.equal(result.routes.length, 0);
});

test('树与采集清单口径一致，且共享节点有标记', () => {
  const dataset = fixture();
  const result = plan(dataset, {
    targets: [
      { id: 'simefun4:STEEL_INGOT', count: 2 },
      { id: 'simefun4:NICKEL_INGOT', count: 1 },
    ],
    baseMaterials: [],
  });
  const treeDust = result.tree.roots.length;
  assert.ok(treeDust >= 2, '每个目标一棵树');
  const leaves = result.leaves.find((l) => l.id === 'IRON_ORE');
  assert.ok(leaves, '树上也能找到铁矿石');
  const dustNode = result.tree.roots[0].children.find((c) => c.id === 'simefun4:IRON_DUST');
  assert.equal(dustNode.shared, true, '铁粉被多条配方共用，应有 shared 标记');
});

test('未提供配方且不在名单里的材料会被标为数据缺失', () => {
  const dataset = fixture();
  const result = plan(dataset, {
    targets: [{ id: 'simefun4:UNKNOWN_ITEM', count: 1 }],
    baseMaterials: [],
  });
  assert.equal(result.missing.length, 1);
  assert.equal(result.missing[0].id, 'simefun4:UNKNOWN_ITEM');
});
