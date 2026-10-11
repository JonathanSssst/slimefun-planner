#!/usr/bin/env node
/**
 * 同步仓库元信息（About 描述 / Homepage / Topics）。
 *
 * 为什么不用 PowerShell：PowerShell 5.1 会把中文按本地编码发出去，导致 GitHub 上显示乱码。
 * 这个脚本用 Node 的 fetch，请求体强制 UTF-8，读的也是 UTF-8 JSON 文件。
 *
 * 用法：
 *   node tools/set-repo-meta.mjs [--repo=owner/name] [--file=tools/repo-meta.json]
 *
 * 如果报 `unable to verify the first certificate`，加一个 flag 用系统证书库：
 *   node --use-system-ca tools/set-repo-meta.mjs
 *
 * 凭据：从 git credential（Windows Git Credential Manager）里取，无需额外配置。
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const root = resolve(join(dirname(fileURLToPath(import.meta.url)), '..'));

function arg(name, fallback) {
  const hit = process.argv.find((value) => value.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}

function gitCredential() {
  const input = 'protocol=https\nhost=github.com\n\n';
  const output = execFileSync('git', ['credential', 'fill'], {
    input,
    encoding: 'utf8',
    env: { ...process.env, GCM_INTERACTIVE: 'never' },
  });
  const match = output.match(/^password=(.+)$/m);
  if (!match) throw new Error('没能从 git credential 里取到 GitHub 凭据，请先 git push 一次完成登录');
  return match[1].trim();
}

async function main() {
  const repo = arg('repo', 'JonathanSssst/slimefun-planner');
  const file = arg('file', 'tools/repo-meta.json');
  const meta = JSON.parse(readFileSync(join(root, file), 'utf8'));
  const token = gitCredential();

  const headers = {
    Authorization: `token ${token}`,
    'User-Agent': 'slimefun-planner-meta',
    Accept: 'application/vnd.github+json',
    'Content-Type': 'application/json; charset=utf-8',
  };

  const patchBody = JSON.stringify({
    description: meta.description,
    homepage: meta.homepage,
  });
  const patch = await fetch(`https://api.github.com/repos/${repo}`, {
    method: 'PATCH',
    headers,
    body: Buffer.from(patchBody, 'utf8'),
  });
  if (!patch.ok) throw new Error(`更新描述失败：HTTP ${patch.status} ${await patch.text()}`);
  const updated = await patch.json();
  console.log('description:', updated.description);
  console.log('homepage   :', updated.homepage);

  if (Array.isArray(meta.topics) && meta.topics.length > 0) {
    // GitHub 的 topic 只允许小写字母、数字和连字符；中文会被拒
    const names = meta.topics
      .map((topic) => String(topic).trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, ''))
      .filter(Boolean);
    const put = await fetch(`https://api.github.com/repos/${repo}/topics`, {
      method: 'PUT',
      headers: { ...headers, Accept: 'application/vnd.github.mercy-preview+json' },
      body: Buffer.from(JSON.stringify({ names }), 'utf8'),
    });
    if (!put.ok) throw new Error(`更新 topics 失败：HTTP ${put.status} ${await put.text()}`);
    const topics = await put.json();
    console.log('topics     :', (topics.names || []).join(', '));
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
