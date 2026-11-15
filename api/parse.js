// api/parse.js — 解析接口（Node Runtime）
// POST body: {"text":"分享口令"} → {ok:true,data:Media} / 400 {ok:false,error:"人话原因"}
import { parseDouyin, DouyinError } from '../lib/douyin.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: '只支持 POST' });
  }

  let body = req.body;
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body);
    } catch {
      body = {};
    }
  }
  const text = body && body.text;
  if (!text || typeof text !== 'string') {
    return res.status(400).json({ ok: false, error: '缺少 text 字段（分享口令原文）' });
  }

  try {
    const data = await parseDouyin(text);
    return res.status(200).json({ ok: true, data });
  } catch (e) {
    const msg = e instanceof DouyinError ? e.message : `解析失败：${e.message || e}`;
    return res.status(400).json({ ok: false, error: msg });
  }
}
