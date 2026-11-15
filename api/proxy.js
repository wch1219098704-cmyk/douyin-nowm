// api/proxy.js — 字节流转发（Node Runtime + 流式响应）
//
// 说明：原方案是 Edge Runtime（export const config = { runtime: 'edge' }），
// 但 Vercel 2026 已弃用 Edge Runtime，匿名/临时部署直接报
// "The Edge runtime is deprecated and cannot be used for anonymous deployments"。
// 因此改用 Node Runtime + `Readable.fromWeb(...).pipe(res)` 流式转发，
// maxDuration 提到 60s，视频不会被默认的 10s 函数超时截断。
import { Readable } from 'node:stream';

export const config = { maxDuration: 60 };

const UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_1 like Mac OS X) AppleWebKit/605.1.15 ' +
  '(KHTML, like Gecko) Version/17.1 Mobile/15E148 Safari/604.1';

// 只透传这些头，别把上游传输层头带回来
const PASS = [
  'content-type',
  'content-length',
  'content-range',
  'accept-ranges',
  'etag',
  'last-modified',
];

function bad(res, message, status = 400) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify({ ok: false, error: message }));
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Range, Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges');

  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    return res.end();
  }

  // Vercel 会自动解析 query；本地/其他环境兜底手解一次
  const query = req.query || {};
  let target = query.url;
  if (Array.isArray(target)) target = target[0];
  if (!target) {
    try {
      target = new URL(req.url, 'http://localhost').searchParams.get('url');
    } catch {}
  }
  if (!target) return bad(res, '缺少 url 参数');

  let parsed;
  try {
    parsed = new URL(target);
  } catch {
    return bad(res, 'url 不是合法地址');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return bad(res, '只支持 http/https');
  }

  const headers = {
    'User-Agent': UA,
    Referer: 'https://www.douyin.com/',
    Accept: '*/*',
  };
  if (req.headers.range) headers.Range = req.headers.range;

  let upstream;
  try {
    upstream = await fetch(parsed.toString(), { headers, redirect: 'follow' });
  } catch (e) {
    return bad(res, `上游请求失败：${e.message}`, 502);
  }

  res.statusCode = upstream.status; // 206 原样透出
  for (const key of PASS) {
    const value = upstream.headers.get(key);
    if (value) res.setHeader(key, value);
  }
  if (!res.getHeader('cache-control')) {
    res.setHeader('Cache-Control', 'public, max-age=3600');
  }

  if (req.method === 'HEAD' || !upstream.body) return res.end();

  // 流式转发：不整段 buffer，边下边发
  Readable.fromWeb(upstream.body).pipe(res);
}
