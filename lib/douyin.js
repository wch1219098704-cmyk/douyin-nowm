// lib/douyin.js — 抖音分享链接解析核心（零依赖，纯 fetch）
//
// 链路：
//   1) v.douyin.com 短链 302 → iesdouyin 分享页（带 share_sign / from_ssr）
//   2) 分享页的 SSR 数据在 <script>window._ROUTER_DATA = {...}</script>
//   3) 但 SSR 只在带 ttwid Cookie 时才会吐出 item_list —— 没有 Cookie 就只有页面骨架
//      所以必须先建立会话 Cookie（短链/分享页的 set-cookie，必要时向 ttwid 注册接口申请）
//   4) play_addr.uri → https://aweme.snssdk.com/aweme/v1/play/?line=0&ratio=1080p&video_id={uri}
//      playwm → play 即无水印；1080p 拿不到再降级 720p
//   5) 图集（aweme_type=2）：videos 必须为空，images 取每张图 url_list 的最后一项

const MOBILE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_1 like Mac OS X) AppleWebKit/605.1.15 ' +
  '(KHTML, like Gecko) Version/17.1 Mobile/15E148 Safari/604.1';

const SHORT_RE = /https?:\/\/v\.douyin\.com\/[A-Za-z0-9_-]+\/?/;
const ID_RE = /\/(?:video|note|slides)\/(\d{6,})/;

export class DouyinError extends Error {
  constructor(message, code = 'PARSE_FAILED') {
    super(message);
    this.name = 'DouyinError';
    this.code = code;
  }
}

/** 从整段分享口令里抠出第一条抖音链接 */
export function extractUrl(text) {
  if (!text || typeof text !== 'string') throw new DouyinError('请粘贴抖音分享口令或链接', 'EMPTY');
  const t = text.trim();
  const m = t.match(SHORT_RE);
  if (m) return m[0];
  const any = t.match(/https?:\/\/[^\s，。、；！？"']+/);
  if (any) return any[0];
  throw new DouyinError('这段文本里没有找到链接', 'NO_URL');
}

/* ------------------------------- Cookie ------------------------------- */

class CookieJar {
  constructor() {
    this.map = new Map();
  }

  /** 合并一个响应里的 set-cookie */
  absorb(headers) {
    let list = [];
    if (typeof headers.getSetCookie === 'function') list = headers.getSetCookie();
    if (!list || list.length === 0) {
      const raw = headers.get('set-cookie');
      if (raw) list = raw.split(/,(?=\s*[A-Za-z0-9_\-]+=)/);
    }
    for (const line of list) {
      const kv = String(line).split(';')[0];
      const i = kv.indexOf('=');
      if (i > 0) this.map.set(kv.slice(0, i).trim(), kv.slice(i + 1).trim());
    }
    return this;
  }

  get(name) {
    return this.map.get(name);
  }

  toString() {
    return [...this.map.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  }
}

/** 向字节 ttwid 注册接口申请一个访客 Cookie（拿 SSR 数据的关键） */
async function bootstrapTtwid(jar) {
  try {
    const res = await fetch('https://ttwid.bytedance.com/ttwid/union/register/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': MOBILE_UA },
      body: JSON.stringify({
        region: 'cn',
        aid: 1768,
        needFid: false,
        service: 'www.ixigua.com',
        migrate_info: { ticket: '', source: 'node' },
        union: true,
      }),
    });
    jar.absorb(res.headers);
  } catch {
    // 申请失败不致命：可能短链那一跳已经给了 ttwid
  }
  return jar;
}

/* ------------------------------- 抓取 ------------------------------- */

async function getSharePage(shortUrl, jar) {
  // 第一跳：短链（手动重定向，才能拿到 set-cookie 与 location）
  let res = await fetch(shortUrl, {
    redirect: 'manual',
    headers: { 'User-Agent': MOBILE_UA },
  });
  jar.absorb(res.headers);
  let location = res.headers.get('location') || '';

  // 有些短链会多跳一次
  for (let hop = 0; hop < 3 && location && !location.includes('iesdouyin.com'); hop++) {
    const next = await fetch(location, {
      redirect: 'manual',
      headers: { 'User-Agent': MOBILE_UA, Cookie: jar.toString() },
    });
    jar.absorb(next.headers);
    const l2 = next.headers.get('location');
    if (!l2) break;
    location = l2;
  }

  if (!location) throw new DouyinError('短链没有跳转，可能已失效', 'BAD_SHORT_URL');
  if (!jar.get('ttwid')) await bootstrapTtwid(jar);

  const page = await fetch(location, {
    headers: {
      'User-Agent': MOBILE_UA,
      'Accept-Language': 'zh-CN,zh;q=0.9',
      Referer: 'https://www.douyin.com/',
      Cookie: jar.toString(),
    },
  });
  jar.absorb(page.headers);
  const html = await page.text();
  return { html, location };
}

/** 从 HTML 里取 _ROUTER_DATA（做括号配对，避免被字符串里的 } 截断） */
function extractRouterData(html) {
  const marker = '_ROUTER_DATA';
  const at = html.indexOf(marker);
  if (at < 0) return null;
  const start = html.indexOf('{', at);
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < html.length; i++) {
    const c = html[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) {
      try {
        return JSON.parse(html.slice(start, i + 1));
      } catch {
        return null;
      }
    }
  }
  return null;
}

function pickItem(router) {
  const loader = (router && router.loaderData) || {};
  for (const key of Object.keys(loader)) {
    const node = loader[key];
    if (!node || typeof node !== 'object') continue;
    const info = node.videoInfoRes;
    if (info && Array.isArray(info.item_list) && info.item_list.length) return info.item_list[0];
  }
  // 图集/笔记页的 key 不同，兜底再扫一遍
  for (const key of Object.keys(loader)) {
    const node = loader[key];
    if (!node || typeof node !== 'object') continue;
    const info = node.videoInfoRes;
    if (info && Array.isArray(info.filter_list) && info.filter_list.length) return info.filter_list[0];
  }
  return null;
}

/* ------------------------------- 直链 ------------------------------- */

const VALID_URL = (u) => /aweme\/v1\/play|douyinvod|\.mp4/i.test(u);

/** 由 uri 拼播放地址；playwm → play 即无水印 */
function buildPlayUrl(uri, ratio = '1080p') {
  if (!uri) return '';
  return (
    `https://aweme.snssdk.com/aweme/v1/play/?line=0&ratio=${ratio}&video_id=${encodeURIComponent(uri)}`
  );
}

/** 探测直链可下载性与体积：Range 请求只取 1 字节，从 Content-Range 读总长 */
async function probe(url) {
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': MOBILE_UA,
        Referer: 'https://www.douyin.com/',
        Range: 'bytes=0-0',
      },
      redirect: 'follow',
    });
    if (!res.ok && res.status !== 206) return { ok: false, size: 0 };
    const cr = res.headers.get('content-range') || '';
    const total = Number((cr.split('/')[1] || '0').trim()) || Number(res.headers.get('content-length')) || 0;
    try {
      await res.body?.cancel();
    } catch {}
    return { ok: true, size: total };
  } catch {
    return { ok: false, size: 0 };
  }
}

/* ------------------------------- 组装 ------------------------------- */

function uniq(arr) {
  return [...new Set(arr.filter(Boolean))];
}

function getImages(item) {
  const out = [];
  for (const img of item.images || []) {
    const list = (img && img.url_list) || [];
    if (list.length) out.push(list[list.length - 1]);
  }
  return uniq(out);
}

function getMusic(item) {
  const m = item.music || {};
  const list = (m.play_url && m.play_url.url_list) || [];
  if (!list.length) return [];
  return [{ title: m.title || '', author: m.author || '', url: list[0] }];
}

/**
 * 解析抖音分享链接
 * @param {string} text 分享口令或链接
 * @returns {Promise<object>} Media
 */
export async function parseDouyin(text) {
  const shortUrl = extractUrl(text);
  const jar = new CookieJar();
  const { html } = await getSharePage(shortUrl, jar);

  let router = extractRouterData(html);
  let item = router ? pickItem(router) : null;

  // 会话没建立起来时，重新申请 ttwid 再试一次
  if (!item) {
    await bootstrapTtwid(jar);
    const retry = await fetch(
      html.match(/<link rel="canonical" href="([^"]+)"/)?.[1] || shortUrl,
      { headers: { 'User-Agent': MOBILE_UA, Cookie: jar.toString(), Referer: 'https://www.douyin.com/' } },
    );
    router = extractRouterData(await retry.text());
    item = router ? pickItem(router) : null;
  }

  if (!item) {
    throw new DouyinError('没拿到作品数据（分享页未返回 SSR 数据），请确认链接可正常打开', 'NO_ITEM');
  }

  const awemeId = item.aweme_id || (html.match(ID_RE) || [])[1] || '';
  const video = item.video || {};
  const music = getMusic(item);
  const isAlbum = Number(item.aweme_type) === 2 || (Array.isArray(item.images) && item.images.length > 0);

  const base = {
    platform: 'douyin',
    title: (item.desc || '').trim(),
    author: ((item.author && item.author.nickname) || '').trim(),
    cover:
      (video.cover && video.cover.url_list && video.cover.url_list[0]) ||
      (video.origin_cover && video.origin_cover.url_list && video.origin_cover.url_list[0]) ||
      '',
    videos: [],
    images: [],
    music,
    extra: {
      aweme_id: awemeId,
      aweme_type: item.aweme_type,
      duration: video.duration || 0,
      ratio: null,
      size_bytes: 0,
      source: 'iesdouyin-ssr',
    },
  };

  // 图集：videos 必须为空
  if (isAlbum) {
    base.images = getImages(item);
    if (!base.images.length) throw new DouyinError('图集里没有拿到图片', 'NO_IMAGE');
    return base;
  }

  const play = video.play_addr || {};
  const uri = play.uri || '';
  const origin = (play.url_list && play.url_list[0]) || '';

  // 优先用 uri 重建 1080p 地址；没有 uri 就退回 url_list 里的地址改参数
  let candidate = buildPlayUrl(uri, '1080p');
  if (!candidate && origin) candidate = origin.replace(/ratio=\d+p/, 'ratio=1080p');

  let chosen = candidate.replace('/playwm/', '/play/').replace('playwm', 'play');
  let probed = await probe(chosen);

  // 1080p 不通就降级 720p
  if (!probed.ok) {
    const fallback = (uri ? buildPlayUrl(uri, '720p') : origin.replace(/ratio=\d+p/, 'ratio=720p'))
      .replace('/playwm/', '/play/')
      .replace('playwm', 'play');
    const p2 = await probe(fallback);
    if (p2.ok) {
      chosen = fallback;
      probed = p2;
      base.extra.ratio = '720p';
    } else {
      throw new DouyinError('视频直链不可用（1080p/720p 都取不到）', 'NO_PLAY_URL');
    }
  } else {
    base.extra.ratio = '1080p';
  }

  if (!VALID_URL(chosen)) throw new DouyinError('直链校验失败，不是抖音播放地址', 'BAD_PLAY_URL');

  base.videos = [chosen];
  base.extra.size_bytes = probed.size || 0;
  return base;
}
