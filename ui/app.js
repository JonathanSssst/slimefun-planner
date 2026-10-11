/**
 * 网页版入口：加载数据 → 组装界面 → 调用引擎算配方树。
 */

import { loadDatasetFromTexts, DEFAULT_BASE_MATERIALS, BASE_MATERIAL_GROUPS } from '../engine/data.js';
import { plan } from '../engine/planner.js';

const CORE_FILE = 'recipes.core.jsonl';
/** 仓库自带的补录（版主维护的公共补录，任何人拉下来都能用） */
const BUILTIN_OVERRIDES_FILE = 'data/overrides.json';

const STORAGE_KEY = 'slimefun-planner-settings-v1';
const LOCAL_OVERRIDES_KEY = 'slimefun-planner-overrides-v1';

const state = {
  dataset: null,
  result: null,
  targets: [],
  baseMaterials: new Set(DEFAULT_BASE_MATERIALS),
  inventoryText: '',
  overrides: [],
  localOverrides: [],
  recipeChoice: {},
  autoSelect: true,
  addonFiles: [],
};

const $ = (selector) => document.querySelector(selector);

let coreText = '';

/** 判断是否在静态托管（GitHub Pages 等没有后端）环境下运行 */
function isStaticHost() {
  if (typeof location === 'undefined') return true;
  return !/^127\.0\.0\.1$|^localhost$/.test(location.hostname || '');
}

// ---------------------------------------------------------------- 数据加载

async function fetchText(path) {
  const response = await fetch(path, { cache: 'no-store' });
  if (!response.ok) throw new Error(`${path} 读取失败（HTTP ${response.status}）`);
  return response.text();
}

function readLocalOverrides() {
  try {
    const raw = localStorage.getItem(LOCAL_OVERRIDES_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    console.warn('[overrides] 本地补录损坏，已忽略', err);
    return [];
  }
}

function writeLocalOverrides(list) {
  try {
    localStorage.setItem(LOCAL_OVERRIDES_KEY, JSON.stringify(list));
    return true;
  } catch (err) {
    console.warn('[overrides] 本地补录保存失败', err);
    return false;
  }
}

async function loadData() {
  coreText = await fetchText(`data/${CORE_FILE}`);
  const sources = [{ name: CORE_FILE, text: coreText }];
  const loadedAddons = [];
  for (const name of state.addonFiles) {
    try {
      const text = await fetchText(`data/recipes.addons/${name}.jsonl`);
      sources.push({ name, text });
      loadedAddons.push(name);
    } catch (err) {
      console.warn('[addon] 跳过', name, err.message);
    }
  }

  const builtin = await readBuiltinOverrides();
  state.localOverrides = readLocalOverrides();
  state.overrides = mergeOverrides(builtin, state.localOverrides);

  state.dataset = loadDatasetFromTexts(sources, { overrides: state.overrides });
  return loadedAddons;
}

/** 仓库自带的公共补录（版主维护，所有人共享） */
async function readBuiltinOverrides() {
  try {
    const parsed = JSON.parse((await fetchText(BUILTIN_OVERRIDES_FILE)).replace(/^\uFEFF/, ''));
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    console.warn('[overrides] 读取公共补录失败，按空处理', err.message);
    return [];
  }
}

/** 改完补录后重建数据集（只吃核心数据，附属沿用上次加载状态） */
function createDatasetWithOverrides(overrides) {
  return loadDatasetFromTexts([{ name: CORE_FILE, text: coreText }], { overrides });
}

/** 同一个 id 时本地补录覆盖公共补录 */
function mergeOverrides(builtin, local) {
  const map = new Map();
  for (const item of builtin) if (item && item.id) map.set(item.id, item);
  for (const item of local) if (item && item.id) map.set(item.id, item);
  return [...map.values()];
}


function loadSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
    if (Array.isArray(saved.baseMaterials) && saved.baseMaterials.length > 0) {
      state.baseMaterials = new Set(saved.baseMaterials);
    }
    if (typeof saved.inventoryText === 'string') state.inventoryText = saved.inventoryText;
    if (Array.isArray(saved.addonFiles)) state.addonFiles = saved.addonFiles;
    if (typeof saved.autoSelect === 'boolean') state.autoSelect = saved.autoSelect;
  } catch (err) {
    console.warn('[settings] 读取失败', err);
  }
}

function saveSettings() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      baseMaterials: [...state.baseMaterials],
      inventoryText: state.inventoryText,
      addonFiles: state.addonFiles,
      autoSelect: state.autoSelect,
    }));
  } catch (err) {
    console.warn('[settings] 保存失败', err);
  }
}

// ---------------------------------------------------------------- 输入解析

function parseInventory(text) {
  const inventory = {};
  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const match = line.match(/^(.*?)\s*[=:：]\s*(\d+)$/) || line.match(/^(\S+)\s+(\d+)$/);
    if (!match) continue;
    const query = match[1].trim();
    const count = Number(match[2]);
    if (!query || !Number.isFinite(count) || count <= 0) continue;
    const id = resolveItemId(query);
    if (id) inventory[id] = (inventory[id] || 0) + count;
  }
  return inventory;
}

function resolveItemId(query) {
  const trimmed = String(query || '').trim();
  if (!trimmed) return null;
  if (state.dataset.has(trimmed)) return trimmed;
  const upper = `simefun4:${trimmed.toUpperCase().replace(/\s+/g, '_')}`;
  if (state.dataset.has(upper)) return upper;
  if (state.dataset.has(trimmed.toUpperCase())) return trimmed.toUpperCase();
  const hits = state.dataset.search(trimmed, 1);
  return hits.length > 0 ? hits[0].id : null;
}

function parseTargets(text) {
  const targets = [];
  const unknown = [];
  for (const rawLine of String(text || '').split(/[\n,，;；]+/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const match = line.match(/^(.*?)\s*(?:[x×*]\s*)?(\d+)\s*$/i);
    const query = (match ? match[1] : line).trim();
    const count = match && match[2] ? Number(match[2]) : 1;
    if (!query) continue;
    const id = resolveItemId(query);
    if (!id) {
      unknown.push(query);
      continue;
    }
    const existing = targets.find((target) => target.id === id);
    if (existing) existing.count += count;
    else targets.push({ id, count });
  }
  return { targets, unknown };
}

// ---------------------------------------------------------------- 计算

function compute() {
  if (!state.dataset) return null;
  const inventory = parseInventory(state.inventoryText);
  const result = plan(state.dataset, {
    targets: state.targets,
    baseMaterials: [...state.baseMaterials],
    inventory,
    autoSelect: state.autoSelect,
    recipeChoice: state.recipeChoice,
  });
  result.inventoryUsed = inventory;
  return result;
}

// ---------------------------------------------------------------- 渲染

function renderDatasetInfo(addonCount) {
  const total = state.dataset.size;
  $('#datasetInfo').innerHTML = `配方条目 <b>${total}</b> 条${addonCount ? ` · 附属 ${addonCount} 个` : ' · 仅本体'}`;
}

function renderSummary(result) {
  const panel = $('#summaryPanel');
  panel.hidden = false;
  const summary = result.summary;
  const cards = [
    ['采集材料种类', `${summary.rawKinds} 种`],
    ['需要收集总数', `${summary.rawTotal} 个`],
    ['合成步骤', `${summary.craftSteps} 步`],
    ['涉及机器', `${summary.machines} 种`],
  ];
  $('#summaryGrid').innerHTML = cards
    .map(([label, value]) => `<div class="card"><span class="card-value">${value}</span><span class="card-label">${label}</span></div>`)
    .join('');

  const warnings = [];
  if (result.cycles.length > 0) {
    warnings.push(`⚠ 检出 <b>${result.cycles.length}</b> 个循环依赖（配方互为原料），已按"需人工确认"处理：${result.cycles.slice(0, 5).map((cycle) => escapeHtml(cycle.name)).join('、')}`);
  }
  if (result.missing.length > 0) {
    warnings.push(`⚠ <b>${result.missing.length}</b> 个物品没有配方数据，已当作生料列出：${result.missing.slice(0, 8).map((item) => escapeHtml(item.name)).join('、')}`);
  }
  if (result.leftover.length > 0) {
    warnings.push(`ℹ 取整后富余：${result.leftover.slice(0, 8).map((item) => `${escapeHtml(item.name)}×${item.count}`).join('、')}`);
  }
  if (result.inventoryUsed && Object.keys(result.inventoryUsed).length > 0) {
    warnings.push(`ℹ 已按库存抵扣：${result.usedInventory.map((item) => `${escapeHtml(item.name)} -${item.used}`).join('、')}`);
  }
  $('#warnList').innerHTML = warnings.map((text) => `<div class="warn">${text}</div>`).join('');
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[char]));
}

function renderTree(result) {
  const container = $('#treeView');
  const nodes = result.tree.roots.map((root) => treeNodeHtml(root, true));
  container.innerHTML = nodes.join('') || '<p class="empty">还没有结果。</p>';
}

function treeNodeHtml(node, isRoot) {
  const hasChildren = node.children.length > 0;
  const craftBits = [];
  if (hasChildren) {
    craftBits.push(`<span class="chip machine">${escapeHtml(node.machine)}</span>`);
    craftBits.push(`<span class="chip">${node.crafts} 次 → ${node.produced} 个</span>`);
  } else {
    const kindLabel = {
      base: '基础材料',
      gather: '采集/掉落',
      cycle: '循环·需确认',
      unknown: '无配方数据',
      crafted: '成品',
      stock: '库存',
    }[node.leafKind] || '材料';
    craftBits.push(`<span class="chip leaf ${node.leafKind}">${kindLabel}</span>`);
    if (node.shortfall > 0) craftBits.push(`<span class="chip need">去弄 ${node.shortfall}</span>`);
    if (node.fromInventory > 0) craftBits.push(`<span class="chip stock">库存 ${node.fromInventory}</span>`);
  }
  if (node.shared) {
    craftBits.push(`<span class="chip shared" title="被多个分支共用：${escapeHtml((node.sharedFrom || []).join('、'))}">共用</span>`);
  }
  if (node.researchCost) craftBits.push(`<span class="chip research">解锁 ${node.researchCost}</span>`);

  const children = hasChildren
    ? `<div class="children">${node.children.map((child) => treeNodeHtml(child, false)).join('')}</div>`
    : '';
  const toggle = hasChildren ? '<span class="toggle">▾</span>' : '<span class="toggle empty"></span>';

  return `<div class="node ${isRoot ? 'root' : ''} ${node.leaf ? 'leaf-node' : ''}">
    <div class="node-head">
      ${toggle}
      <span class="node-name">${escapeHtml(node.name)}</span>
      <span class="node-qty">×${node.quantity}</span>
      ${craftBits.join('')}
    </div>
    ${children}
  </div>`;
}

function renderMaterials(result) {
  const rows = result.raw.map((item) => {
    const kindLabel = {
      base: '<span class="tag base">基础材料</span>',
      gather: '<span class="tag gather">采集/掉落</span>',
      cycle: '<span class="tag cycle">循环·需确认</span>',
      unknown: '<span class="tag unknown">无配方数据</span>',
      target: '<span class="tag">目标</span>',
    }[item.kind] || '<span class="tag">材料</span>';
    return `<tr>
      <td class="num">${item.count}</td>
      <td>${escapeHtml(item.name)}</td>
      <td class="muted">${item.demand}</td>
      <td class="muted">${item.fromInventory || 0}</td>
      <td>${kindLabel}</td>
      <td class="muted small">${escapeHtml(item.id)}</td>
    </tr>`;
  }).join('');
  $('#materialsView').innerHTML = rows
    ? `<table><thead><tr><th>要弄到</th><th>材料</th><th>总需求</th><th>库存抵扣</th><th>类型</th><th>ID</th></tr></thead><tbody>${rows}</tbody></table>`
    : '<p class="empty">不需要额外采集任何材料（库存已满足）。</p>';
}

function renderOrder(result) {
  const rows = result.workOrder.map((step) => {
    const materials = step.materials
      .map((material) => `${escapeHtml(material.name)} ×${material.total}`)
      .join('　+　');
    return `<tr>
      <td class="num">${step.step}</td>
      <td>${escapeHtml(step.name)}</td>
      <td class="num">${step.crafts}</td>
      <td class="num">${step.produced}</td>
      <td><span class="chip machine">${escapeHtml(step.machine)}</span></td>
      <td class="materials-cell">${materials || '<span class="muted">—</span>'}</td>
    </tr>`;
  }).join('');
  $('#orderView').innerHTML = rows
    ? `<table><thead><tr><th>#</th><th>要合成的物品</th><th>次数</th><th>产出</th><th>机器</th><th>每次投料（已按次数折算）</th></tr></thead><tbody>${rows}</tbody></table>`
    : '<p class="empty">没有需要合成的步骤。</p>';
}

function renderRoutes(result) {
  const reports = result.variantReport || [];
  if (reports.length === 0) {
    $('#routesView').innerHTML = '<p class="empty">这次的目标没有遇到"多条合成途径"的物品。</p>';
    return;
  }
  $('#routesView').innerHTML = reports.map((report) => {
    const options = report.candidates.map((candidate) => {
      const checked = candidate.machine === report.picked ? 'checked' : '';
      return `<label class="route-option">
        <input type="radio" name="route-${escapeHtml(report.id)}" value="${escapeHtml(candidate.key)}" ${checked}>
        <span class="route-machine">${escapeHtml(candidate.machine)}</span>
        <span class="muted">每次产出 ${candidate.output} · 单位成本 ${candidate.unitCost.toFixed(2)}</span>
        <span class="route-materials">${candidate.materials.map(escapeHtml).join(' + ')}</span>
      </label>`;
    }).join('');
    return `<div class="route-card" data-id="${escapeHtml(report.id)}">
      <div class="route-head"><b>${escapeHtml(report.name)}</b><span class="muted">当前选择：${escapeHtml(report.picked)}</span></div>
      ${options}
    </div>`;
  }).join('');

  $('#routesView').querySelectorAll('input[type=radio]').forEach((input) => {
    input.addEventListener('change', () => {
      const card = input.closest('.route-card');
      const id = card.dataset.id;
      if (input.checked) {
        state.recipeChoice[id] = input.value;
        state.autoSelect = false;
        $('#autoSelect').checked = false;
        saveSettings();
        runPlan();
      }
    });
  });
}

function renderBaseGroups() {
  $('#baseGroups').innerHTML = BASE_MATERIAL_GROUPS.map((group) => {
    const items = group.items.map((id) => {
      const checked = state.baseMaterials.has(id) ? 'checked' : '';
      return `<label class="base-item"><input type="checkbox" data-base-id="${escapeHtml(id)}" ${checked}> ${escapeHtml(state.dataset.name(id))}</label>`;
    }).join('');
    return `<details class="base-group" open>
      <summary>${escapeHtml(group.label)} <span class="muted">(${group.items.length})</span></summary>
      <div class="base-items">${items}</div>
    </details>`;
  }).join('');

  $('#baseGroups').querySelectorAll('input[data-base-id]').forEach((input) => {
    input.addEventListener('change', () => {
      const id = input.dataset.baseId;
      if (input.checked) state.baseMaterials.add(id);
      else state.baseMaterials.delete(id);
      saveSettings();
      runPlan();
    });
  });
}

function renderSources(addonCount) {
  const hostNote = isStaticHost()
    ? '当前是<b>静态托管</b>（GitHub Pages）：补录只保存在你的浏览器里。'
    : '当前是<b>本地模式</b>：补录可以写回 <code>data/overrides.json</code>。';
  $('#sourceInfo').innerHTML = `核心配方：<code>data/recipes.core.jsonl</code>（549 条，Slimefun4 本体）<br>
    已启用附属：${addonCount ? escapeHtml(state.addonFiles.join('、')) : '无'}<br>
    公共补录：<code>${BUILTIN_OVERRIDES_FILE}</code> · 本地补录：<b>${state.localOverrides.length}</b> 条<br>
    ${hostNote}`;
}

// ---------------------------------------------------------------- 交互

function setBadge(id, value) {
  const badge = $(id);
  badge.textContent = value;
  badge.classList.toggle('zero', !value);
}

function runPlan() {
  const text = $('#targetInput').value;
  const { targets, unknown } = parseTargets(text);
  state.targets = targets;

  const notice = $('#inputNotice');
  if (unknown.length > 0) {
    notice.hidden = false;
    notice.innerHTML = `没找到这些物品，已跳过：<b>${escapeHtml(unknown.join('、'))}</b>（试试用中文名或物品 ID 搜索）`;
  } else {
    notice.hidden = true;
  }

  if (targets.length === 0) {
    $('#resultPanel').hidden = true;
    $('#summaryPanel').hidden = true;
    state.result = null;
    return;
  }

  const result = compute();
  state.result = result;
  $('#resultPanel').hidden = false;

  renderSummary(result);
  renderTree(result);
  renderMaterials(result);
  renderOrder(result);
  renderRoutes(result);
  setBadge('#materialBadge', result.raw.length);
  setBadge('#orderBadge', result.workOrder.length);
  setBadge('#routeBadge', (result.variantReport || []).length);
}

function setupTabs() {
  document.querySelectorAll('.tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach((other) => other.classList.remove('active'));
      document.querySelectorAll('.tab-pane').forEach((pane) => pane.classList.remove('active'));
      tab.classList.add('active');
      const pane = document.querySelector(`.tab-pane[data-pane="${tab.dataset.tab}"]`);
      if (pane) pane.classList.add('active');
    });
  });
}

function setupTreeControls() {
  $('#treeView').addEventListener('click', (event) => {
    const head = event.target.closest('.node-head');
    if (!head) return;
    const node = head.parentElement;
    if (node.querySelector('.children')) node.classList.toggle('collapsed');
  });
  $('#expandAll').addEventListener('click', () => {
    document.querySelectorAll('#treeView .node').forEach((node) => node.classList.remove('collapsed'));
  });
  $('#collapseAll').addEventListener('click', () => {
    document.querySelectorAll('#treeView .node').forEach((node) => {
      if (node.querySelector('.children')) node.classList.add('collapsed');
    });
  });
  $('#exportText').addEventListener('click', () => {
    if (!state.result) return;
    const lines = [];
    const walk = (node, prefix, isLast, isRoot) => {
      const head = isRoot ? '' : (isLast ? '└─ ' : '├─ ');
      const extra = node.children.length > 0 ? `（${node.machine} ×${node.crafts} → ${node.produced}）` : `  ← 去弄 ${node.shortfall || node.quantity}`;
      lines.push(`${prefix}${head}${node.name} ×${node.quantity}${extra}`);
      const childPrefix = isRoot ? '' : prefix + (isLast ? '   ' : '│  ');
      node.children.forEach((child, index) => walk(child, childPrefix, index === node.children.length - 1, false));
    };
    state.result.tree.roots.forEach((root) => walk(root, '', true, true));
    downloadText('配方树.txt', lines.join('\n'));
  });
}

function downloadText(filename, text) {
  const blob = new Blob([`\ufeff${text}`], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

function setupMaterialsControls() {
  $('#exportMaterials').addEventListener('click', () => {
    if (!state.result) return;
    const lines = ['要弄到,材料,总需求,库存抵扣,类型,ID'];
    for (const item of state.result.raw) {
      lines.push([item.count, item.name, item.demand, item.fromInventory || 0, item.kind, item.id].join(','));
    }
    downloadText('采集清单.csv', lines.join('\n'));
  });
  $('#copyMaterials').addEventListener('click', async () => {
    if (!state.result) return;
    const text = state.result.raw.map((item) => `${item.name} ×${item.count}`).join('\n');
    try {
      await navigator.clipboard.writeText(text);
      $('#copyMaterials').textContent = '已复制 ✓';
      setTimeout(() => { $('#copyMaterials').textContent = '复制文本'; }, 1500);
    } catch (err) {
      console.warn(err);
    }
  });
}

function setupSearch() {
  const input = $('#searchInput');
  const box = $('#suggestBox');
  const render = () => {
    const query = input.value.trim();
    if (!query) {
      box.hidden = true;
      return;
    }
    const hits = state.dataset.search(query, 12);
    if (hits.length === 0) {
      box.hidden = false;
      box.innerHTML = '<div class="suggest-item muted">没有匹配的物品</div>';
      return;
    }
    box.hidden = false;
    box.innerHTML = hits.map((hit) => `<div class="suggest-item" data-id="${escapeHtml(hit.id)}">
      <span>${escapeHtml(hit.name)}</span><span class="muted small">${escapeHtml(hit.recipeType || '')}</span>
    </div>`).join('');
  };
  input.addEventListener('input', render);
  input.addEventListener('focus', render);
  box.addEventListener('click', (event) => {
    const item = event.target.closest('.suggest-item');
    if (!item || !item.dataset.id) return;
    const target = $('#targetInput');
    target.value = `${target.value.trim()}${target.value.trim() ? '\n' : ''}${state.dataset.name(item.dataset.id)} x1`;
    input.value = '';
    box.hidden = true;
    runPlan();
  });
  document.addEventListener('click', (event) => {
    if (!event.target.closest('.search-wrap')) box.hidden = true;
  });
}

function setupSettings() {
  const inventory = $('#inventoryInput');
  inventory.value = state.inventoryText;
  inventory.addEventListener('change', () => {
    state.inventoryText = inventory.value;
    saveSettings();
    if (state.targets.length > 0) runPlan();
  });

  const overrideInput = $('#overrideInput');
  overrideInput.value = JSON.stringify(state.localOverrides, null, 2);

  /** 保存后立刻重建数据集并重算 */
  const applyOverrides = async (list, message) => {
    state.localOverrides = list;
    writeLocalOverrides(list);
    state.overrides = mergeOverrides(await readBuiltinOverrides(), list);
    state.dataset = createDatasetWithOverrides(state.overrides);
    if (message) alert(message);
    if (state.targets.length > 0) runPlan();
  };

  $('#saveOverrides').addEventListener('click', async () => {
    let parsed;
    try {
      parsed = JSON.parse((overrideInput.value || '[]').replace(/^\uFEFF/, ''));
      if (!Array.isArray(parsed)) throw new Error('必须是 JSON 数组');
    } catch (err) {
      alert(`补录格式有误：${err.message}`);
      return;
    }
    await applyOverrides(parsed, '已保存到你自己的浏览器（不会影响别人），配方已重新载入。');
  });

  $('#exportOverrides').addEventListener('click', () => {
    downloadText('slimefun-overrides.json', JSON.stringify(state.localOverrides, null, 2));
  });

  $('#importOverrides').addEventListener('click', () => $('#importOverrideFile').click());
  $('#importOverrideFile').addEventListener('change', async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      const parsed = JSON.parse(await file.text());
      if (!Array.isArray(parsed)) throw new Error('文件里必须是 JSON 数组');
      overrideInput.value = JSON.stringify(parsed, null, 2);
      await applyOverrides(parsed, `已导入 ${parsed.length} 条补录。`);
    } catch (err) {
      alert(`导入失败：${err.message}`);
    } finally {
      event.target.value = '';
    }
  });

  $('#reloadOverrides').addEventListener('click', async () => {
    overrideInput.value = JSON.stringify(state.localOverrides, null, 2);
    alert('已重新载入当前浏览器里的补录。');
  });
}

function setupQuickChips() {
  const presets = ['人造钻石 x1', '碳块 x8', '钢锭 x64', '铁粉 x64', '强化合金锭 x16'];
  $('#quickChips').innerHTML = presets
    .map((preset) => `<button class="chip-btn" data-preset="${escapeHtml(preset)}">${escapeHtml(preset)}</button>`)
    .join('');
  $('#quickChips').addEventListener('click', (event) => {
    const button = event.target.closest('.chip-btn');
    if (!button) return;
    const input = $('#targetInput');
    input.value = button.dataset.preset;
    runPlan();
  });
}

// ---------------------------------------------------------------- 启动

async function main() {
  loadSettings();
  $('#autoSelect').checked = state.autoSelect;

  let addonCount = 0;
  try {
    addonCount = (await loadData()).length;
  } catch (err) {
    $('#datasetInfo').innerHTML = `⚠ 数据加载失败：${escapeHtml(err.message)}<br>请用「启动配方助手.cmd」打开，或确认 data/recipes.core.jsonl 存在。`;
    return;
  }

  renderDatasetInfo(addonCount);
  renderBaseGroups();
  renderSources(addonCount);
  setupTabs();
  setupTreeControls();
  setupMaterialsControls();
  setupSearch();
  setupSettings();
  setupQuickChips();

  $('#planBtn').addEventListener('click', () => {
    state.recipeChoice = {};
    runPlan();
  });
  $('#clearBtn').addEventListener('click', () => {
    $('#targetInput').value = '';
    $('#resultPanel').hidden = true;
    $('#summaryPanel').hidden = true;
    state.result = null;
    state.targets = [];
  });
  $('#targetInput').addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) runPlan();
  });
  $('#autoSelect').addEventListener('change', () => {
    state.autoSelect = $('#autoSelect').checked;
    if (state.autoSelect) state.recipeChoice = {};
    saveSettings();
    runPlan();
  });

  $('#targetInput').value = '人造钻石 x1';
  runPlan();
}

main();
