#!/usr/bin/env node
/**
 * 本地静态服务：给网页版提供数据，并支持把"手工补录配方"写回 data/overrides.json。
 * 只监听 127.0.0.1，不对外网开放。
 *
 * 端口：默认 8791（8765 常被别的东西占用），被占用时自动顺延并打印真实地址。
 * 环境变量：
 *   SF_PORT      起始端口
 *   SF_OPEN_URL=1 启动后自动打开浏览器
 */

import { createServer } from 'node:http';
import { readFile, writeFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(join(dirname(fileURLToPath(import.meta.url)), '..'));
const START_PORT = Number(process.env.SF_PORT || 8791);
const MAX_TRIES = 20;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.jsonl': 'application/x-ndjson; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

async function sendFile(res, path) {
  try {
    const info = await stat(path);
    if (info.isDirectory()) throw new Error('is a directory');
    const data = await readFile(path);
    res.writeHead(200, {
      'Content-Type': MIME[extname(path).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(data);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404 找不到文件');
  }
}

function safeJoin(urlPath) {
  const decoded = decodeURIComponent(urlPath.split('?')[0]);
  const relative = normalize(decoded).replace(/^([/\\])+/, '');
  const full = resolve(join(root, relative));
  if (!full.startsWith(root)) return null;
  return full;
}

async function handleOverridesApi(req, res) {
  const overridePath = join(root, 'data', 'overrides.json');
  if (req.method === 'GET') {
    try {
      const text = await readFile(overridePath, 'utf8');
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(text.replace(/^\uFEFF/, ''));
    } catch {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end('[]');
    }
    return;
  }
  if (req.method === 'POST') {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', async () => {
      try {
        const parsed = JSON.parse((body || '[]').replace(/^\uFEFF/, ''));
        if (!Array.isArray(parsed)) throw new Error('必须是 JSON 数组');
        await writeFile(overridePath, `${JSON.stringify(parsed, null, 2)}\n`, 'utf8');
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true, count: parsed.length }));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
    });
    return;
  }
  res.writeHead(405).end();
}

const server = createServer(async (req, res) => {
  const url = req.url || '/';
  if (url.startsWith('/api/overrides')) {
    await handleOverridesApi(req, res);
    return;
  }
  const target = safeJoin(url === '/' ? '/index.html' : url);
  if (!target) {
    res.writeHead(403).end('403 越界路径');
    return;
  }
  await sendFile(res, target);
});

let currentPort = START_PORT;
let attempt = 0;

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE' && attempt < MAX_TRIES) {
    attempt += 1;
    currentPort = START_PORT + attempt;
    server.listen(currentPort, '127.0.0.1');
    return;
  }
  console.error(err.code === 'EADDRINUSE'
    ? `连续 ${MAX_TRIES} 个端口都被占用，请用 SF_PORT 指定一个空闲端口。`
    : `启动失败：${err.message}`);
  process.exit(1);
});

server.listen(currentPort, '127.0.0.1', () => {
  const url = `http://127.0.0.1:${currentPort}/`;
  console.log('粘液科技配方树助手已启动：');
  console.log(`  ${url}`);
  if (attempt > 0) console.log(`（${START_PORT} 被占用，已自动改用 ${currentPort}）`);
  console.log('按 Ctrl+C 可停止服务。');
  if (process.env.SF_OPEN_URL === '1') {
    import('node:child_process').then(({ spawn }) => {
      spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
    });
  }
});
