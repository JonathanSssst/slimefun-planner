#!/usr/bin/env node
/**
 * 命令行版：直接验证引擎在真实数据上的表现（也是网页版的数据入口参考）。
 *
 * 用法：
 *   node tools/cli.mjs "人造钻石 x1, 铁粉 x64"
 *   node tools/cli.mjs --json "钢锭 x10"
 *   node tools/cli.mjs --list 人造          # 搜索物品
 *   node tools/cli.mjs --depth=1 "强化合金锭 x16"   # 清单停在直接投料（铜粉/铁粉这类）
 *   node tools/cli.mjs --depth=all "强化合金锭 x16" # 一路展开到煤炭/沙砾等生料
 */

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadDatasetFromTexts, DEFAULT_BASE_MATERIALS } from '../engine/data.js';
import { plan } from '../engine/planner.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function loadCoreDataset(extraFiles = []) {
  const files = ['recipes.core.jsonl', ...extraFiles];
  const sources = [];
  for (const file of files) {
    const path = join(root, 'data', file);
    if (!existsSync(path)) continue;
    sources.push({ name: file, text: readFileSync(path, 'utf8') });
  }
  let overrides = [];
  const overridePath = join(root, 'data', 'overrides.json');
  if (existsSync(overridePath)) {
    try {
      overrides = JSON.parse(readFileSync(overridePath, 'utf8'));
    } catch (err) {
      console.error('[warn] overrides.json 解析失败：', err.message);
    }
  }
  return loadDatasetFromTexts(sources, { overrides });
}

/** 解析 "铁粉 x64, 钢锭 128" 这样的输入 */
export function parseTargets(text, dataset, baseSet) {
  const parts = String(text)
    .split(/[,，;；\n]+/)
    .map((part) => part.trim())
    .filter(Boolean);
  const targets = [];
  const unknown = [];
  for (const part of parts) {
    const match = part.match(/^(.*?)\s*[x×*]?\s*(\d+)?\s*$/i);
    const query = (match?.[1] || part).trim();
    const count = Number(match?.[2] || 1);
    if (!query) continue;
    const exact = dataset.get(query) || dataset.get(`simefun4:${query.toUpperCase()}`);
    if (exact) {
      targets.push({ id: exact.id, count });
      continue;
    }
    const hits = dataset.search(query, 1);
    if (hits.length > 0) targets.push({ id: hits[0].id, count });
    else unknown.push(query);
  }
  void baseSet;
  return { targets, unknown };
}

function formatTree(node, lines, prefix = '', isLast = true, isRoot = true) {
  const branch = isRoot ? '' : (isLast ? '├─ ' : '├─ ');
  const head = isRoot ? '' : (isLast ? '└─ ' : '├─ ');
  const craftInfo = node.children.length > 0 ? `（${node.machine} ×${node.crafts} 次，共产 ${node.produced}）` : '';
  const leafInfo = node.leaf ? `  ← 需要弄到 ${node.shortfall || node.quantity}` : '';
  lines.push(`${prefix}${head}${node.name} ×${node.quantity}${craftInfo}${leafInfo}`);
  void branch;
  const childPrefix = isRoot ? '' : prefix + (isLast ? '   ' : '│  ');
  node.children.forEach((child, index) => {
    formatTree(child, lines, childPrefix, index === node.children.length - 1, false);
  });
}

function main() {
  const args = process.argv.slice(2);
  const asJson = args.includes('--json');
  const listMode = args.includes('--list');
  const fileArg = args.find((arg) => arg.startsWith('--addons='));
  const extra = fileArg ? fileArg.slice('--addons='.length).split(',') : [];
  const dataset = loadCoreDataset(extra.map((name) => (name.endsWith('.jsonl') ? name : `${name}.jsonl`)));

  // 采集清单粒度：默认停在一层（直接投料的中间产物），--depth=all 展开到生料
  const depthArg = args.find((arg) => arg.startsWith('--depth='));
  const depthRaw = depthArg ? depthArg.slice('--depth='.length) : '1';
  const depthValue = depthRaw === 'all' || depthRaw === 'inf' ? undefined : Number(depthRaw);

  if (listMode) {
    const keyword = args[args.indexOf('--list') + 1] || '';
    const hits = dataset.search(keyword, 25);
    console.log(`数据集共 ${dataset.size} 条物品。搜索「${keyword}」：`);
    for (const hit of hits) console.log(`  ${hit.name}  (${hit.id})  [${hit.recipeType}]`);
    return;
  }

  const input = args.filter((arg) => !arg.startsWith('--')).join(' ');
  if (!input) {
    console.log('用法：node tools/cli.mjs "人造钻石 x1, 铁粉 x64"');
    return;
  }

  const baseSet = new Set(DEFAULT_BASE_MATERIALS);
  const { targets, unknown } = parseTargets(input, dataset, baseSet);
  if (unknown.length > 0) console.log(`未识别的物品：${unknown.join('、')}`);
  if (targets.length === 0) {
    console.log('没有解析出任何目标物品。');
    return;
  }

  const result = plan(dataset, {
    targets,
    baseMaterials: [...baseSet],
    materialDepth: depthValue,
  });

  if (asJson) {
    console.log(JSON.stringify({
      summary: result.summary,
      raw: result.raw,
      workOrder: result.workOrder,
      tree: result.tree,
      variantReport: result.variantReport,
      cycles: result.cycles,
      missing: result.missing,
    }, null, 2));
    return;
  }

  console.log(`\n目标：${targets.map((t) => `${dataset.name(t.id)} ×${t.count}`).join('、')}`);
  console.log(`迭代 ${result.iterations} 轮，收敛：${result.converged ? '是' : '否'}`);

  console.log('\n=== 采集清单（要弄到的东西）===');
  for (const item of result.raw.slice(0, 60)) {
    const tag = item.kind === 'base' ? '基础材料'
      : item.kind === 'gather' ? '采集/掉落'
      : item.kind === 'cutoff' ? '中间产物(可自制)'
      : item.kind === 'cycle' ? '循环·需人工确认'
      : '无配方数据';
    console.log(`  ${String(item.count).padStart(4)} × ${item.name}  [${tag}]  需求 ${item.demand}`);
  }
  if (result.raw.length > 60) console.log(`  ... 其余 ${result.raw.length - 60} 项省略`);

  console.log('\n=== 合成工序（按顺序做）===');
  for (const step of result.workOrder) {
    const materials = step.materials.map((m) => `${m.name}×${m.total}`).join(' + ');
    console.log(`  ${String(step.step).padStart(2)}. ${step.name} ×${step.crafts} 次 → ${step.produced} 个  【${step.machine}】  需要：${materials}`);
  }

  console.log('\n=== 树状图 ===');
  for (const root of result.tree.roots) {
    const lines = [];
    formatTree(root, lines);
    console.log(lines.join('\n'));
  }

  if (result.variantReport?.length) {
    console.log('\n=== 多路线自动择优 ===');
    for (const report of result.variantReport) {
      console.log(`  ${report.name}：选了【${report.picked}】(单位成本 ${report.pickedCost.toFixed(2)})`);
      for (const candidate of report.candidates) {
        console.log(`     候选 ${candidate.machine}  产出 ${candidate.output}  成本 ${candidate.unitCost.toFixed(2)}  用料 ${candidate.materials.join('+')}`);
      }
    }
  }
  if (result.cycles.length) console.log(`\n[注意] 检出 ${result.cycles.length} 个循环依赖，需人工确认。`);
  if (result.missing.length) console.log(`[注意] ${result.missing.length} 个物品没有配方数据：${result.missing.slice(0, 8).map((m) => m.name).join('、')}`);
  if (result.leftover.length) console.log(`[提示] 取整后富余：${result.leftover.slice(0, 8).map((l) => `${l.name}×${l.count}`).join('、')}`);
}

if (process.argv[1] && process.argv[1].endsWith('cli.mjs')) main();
