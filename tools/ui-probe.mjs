/**
 * 界面自检：用最小 DOM 桩跑一遍 ui/app.js 的完整流程，
 * 确认没有运行时错误、且四个页签都渲染出了内容。
 *
 * 用法：node tools/ui-probe.mjs [主页地址]
 */

const BASE = process.argv[2] || 'http://127.0.0.1:8765';

class FakeClassList {
  constructor() { this.set = new Set(); }
  add(...names) { names.forEach((name) => this.set.add(name)); }
  remove(...names) { names.forEach((name) => this.set.delete(name)); }
  toggle(name, force) {
    const shouldAdd = force === undefined ? !this.set.has(name) : force;
    if (shouldAdd) this.set.add(name); else this.set.delete(name);
    return shouldAdd;
  }
  contains(name) { return this.set.has(name); }
}

class FakeElement {
  constructor(tag = 'div', id = '') {
    this.tagName = tag.toUpperCase();
    this.id = id;
    this.children = [];
    this.classList = new FakeClassList();
    this.dataset = {};
    this.style = {};
    this.attributes = {};
    this.listeners = {};
    this.value = '';
    this.textContent = '';
    this._html = '';
    this.hidden = false;
    this.checked = false;
  }
  set innerHTML(html) {
    this._html = String(html);
    // 极简解析：记录带 data-* 与 id 的元素数量，够做"渲染是否为空"的判断
    this._nodeCount = (this._html.match(/<div|<tr|<label|<button|<span/g) || []).length;
  }
  get innerHTML() { return this._html; }
  addEventListener(type, handler) {
    (this.listeners[type] ||= []).push(handler);
  }
  dispatch(type, event = {}) {
    for (const handler of this.listeners[type] || []) handler({ target: this, preventDefault() {}, ...event });
  }
  querySelector(selector) { return this._find(selector); }
  querySelectorAll(selector) {
    const found = [];
    this._collect(selector, found);
    return found;
  }
  _find(selector) {
    const all = this.querySelectorAll(selector);
    return all[0] || null;
  }
  _collect(selector, out) {
    for (const child of this.children) {
      if (matches(child, selector)) out.push(child);
      child._collect(selector, out);
    }
  }
  closest() { return null; }
  appendChild(child) {
    this.children.push(child);
    // 桩里动态插入的节点也反映到 innerHTML，方便断言查询
    this._html += child._html || (child.tagName ? `<${child.tagName.toLowerCase()}></${child.tagName.toLowerCase()}>` : '');
    return child;
  }
  insertBefore(child, reference) {
    const index = reference ? this.children.indexOf(reference) : -1;
    if (index >= 0) this.children.splice(index, 0, child);
    else this.children.push(child);
    this._html += child._html || (child.tagName ? `<${child.tagName.toLowerCase()}></${child.tagName.toLowerCase()}>` : '');
    return child;
  }
  removeChild(child) {
    const index = this.children.indexOf(child);
    if (index >= 0) this.children.splice(index, 1);
    return child;
  }
  click() { this.dispatch('click'); }
  setAttribute(name, value) { this.attributes[name] = value; }
  getBoundingClientRect() { return { top: 0, left: 0, width: 100, height: 20 }; }
  focus() {}
}

function matches(element, selector) {
  if (selector.startsWith('#')) return element.id === selector.slice(1);
  if (selector.startsWith('.')) return element.classList.contains(selector.slice(1));
  if (selector.startsWith('input[')) {
    const attr = selector.slice(6, -1);
    const [name, value] = attr.split('=');
    const key = name.trim();
    if (value === undefined) return element.tagName === 'INPUT' && key in element.dataset;
    const wanted = value.replace(/["']/g, '');
    return element.tagName === 'INPUT' && element.dataset[key] === wanted;
  }
  if (selector === 'input[type=radio]') return element.tagName === 'INPUT' && element.type === 'radio';
  return element.tagName === selector.toUpperCase();
}

const registry = new Map();
const listRegistry = new Map();
const documentStub = {
  createElement: (tag) => new FakeElement(tag),
  documentElement: new FakeElement('html'),
  querySelector: (selector) => {
    if (!registry.has(selector)) {
      const id = selector.startsWith('#') ? selector.slice(1) : '';
      const element = new FakeElement('div', id);
      registry.set(selector, element);
    }
    return registry.get(selector);
  },
  // 桩里按选择器返回一个占位元素：数量断言交给"抓 HTML 源"来做
  querySelectorAll: (selector) => {
    if (!listRegistry.has(selector)) {
      const element = new FakeElement('div');
      element.dataset = selector.includes('data-view=book') ? { view: 'book' }
        : selector.includes('data-view=materials') ? { view: 'materials' }
          : selector.includes('side-panel') ? { sidePanel: 'book' } : {};
      listRegistry.set(selector, [element]);
    }
    return listRegistry.get(selector);
  },
  addEventListener: () => {},
  body: new FakeElement('body'),
};

globalThis.document = documentStub;
globalThis.window = { addEventListener: () => {} };
globalThis.location = {
  hostname: new URL(BASE).hostname,
  href: `${BASE}/`,
  protocol: new URL(BASE).protocol,
  search: new URL(BASE).search || '',
};// Node 里 navigator 是只读 getter，用 defineProperty 补上 clipboard
try {
  Object.defineProperty(globalThis, 'navigator', {
    value: { clipboard: { writeText: async () => {} } },
    configurable: true,
  });
} catch (err) {
  console.warn('navigator 桩未装上：', err.message);
}
globalThis.localStorage = {
  store: new Map(),
  getItem(key) { return this.store.has(key) ? this.store.get(key) : null; },
  setItem(key, value) { this.store.set(key, value); },
};
globalThis.alert = (message) => console.log('[alert]', message);
globalThis.Blob = class { constructor(parts) { this.parts = parts; } };
globalThis.URL.createObjectURL = () => 'blob:fake';
globalThis.URL.revokeObjectURL = () => {};

const realFetch = globalThis.fetch;
const BASE_URL = new URL(BASE);
globalThis.fetch = (url, options) => {
  // 相对路径按站点根解析，且丢掉 ?theme=... 之类的查询串（静态文件不需要）
  const target = new URL(url, `${BASE_URL.origin}${BASE_URL.pathname}`);
  target.search = '';
  return realFetch(target.toString(), options);
};

let failures = 0;
function check(label, condition, detail = '') {
  if (condition) {
    console.log(`  ✔ ${label}`);
  } else {
    failures += 1;
    console.log(`  ✖ ${label} ${detail}`);
  }
}

const errors = [];
process.on('unhandledRejection', (err) => errors.push(err));
process.on('uncaughtException', (err) => errors.push(err));

const { pathToFileURL } = await import('node:url');
const stages = [];
const originalLog = console.log;
console.log = (...args) => { stages.push(args.join(' ')); originalLog(...args); };
await import(pathToFileURL(new URL('../ui/app.js', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')).href);

// 轮询等待界面渲染完成（外网慢的时候 2.5 秒可能不够）
const deadline = Date.now() + 20000;
while (Date.now() < deadline) {
  if (/配方条目/.test(documentStub.querySelector('#datasetInfo').innerHTML)) break;
  await new Promise((resolve) => setTimeout(resolve, 300));
}
await new Promise((resolve) => setTimeout(resolve, 800));

const expectedTheme = BASE_URL.searchParams.get('theme') || 'light';
console.log('\n界面自检结果：');
check('无未捕获异常', errors.length === 0, errors.map((err) => err.message).join('; '));
check(`主题为 ${expectedTheme}（默认浅色，?theme=dark 可切换）`,
  documentStub.documentElement.attributes['data-theme'] === expectedTheme,
  `实际=${documentStub.documentElement.attributes['data-theme']}`);
check('主题按钮标签正确',
  documentStub.querySelector('#themeLabel').textContent === (expectedTheme === 'dark' ? '深色' : '浅色'),
  `实际=${documentStub.querySelector('#themeLabel').textContent}`);
check('数据集信息已渲染', /配方条目/.test(documentStub.querySelector('#datasetInfo').innerHTML));
check('侧边栏分类树已渲染', /nav-group|nav-item/.test(documentStub.querySelector('#categoryNav').innerHTML));
check('目标清单已渲染（选框添加）', /target-row/.test(documentStub.querySelector('#targetList').innerHTML));
check('物品选框已初始化', Boolean(documentStub.querySelector('#itemInput')) && Boolean(documentStub.querySelector('#suggestBox')));
check('常用目标快捷按钮已渲染', /chip-btn/.test(documentStub.querySelector('#goalChips').innerHTML));
check('目标/统计提示已渲染', /材料|目标/.test(documentStub.querySelector('#goalHint').textContent));
check('树状图已渲染节点', /node-head/.test(documentStub.querySelector('#treeView').innerHTML));
check('树节点带物品图标', /item-icon/.test(documentStub.querySelector('#treeView').innerHTML));
check('配方详情已渲染（网格 + 用途）', /recipe-grid|detail-head/.test(documentStub.querySelector('#recipeHost').innerHTML));
check('采集清单已渲染', /<table|不需要额外采集/.test(documentStub.querySelector('#materialsView').innerHTML));
check('合成工序已渲染', /<table/.test(documentStub.querySelector('#orderView').innerHTML));
check('设置与手工补录在右侧', /base-group/.test(documentStub.querySelector('#baseGroups').innerHTML)
  && Boolean(documentStub.querySelector('.settings-panel')));

// 结构断言：抓 index.html 源确认侧边栏只有两个页签、其余功能都在右侧
try {
  const html = await (await fetch(`${BASE_URL.origin}${BASE_URL.pathname}`)).text();
  const aside = html.slice(html.indexOf('<aside'), html.indexOf('</aside>'));
  const sideTabs = (aside.match(/class="side-tab(?: active)?"/g) || []).length;
  check('侧边栏只有 2 个页签按钮（配方书 / 材料统计）', sideTabs === 2, `实际 ${sideTabs} 个`);
  check('侧边栏里没有任何输入框/筛选/分类/结果面板',
    !/<input|<select|<textarea/.test(aside)
    && !/id="categoryNav"/.test(aside)
    && !/id="targetList"/.test(aside)
    && !/data-tab=/.test(aside)
    && !/settings-panel/.test(aside));

  const book = html.slice(html.indexOf('data-view-panel="book"'), html.indexOf('data-view-panel="materials"'));
  check('配方书视图里有选框、分类目录、配方详情',
    /id="itemInput"/.test(book) && /id="categoryNav"/.test(book) && /id="recipeHost"/.test(book));
  const materials = html.slice(html.indexOf('data-view-panel="materials"'));
  check('材料统计视图里有目标清单、粒度选择、结果页签与设置',
    /id="targetList"/.test(materials) && /id="depthSelect"/.test(materials)
    && /data-tab="materials"/.test(materials) && /settings-panel/.test(materials));
} catch (err) {
  check('结构断言（抓 index.html）', false, err.message);
}

const treeHtml = documentStub.querySelector('#treeView').innerHTML;
console.log('\n树状图首节点预览：');
console.log(treeHtml.split('\n').slice(0, 12).join('\n').slice(0, 700));

process.exit(failures === 0 ? 0 : 1);
