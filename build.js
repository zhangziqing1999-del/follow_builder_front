#!/usr/bin/env node

// ============================================================================
// BuilderSearch — Daily Digest Builder
// Fetches feed data from follow-builders and generates index.html
// Usage: node build.js
// ============================================================================

import { writeFileSync, readFileSync, mkdirSync, existsSync, copyFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const FEED_X_URL = 'https://raw.githubusercontent.com/zarazhangrui/follow-builders/main/feed-x.json';
const FEED_PODCASTS_URL = 'https://raw.githubusercontent.com/zarazhangrui/follow-builders/main/feed-podcasts.json';

// -- Fetch feeds --
async function fetchJSON(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch ${url}: ${res.status}`);
  return res.json();
}

// -- Date helpers --
function getDateStr() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}.${m}.${d}`;
}

// -- Categorize tweets by keywords --
const CATEGORIES = [
  {
    name: 'Agent 架构与框架',
    icon: 'A', gradient: 'linear-gradient(135deg,#4f46e5,#7c3aed)',
    keywords: ['agent', 'framework', '架构', 'mcp', 'tool', 'sdk', 'infrastructure', 'langchain', 'sandbox', 'runtime', 'protocol']
  },
  {
    name: '产品案例与实战',
    icon: 'P', gradient: 'linear-gradient(135deg,#f97316,#ef4444)',
    keywords: ['product', 'ship', 'launch', 'user', 'mvp', 'app', 'demo', 'prototype', 'design', 'ux', 'feature', 'vibe cod']
  },
  {
    name: '平台与生态动态',
    icon: 'E', gradient: 'linear-gradient(135deg,#10b981,#059669)',
    keywords: ['platform', 'api', 'openai', 'anthropic', 'claude', 'gpt', 'google', 'next.js', 'vercel', 'replit', 'cursor', 'copilot', 'model', 'release']
  },
  {
    name: '行业信号与洞察',
    icon: 'S', gradient: 'linear-gradient(135deg,#8b5cf6,#7c3aed)',
    keywords: ['funding', 'raise', 'invest', 'trend', 'future', 'opinion', 'advice', 'lesson', 'insight', 'prediction', 'market']
  }
];

function categorize(text) {
  const lower = text.toLowerCase();
  let best = null, bestScore = 0;
  for (const cat of CATEGORIES) {
    const score = cat.keywords.filter(k => lower.includes(k)).length;
    if (score > bestScore) { bestScore = score; best = cat; }
  }
  return best || CATEGORIES[3];
}

// -- Keyword tag generation --
const KW_CLASSES = ['kw-hot', 'kw-new', 'kw-trend', 'kw-insight', 'kw-warn'];
// Tech terms preserved in Chinese translations
const TECH_TERMS = ['agent','agents','LLM','API','MCP','RAG','GPT','Claude','OpenAI','Anthropic',
  'token','tokens','prompt','prompts','fine-tuning','vibe','coding','model','models','inference',
  'embedding','vector','pipeline','workflow','tool','tools','memory','context','multimodal','RL'];
function extractKeywords(text) {
  const clean = text.replace(/https?:\/\/\S+/g, '');
  // Extract preserved English tech terms first
  const techFound = TECH_TERMS.filter(t => new RegExp('\\b' + t + '\\b', 'i').test(clean))
    .slice(0, 3);
  if (techFound.length >= 2) {
    return techFound.slice(0, 3).map((t, i) => ({ text: t, cls: KW_CLASSES[i % KW_CLASSES.length] }));
  }
  // Fallback: frequency-based on space-separated words (works for English, picks up tech terms in Chinese)
  const words = clean.split(/[\s,.!?;:，。！？；：""''【】《》\u3000]+/).filter(w => w.length > 2 && /[a-zA-Z]/.test(w));
  const freq = {};
  words.forEach(w => { freq[w] = (freq[w] || 0) + 1; });
  const top = Object.entries(freq).sort((a, b) => b[1] - a[1]).slice(0, 3);
  return top.length ? top.map((e, i) => ({ text: e[0], cls: KW_CLASSES[i % KW_CLASSES.length] }))
    : techFound.map((t, i) => ({ text: t, cls: KW_CLASSES[i % KW_CLASSES.length] }));
}

// -- Heat bar width --
function heatWidth(likes, maxLikes) {
  return Math.max(5, Math.round((likes / maxLikes) * 100));
}

// -- Escape HTML --
function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// -- Load .env.local if present --
function loadEnvLocal() {
  const envPath = join(__dirname, '.env.local');
  if (!existsSync(envPath)) return;
  const lines = readFileSync(envPath, 'utf-8').split('\n');
  for (const line of lines) {
    const m = line.match(/^([A-Z_]+)=(.+)/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  }
}

// -- Translate all content via Alibaba Cloud DashScope (DeepSeek-V3) --
async function translateAllContent(feedX, feedPodcasts) {
  loadEnvLocal();
  const apiKey = process.env.ALIBABA_API_KEY || process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.log('No API key set (ALIBABA_API_KEY or ANTHROPIC_API_KEY), content will be in English.');
    return { byUrl: new Map(), podcast: null };
  }
  const isAlibaba = !!process.env.ALIBABA_API_KEY;

  const decode = t => t.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"');

  const tweetItems = [];
  for (const user of feedX.x || []) {
    for (const tweet of user.tweets || []) {
      if (tweet.url && tweet.text) {
        tweetItems.push({ url: tweet.url, text: decode(tweet.text) });
      }
    }
  }

  const podcast = (feedPodcasts.podcasts || [])[0];
  const podcastPoints = podcast
    ? (podcast.transcript || '').slice(0, 1000).split(/[.!?]/).filter(s => s.trim().length > 20).slice(0, 5)
    : [];

  const lines = [];
  tweetItems.slice(0, 50).forEach(t => lines.push(`[${t.url}] ${t.text.slice(0, 350)}`));
  if (podcast) {
    lines.push(`[podcast-title] ${podcast.title || ''}`);
    podcastPoints.forEach((p, i) => lines.push(`[podcast-point-${i}] ${p.trim()}`));
  }

  console.log(`Translating ${lines.length} items via ${isAlibaba ? 'Alibaba DashScope (deepseek-v3)' : 'Anthropic'}...`);

  const systemPrompt = `你是一位 AI 行业资深编辑，负责将 AI builders 的推文和播客内容翻译成中文，供中国 AI 产品经理阅读。

翻译规则：
- 先完整理解每条内容，再输出中文翻译
- 译文地道流畅，像懂行的朋友在聊天，不要机械翻译
- 技术术语保留英文：agent, LLM, API, fine-tuning, RAG, token, prompt, vibe coding, MCP 等
- 人名、产品名、公司名保留英文
- 每条翻译控制在1-3句话，抓住核心信息
- 输出格式：逐条输出，每条格式为 [原标识] 中文翻译，每条占一行，不要输出任何额外说明`;

  const userContent = lines.join('\n');

  try {
    let content = '';
    if (isAlibaba) {
      const res = await fetch('https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
        body: JSON.stringify({
          model: 'deepseek-v3',
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userContent }
          ],
          max_tokens: 8192
        })
      });
      const data = await res.json();
      content = data.choices?.[0]?.message?.content || '';
    } else {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 8192, system: systemPrompt, messages: [{ role: 'user', content: userContent }] })
      });
      const data = await res.json();
      content = data.content?.[0]?.text || '';
    }

    const byUrl = new Map();
    const podcastZh = { title_zh: '', points_zh: [] };
    // Robust multi-line parsing: accumulate text until next [key] line
    let currentKey = null, currentVal = [];
    const flush = () => {
      if (!currentKey) return;
      const v = currentVal.join(' ').trim();
      if (!v) return;
      if (currentKey === 'podcast-title') podcastZh.title_zh = v;
      else if (currentKey.startsWith('podcast-point-')) podcastZh.points_zh.push(v);
      else byUrl.set(currentKey, v);
    };
    for (const line of content.split('\n')) {
      const m = line.match(/^\[(.+?)\]\s*(.*)/);
      if (m) { flush(); currentKey = m[1]; currentVal = m[2] ? [m[2]] : []; }
      else if (currentKey && line.trim()) currentVal.push(line.trim());
    }
    flush();

    console.log(`Translated ${byUrl.size} tweets, podcast: ${podcastZh.title_zh ? 'yes' : 'no'}.`);
    return { byUrl, podcast: podcastZh.title_zh ? podcastZh : null };
  } catch (err) {
    console.log('Translation failed:', err.message);
    return { byUrl: new Map(), podcast: null };
  }
}

// -- Build HTML --
function buildHTML(feedX, feedPodcasts, dateStr, translationsByUrl = new Map(), podcastZh = null) {
  // Returns Chinese text by tweet URL, or null if not available
  const trByUrl = (url) => translationsByUrl.get(url) || null;

  const allTweets = [];
  for (const user of feedX.x || []) {
    for (const tweet of user.tweets || []) {
      allTweets.push({
        name: user.name, handle: user.handle, bio: user.bio || '',
        text: tweet.text, url: tweet.url,
        likes: tweet.likes || 0, retweets: tweet.retweets || 0,
        replies: tweet.replies || 0, createdAt: tweet.createdAt
      });
    }
  }

  // Filter out link-only tweets (no readable text content)
  const isLinkOnly = t => t.text.replace(/https?:\/\/\S+/g, '').replace(/\s+/g, '').length < 10;
  const meaningfulTweets = allTweets.filter(t => !isLinkOnly(t));

  meaningfulTweets.sort((a, b) => b.likes - a.likes);
  const maxLikes = meaningfulTweets[0]?.likes || 1;

  const topTweets = meaningfulTweets.slice(0, 9);
  const productInsights = topTweets.slice(0, 3);
  const techInsights = topTweets.slice(3, 6);
  const userInsights = topTweets.slice(6, 9);

  const catGroups = {};
  for (const cat of CATEGORIES) catGroups[cat.name] = { ...cat, items: [] };
  for (const t of meaningfulTweets) {
    const cat = categorize(t.text + ' ' + t.bio);
    catGroups[cat.name].items.push(t);
  }

  const podcasts = feedPodcasts.podcasts || [];
  const topPodcast = podcasts[0];
  const builderCount = (feedX.x || []).length;
  const tweetCount = allTweets.length;
  const podcastCount = podcasts.length;

  function insightCol(title, icon, colorClass, items) {
    let html = `<div class="insight-col">
      <div class="insight-col-header ${colorClass}">
        <div class="col-icon">${icon}</div>${title}
      </div>`;
    for (const t of items) {
      const chipClass = colorClass === 'col-product' ? 'chip-orange' : colorClass === 'col-tech' ? 'chip-purple' : 'chip-green';
      const enText = t.text.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
      const zhText = trByUrl(t.url) || enText;
      const enTitle = esc(enText.slice(0, 80)) + (enText.length > 80 ? '...' : '');
      const zhTitle = esc(zhText.slice(0, 80)) + (zhText.length > 80 ? '...' : '');
      const enDesc = esc(enText.slice(0, 200));
      const zhDesc = esc(zhText.slice(0, 200));
      html += `<div class="insight-card" data-bookmarkable="1">
        <div class="title"><span class="lang-text" data-en="${enTitle}" data-zh="${zhTitle}">${zhTitle}</span></div>
        <div class="desc"><span class="lang-text" data-en="${enDesc}" data-zh="${zhDesc}">${zhDesc}</span></div>
        <div class="insight-bottom">
          <div class="sources"><a class="chip ${chipClass}" href="${esc(t.url || '')}" target="_blank">${esc(t.name || '')} &rarr;</a></div>
        </div>
      </div>`;
    }
    html += '</div>';
    return html;
  }

  function detailCard(t) {
    const enText = t.text.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
    const zhText = trByUrl(t.url) || enText;
    const kws = extractKeywords(zhText);
    const kwHTML = kws.map(k => `<span class="kw ${k.cls}">${esc(k.text)}</span>`).join('');
    const bioparts = t.bio.split(/[|,\n]/).map(s => s.trim()).filter(Boolean).slice(0, 3);
    const idTags = bioparts.map((p, i) => {
      const cls = i === 0 ? 'id-role' : i === 1 ? 'id-company' : 'id-product';
      return `<span class="id-tag ${cls}">${esc(p.slice(0, 30))}</span>`;
    }).join('');

    return `<div class="detail-card">
        <div class="kw-row">${kwHTML}</div>
        <div class="author-row">
          <img class="real-avatar" src="https://unavatar.io/x/${esc(t.handle)}" alt="${esc(t.name)}">
          <div class="author-meta">
            <div class="name">${esc(t.name)}</div>
            <div class="id-row">${idTags}</div>
          </div>
        </div>
        <div class="content"><span class="lang-text" data-en="${esc(enText)}" data-zh="${esc(zhText)}">${esc(zhText)}</span></div>
        <div class="engagement">
          <a class="link-btn" href="${esc(t.url)}" target="_blank">查看原文 &rarr;</a>
          <div class="heat-bar">&#10084; ${t.likes.toLocaleString()}<div class="heat-track"><div class="heat-fill" style="width:${heatWidth(t.likes, maxLikes)}%"></div></div></div>
        </div>
      </div>`;
  }

  function podcastBanner() {
    if (!topPodcast) return '';
    const showName = esc(topPodcast.name || 'Podcast');
    const enTitle = topPodcast.title || 'Podcast';
    const zhTitle = podcastZh?.title_zh || enTitle;
    const url = esc(topPodcast.url || '');

    // Build bilingual points
    const transcript = (topPodcast.transcript || '').slice(0, 1000);
    const enPoints = transcript.split(/[.!?]/).filter(s => s.trim().length > 20).slice(0, 5).map(p => p.trim());
    const zhPoints = podcastZh?.points_zh?.length ? podcastZh.points_zh : enPoints;
    const maxPoints = Math.max(enPoints.length, zhPoints.length);
    let pointsHTML = '';
    for (let i = 0; i < maxPoints; i++) {
      const en = esc(enPoints[i] || zhPoints[i] || '');
      const zh = esc(zhPoints[i] || enPoints[i] || '');
      pointsHTML += `<li><span class="li-icon">&#128161;</span><span class="lang-text" data-en="${en}" data-zh="${zh}">${zh}</span></li>`;
    }

    return `<div class="podcast-banner" id="podcast-banner">
      <div class="podcast-left">
        <div class="podcast-badge">&#127911; ${showName}</div>
        <h3><span class="lang-text" data-en="${esc(enTitle)}" data-zh="${esc(zhTitle)}">${esc(zhTitle)}</span></h3>
        <div class="tagline" style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;">
          <a href="${url}" target="_blank">观看完整内容 &rarr;</a>
          <button class="podcast-bm-btn" id="podcast-bm-btn" title="收藏播客">&#9734; 收藏</button>
        </div>
      </div>
      <div class="podcast-right">
        <ul>${pointsHTML}</ul>
      </div>
    </div>`;
  }

  function catGroupsHTML() {
    let html = '';
    for (const [name, cat] of Object.entries(catGroups)) {
      if (cat.items.length === 0) continue;
      html += `<div class="cat-group">
      <div class="cat-group-header">
        <div class="cat-group-icon" style="background:${cat.gradient};">${cat.icon}</div>
        <h3>${esc(name)}</h3>
        <span class="cat-count">${cat.items.length} 条动态</span>
      </div>
      <div class="detail-grid">${cat.items.slice(0, 6).map(detailCard).join('')}</div>
    </div>`;
    }
    return html;
  }

  const cssFile = join(__dirname, 'template.css');
  let css;
  if (existsSync(cssFile)) {
    css = readFileSync(cssFile, 'utf-8');
  } else {
    const existing = readFileSync(join(__dirname, 'ai-digest.html'), 'utf-8');
    const m = existing.match(/<style>([\s\S]*?)<\/style>/);
    css = m ? m[1] : '';
    writeFileSync(cssFile, css);
  }

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>AI Builders Daily Digest - ${dateStr}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=Noto+Serif+SC:wght@700;900&display=swap" rel="stylesheet">
<style>
${css}

  /* ===== LEFT SIDEBAR ===== */
  .app-layout { display: flex; min-height: 100vh; }
  .left-sidebar {
    width: 220px; position: fixed; top: 0; left: 0; height: 100vh;
    background: #1a1a2e; color: #e2e8f0; overflow-y: auto; z-index: 100;
    border-right: 1px solid rgba(255,255,255,0.06);
  }
  .left-sidebar::-webkit-scrollbar { width: 4px; }
  .left-sidebar::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.15); border-radius: 4px; }
  .sidebar-logo {
    padding: 24px 20px 16px; font-family: 'Noto Serif SC', serif;
    font-size: 15px; font-weight: 900; color: #fff;
    display: flex; align-items: center; gap: 8px;
    border-bottom: 1px solid rgba(255,255,255,0.08);
  }
  .sidebar-back {
    display: flex; align-items: center; gap: 6px; padding: 12px 20px;
    font-size: 13px; color: #94a3b8; cursor: pointer; transition: all 0.2s;
    border: none; background: none; width: 100%; text-align: left; font-family: inherit;
  }
  .sidebar-back:hover { color: #fff; background: rgba(255,255,255,0.05); }
  .sidebar-section {
    padding: 16px 16px 8px; font-size: 11px; font-weight: 700;
    color: #64748b; text-transform: uppercase; letter-spacing: 1px;
  }
  .date-item {
    display: flex; align-items: center; gap: 10px; padding: 10px 20px;
    cursor: pointer; transition: all 0.2s; border: none; background: none;
    width: 100%; text-align: left; font-family: inherit; color: #cbd5e1; font-size: 13px;
  }
  .date-item:hover { background: rgba(255,255,255,0.06); color: #fff; }
  .date-item.active { background: rgba(99,102,241,0.2); color: #a5b4fc; border-left: 3px solid #6366f1; }
  .date-item .date-label { flex: 1; }
  .date-tag { font-size: 10px; padding: 2px 8px; border-radius: 10px; font-weight: 600; }
  .date-tag-today { background: rgba(99,102,241,0.3); color: #a5b4fc; }
  .date-tag-past { background: rgba(255,255,255,0.08); color: #94a3b8; }
  .sidebar-divider { height: 1px; background: rgba(255,255,255,0.08); margin: 12px 16px; }
  .fav-nav-btn {
    display: flex; align-items: center; gap: 10px; padding: 10px 20px;
    cursor: pointer; transition: all 0.2s; border: none; background: none;
    width: 100%; text-align: left; font-family: inherit; color: #fbbf24; font-size: 13px; font-weight: 600;
  }
  .fav-nav-btn:hover { background: rgba(255,255,255,0.06); }
  .fav-nav-btn.active { background: rgba(251,191,36,0.15); border-left: 3px solid #fbbf24; }
  .fav-badge {
    font-size: 10px; background: rgba(251,191,36,0.25); color: #fbbf24;
    padding: 1px 6px; border-radius: 8px; font-weight: 800; margin-left: auto;
  }

  /* ===== MAIN CONTENT ===== */
  .main-content { margin-left: 220px; flex: 1; min-height: 100vh; }
  .main-content .page { max-width: 1100px; margin: 0 auto; padding: 32px 24px; }

  /* History view */
  .history-main-view { max-width: 1100px; margin: 0 auto; padding: 32px 24px; }
  .history-header { display: flex; align-items: center; gap: 16px; margin-bottom: 24px; }
  .history-header h2 { font-family: 'Noto Serif SC', serif; font-size: 22px; font-weight: 900; }
  .history-date-badge {
    background: linear-gradient(135deg, #4f46e5, #7c3aed); color: #fff;
    padding: 4px 14px; border-radius: 20px; font-size: 13px; font-weight: 600;
  }
  .history-insights-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px; margin-bottom: 24px; }
  .history-insight-card {
    background: var(--card); border-radius: var(--radius); border: 1px solid var(--border); padding: 16px;
  }
  .history-insight-card .hi-cat { font-size: 11px; font-weight: 700; margin-bottom: 4px; }
  .history-insight-card .hi-title { font-size: 14px; font-weight: 700; margin-bottom: 6px; }
  .history-insight-card .hi-desc { font-size: 12px; color: var(--text2); line-height: 1.6; }
  .history-detail-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 16px; }

  /* Favorites view */
  .fav-main-view { max-width: 1100px; margin: 0 auto; padding: 32px 24px; }
  .fav-header { display: flex; align-items: center; gap: 16px; margin-bottom: 20px; }
  .fav-header h2 { font-family: 'Noto Serif SC', serif; font-size: 22px; font-weight: 900; }
  .fav-filters { display: flex; gap: 8px; margin-bottom: 20px; flex-wrap: wrap; }
  .fav-filter-btn {
    padding: 6px 16px; border-radius: 20px; border: 1px solid var(--border);
    background: var(--card); cursor: pointer; font-family: inherit;
    font-size: 12px; font-weight: 600; color: var(--text2); transition: all 0.2s;
  }
  .fav-filter-btn:hover { border-color: var(--accent); color: var(--accent); }
  .fav-filter-btn.active { background: var(--accent); color: #fff; border-color: var(--accent); }
  .fav-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 16px; }
  .fav-card {
    background: var(--card); border-radius: var(--radius); border: 1px solid var(--border);
    padding: 16px; transition: all 0.2s;
  }
  .fav-card:hover { box-shadow: 0 4px 16px rgba(0,0,0,0.06); }
  .fav-top-row { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
  .fav-date-label { font-size: 11px; color: var(--text3); flex: 1; }
  .fav-status-select {
    font-size: 10px; padding: 2px 6px; border-radius: 6px;
    border: 1px solid var(--border); font-family: inherit; cursor: pointer;
  }
  .fav-remove-btn {
    width: 24px; height: 24px; border: none; background: #fee2e2; color: #ef4444;
    border-radius: 6px; cursor: pointer; font-size: 14px;
    display: flex; align-items: center; justify-content: center;
  }
  .fav-remove-btn:hover { background: #fecaca; }
  .fav-empty-msg { text-align: center; padding: 60px 20px; color: var(--text3); font-size: 14px; }

  /* Language toggle button */
  .lang-btn {
    padding: 4px 14px; border-radius: 20px; border: 1.5px solid rgba(255,255,255,0.5);
    background: rgba(255,255,255,0.15); color: #fff; font-size: 12px; font-weight: 700;
    cursor: pointer; font-family: inherit; transition: all 0.2s; letter-spacing: 0.5px;
  }
  .lang-btn:hover { background: rgba(255,255,255,0.3); }

  /* Podcast bookmark button */
  .podcast-bm-btn {
    border: 1.5px solid #f9a8d4; background: rgba(157,23,77,0.08); color: #9d174d;
    border-radius: 6px; padding: 5px 12px; cursor: pointer; font-size: 13px;
    font-weight: 600; transition: all 0.2s;
  }
  .podcast-bm-btn:hover { background: rgba(157,23,77,0.15); border-color: #f472b6; }
  .podcast-bm-btn.bookmarked { background: rgba(157,23,77,0.2); color: #be185d; border-color: #ec4899; }

  /* Bookmark buttons */
  .insight-bottom { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
  .insight-bm-btn, .bm-btn {
    width: 26px; height: 26px; border: none; background: #f3f4f6; border-radius: 6px;
    cursor: pointer; font-size: 13px; display: flex; align-items: center;
    justify-content: center; transition: all 0.2s; flex-shrink: 0;
  }
  .insight-bm-btn:hover, .bm-btn:hover { background: #fef3c7; }
  .insight-bm-btn.bookmarked, .bm-btn.bookmarked { background: #fef3c7; }

  /* Mobile */
  .mobile-menu-btn {
    display: none; position: fixed; top: 12px; left: 12px; z-index: 200;
    width: 40px; height: 40px; border: none; background: #1a1a2e; color: #fff;
    border-radius: 10px; font-size: 18px; cursor: pointer;
    align-items: center; justify-content: center; box-shadow: 0 2px 12px rgba(0,0,0,0.2);
  }
  .mobile-overlay {
    position: fixed; top: 0; left: 0; right: 0; bottom: 0;
    background: rgba(0,0,0,0.4); z-index: 999;
    opacity: 0; pointer-events: none; transition: opacity 0.3s;
  }
  .mobile-overlay.open { opacity: 1; pointer-events: auto; }
  @media (max-width: 768px) {
    .left-sidebar { transform: translateX(-100%); transition: transform 0.3s ease; z-index: 1000; }
    .left-sidebar.mobile-open { transform: translateX(0); }
    .main-content { margin-left: 0; }
    .mobile-menu-btn { display: flex; }
    .history-insights-grid { grid-template-columns: 1fr; }
  }
</style>
</head>
<body>

<button class="mobile-menu-btn" id="mobile-menu-btn" onclick="toggleMobileMenu()">&#9776;</button>
<div class="mobile-overlay" id="mobile-overlay" onclick="toggleMobileMenu()"></div>

<div class="app-layout">
  <div class="left-sidebar" id="left-sidebar">
    <div class="sidebar-logo">&#128218; 日期目录</div>
    <button class="sidebar-back" id="back-home" onclick="showToday()">&#8592; 返回首页</button>
    <div class="sidebar-section">历史记录</div>
    <div id="date-list"></div>
    <div class="sidebar-divider"></div>
    <button class="fav-nav-btn" id="fav-nav-btn" onclick="showFavorites()">
      &#11088; 收藏 <span class="fav-badge" id="badge-fav">0</span>
    </button>
  </div>

  <div class="main-content">
    <div id="today-view">
      <div class="page">
        <div class="header">
          <div class="header-inner">
            <div>
              <h1>AI Builders Daily Digest</h1>
              <div class="sub">AI 产品经理每日必读 | 追踪真正在构建产品的人</div>
            </div>
            <div class="stats-bar">
              <span class="stat-pill">${dateStr}</span>
              <span class="stat-pill">${builderCount} 位构建者</span>
              <span class="stat-pill">${tweetCount} 条动态</span>
              <span class="stat-pill">${podcastCount} 期播客</span>
              <button class="lang-btn" id="lang-toggle" onclick="toggleLang()">EN</button>
            </div>
          </div>
        </div>
        <div class="insights-grid">
${insightCol('产品应用启示', 'P', 'col-product', productInsights)}
${insightCol('技术启示', 'T', 'col-tech', techInsights)}
${insightCol('用户与市场启示', 'U', 'col-user', userInsights)}
        </div>
        <div class="section-divider">信息源详情</div>
        ${podcastBanner()}
        ${catGroupsHTML()}
        <div class="footer">
          Powered by <a href="https://github.com/zarazhangrui/follow-builders" target="_blank">Follow Builders</a> | 关注构建者，而非网红
        </div>
      </div>
    </div>
    <div id="history-view" style="display:none"></div>
    <div id="favorites-view" style="display:none"></div>
  </div>
</div>

<script>
const TODAY_KEY = document.querySelector('title').textContent.match(/[\\d.]+/)?.[0] || new Date().toISOString().slice(0,10).replace(/-/g,'.');
let currentView = 'today';

function toggleMobileMenu() {
  document.getElementById('left-sidebar').classList.toggle('mobile-open');
  document.getElementById('mobile-overlay').classList.toggle('open');
}
function closeMobileMenu() {
  document.getElementById('left-sidebar').classList.remove('mobile-open');
  document.getElementById('mobile-overlay').classList.remove('open');
}

function showToday() {
  currentView = 'today';
  document.getElementById('today-view').style.display = '';
  document.getElementById('history-view').style.display = 'none';
  document.getElementById('favorites-view').style.display = 'none';
  highlightDateItem(TODAY_KEY);
  document.getElementById('fav-nav-btn').classList.remove('active');
  closeMobileMenu();
}

function showHistoryDay(dateKey) {
  if (dateKey === TODAY_KEY) { showToday(); return; }
  currentView = 'history';
  const history = JSON.parse(localStorage.getItem('digest-history') || '{}');
  const day = history[dateKey]; if (!day) return;
  document.getElementById('today-view').style.display = 'none';
  document.getElementById('favorites-view').style.display = 'none';
  const view = document.getElementById('history-view');
  view.style.display = '';
  highlightDateItem(dateKey);
  document.getElementById('fav-nav-btn').classList.remove('active');

  const catLabels = { product: '产品应用', tech: '技术', user: '用户与市场' };
  const catCls = { product: '#f97316', tech: '#6366f1', user: '#059669' };

  let html = '<div class="history-main-view">';
  html += '<div class="history-header"><h2>&#128218; 历史回顾</h2><span class="history-date-badge">' + dateKey + '</span></div>';

  if (day.insights && day.insights.length) {
    html += '<div style="font-size:13px;font-weight:700;color:var(--accent);margin-bottom:12px;">&#128161; 核心启示</div>';
    html += '<div class="history-insights-grid">';
    day.insights.forEach(function(ins) {
      var cat = catLabels[ins.category] || '启示';
      var color = catCls[ins.category] || '#6366f1';
      html += '<div class="history-insight-card">' +
        '<div class="hi-cat" style="color:' + color + ';">' + cat + '</div>' +
        '<div class="hi-title">' + (ins.title || '') + '</div>' +
        '<div class="hi-desc">' + (ins.content || '') + '</div>' +
        (ins.link ? '<a href="' + ins.link + '" target="_blank" style="font-size:11px;margin-top:6px;display:inline-block;">' + (ins.authorName || '') + ' &rarr;</a>' : '') +
      '</div>';
    });
    html += '</div>';
  }

  if (day.podcast) {
    html += '<div style="font-size:13px;font-weight:700;color:var(--text2);margin:24px 0 12px;">&#127911; 播客精选</div>';
    html += buildPodcastCardHTML(day.podcast, false);
  }

  if (day.cards && day.cards.length) {
    html += '<div style="font-size:13px;font-weight:700;color:var(--text2);margin:24px 0 12px;">&#128196; 信息源详情</div>';
    html += '<div class="history-detail-grid">';
    day.cards.forEach(function(c) { html += buildCardHTML(c); });
    html += '</div>';
  }

  html += '</div>';
  view.innerHTML = html;
  closeMobileMenu();
  window.scrollTo(0, 0);
}

function showFavorites() {
  currentView = 'favorites';
  document.getElementById('today-view').style.display = 'none';
  document.getElementById('history-view').style.display = 'none';
  document.getElementById('favorites-view').style.display = '';
  document.querySelectorAll('.date-item').forEach(function(d) { d.classList.remove('active'); });
  document.getElementById('fav-nav-btn').classList.add('active');
  renderFavorites();
  closeMobileMenu();
  window.scrollTo(0, 0);
}

function highlightDateItem(dateKey) {
  document.querySelectorAll('.date-item').forEach(function(d) {
    d.classList.toggle('active', d.dataset.date === dateKey);
  });
}

function extractPodcastData() {
  var banner = document.getElementById('podcast-banner');
  if (!banner) return null;
  var title = banner.querySelector('h3')?.textContent || '';
  var showName = banner.querySelector('.podcast-badge')?.textContent?.trim() || 'Podcast';
  var url = banner.querySelector('.tagline a')?.href || '';
  var points = [];
  banner.querySelectorAll('li').forEach(function(li) { points.push(li.textContent.replace('💡','').trim()); });
  return { type: 'podcast', title: title, showName: showName, url: url, points: points, id: 'podcast-' + btoa(encodeURIComponent(title.slice(0, 50))) };
}

function extractInsightData(card) {
  var title = card.querySelector('.title')?.textContent || '';
  var desc = card.querySelector('.desc')?.textContent || '';
  var chipEl = card.querySelector('.chip');
  var link = chipEl?.href || '';
  var authorName = chipEl?.textContent?.replace(/\\s*→\\s*$/, '').trim() || '';
  var col = card.closest('.insight-col');
  var colHeader = col?.querySelector('.insight-col-header');
  var category = 'insight';
  if (colHeader?.classList.contains('col-product')) category = 'product';
  else if (colHeader?.classList.contains('col-tech')) category = 'tech';
  else if (colHeader?.classList.contains('col-user')) category = 'user';
  return { type: 'insight', category: category, title: title, content: desc, link: link, authorName: authorName, avatar: '', kws: [], idTags: [], heat: '', id: btoa(encodeURIComponent(title.slice(0, 50) + authorName)) };
}

function extractCardData(card) {
  var kws = [];
  card.querySelectorAll('.kw').forEach(function(k) { kws.push({ text: k.textContent, cls: k.className }); });
  var avatar = card.querySelector('.real-avatar');
  var name = card.querySelector('.name');
  var idTags = [];
  card.querySelectorAll('.id-tag').forEach(function(t) { idTags.push({ text: t.textContent, cls: t.className }); });
  var content = card.querySelector('.content')?.textContent || '';
  var link = card.querySelector('.link-btn')?.href || '';
  var heat = card.querySelector('.heat-bar')?.innerHTML || '';
  return { type: 'detail', kws: kws, content: content, link: link, heat: heat, avatar: avatar?.src || '', authorName: name?.textContent || '', idTags: idTags, id: btoa(encodeURIComponent(content.slice(0, 50) + (name?.textContent || ''))) };
}

(function saveToday() {
  var history = JSON.parse(localStorage.getItem('digest-history') || '{}');
  if (!history[TODAY_KEY]) {
    var insights = [];
    document.querySelectorAll('.insight-card[data-bookmarkable]').forEach(function(card) { insights.push(extractInsightData(card)); });
    var cards = [];
    document.querySelectorAll('.detail-card').forEach(function(card) { cards.push(extractCardData(card)); });
    var statPills = [];
    document.querySelectorAll('.stat-pill').forEach(function(s) { statPills.push(s.textContent); });
    var podcast = extractPodcastData();
    history[TODAY_KEY] = { stats: statPills, insights: insights, cards: cards, podcast: podcast, savedAt: Date.now() };
    localStorage.setItem('digest-history', JSON.stringify(history));
  }
  updateBadges();
  populateDateList();
})();

(function addInsightBookmarks() {
  var favs = JSON.parse(localStorage.getItem('digest-favorites') || '{}');
  document.querySelectorAll('.insight-card[data-bookmarkable]').forEach(function(card) {
    var bottom = card.querySelector('.insight-bottom');
    if (!bottom) return;
    var data = extractInsightData(card);
    var btn = document.createElement('button');
    btn.className = 'insight-bm-btn'; btn.title = '收藏';
    if (favs[data.id]) { btn.classList.add('bookmarked'); btn.innerHTML = '&#9733;'; }
    else { btn.innerHTML = '&#9734;'; }
    btn.onclick = function(e) { e.stopPropagation(); toggleBookmark(data, btn); };
    bottom.appendChild(btn);
  });
})();

(function addBookmarkBtns() {
  var favs = JSON.parse(localStorage.getItem('digest-favorites') || '{}');
  document.querySelectorAll('.detail-card').forEach(function(card) {
    var eng = card.querySelector('.engagement');
    if (!eng) return;
    var data = extractCardData(card);
    var btn = document.createElement('button');
    btn.className = 'bm-btn'; btn.title = '收藏';
    if (favs[data.id]) { btn.classList.add('bookmarked'); btn.innerHTML = '&#9733;'; }
    else { btn.innerHTML = '&#9734;'; }
    btn.onclick = function() { toggleBookmark(data, btn); };
    eng.appendChild(btn);
  });
})();

(function addPodcastBookmark() {
  var favs = JSON.parse(localStorage.getItem('digest-favorites') || '{}');
  var btn = document.getElementById('podcast-bm-btn');
  if (!btn) return;
  var data = extractPodcastData();
  if (!data) return;
  if (favs[data.id]) { btn.classList.add('bookmarked'); btn.innerHTML = '&#9733;'; }
  btn.onclick = function() {
    var f = JSON.parse(localStorage.getItem('digest-favorites') || '{}');
    if (f[data.id]) { delete f[data.id]; btn.classList.remove('bookmarked'); btn.innerHTML = '&#9734;'; }
    else { f[data.id] = Object.assign({}, data, { status: 'unread', date: TODAY_KEY, addedAt: Date.now() }); btn.classList.add('bookmarked'); btn.innerHTML = '&#9733;'; }
    localStorage.setItem('digest-favorites', JSON.stringify(f));
    updateBadges();
  };
})();

function toggleBookmark(data, btn) {
  var favs = JSON.parse(localStorage.getItem('digest-favorites') || '{}');
  if (favs[data.id]) { delete favs[data.id]; btn.classList.remove('bookmarked'); btn.innerHTML = '&#9734;'; }
  else { favs[data.id] = { type: data.type, category: data.category, title: data.title, content: data.content, link: data.link, authorName: data.authorName, avatar: data.avatar, kws: data.kws, idTags: data.idTags, heat: data.heat, status: 'unread', date: TODAY_KEY, addedAt: Date.now() }; btn.classList.add('bookmarked'); btn.innerHTML = '&#9733;'; }
  localStorage.setItem('digest-favorites', JSON.stringify(favs));
  updateBadges();
}

function populateDateList() {
  var history = JSON.parse(localStorage.getItem('digest-history') || '{}');
  var container = document.getElementById('date-list');
  var dates = Object.keys(history).sort().reverse();
  if (!dates.length) { container.innerHTML = '<div style="padding:8px 20px;font-size:12px;color:#64748b;">暂无记录</div>'; return; }
  container.innerHTML = dates.map(function(d) {
    var isCurrent = d === TODAY_KEY;
    var parts = d.split('.');
    var label = parts[1] + '月' + parseInt(parts[2]) + '日';
    return '<button class="date-item ' + (isCurrent ? 'active' : '') + '" data-date="' + d + '" onclick="showHistoryDay(\\'' + d + '\\')">' +
      '<span class="date-label">' + label + '</span>' +
      '<span class="date-tag ' + (isCurrent ? 'date-tag-today' : 'date-tag-past') + '">' + (isCurrent ? '今日' : '历史') + '</span>' +
    '</button>';
  }).join('');
}

function buildPodcastCardHTML(p, showFavControls) {
  var id = p.id || ('podcast-' + btoa(encodeURIComponent((p.title || '').slice(0, 50))));
  var favs = JSON.parse(localStorage.getItem('digest-favorites') || '{}');
  var isFaved = !!favs[id];
  var html = '<div class="fav-card" style="background:linear-gradient(135deg,rgba(99,102,241,0.06),rgba(139,92,246,0.06));margin-bottom:16px;">';
  if (showFavControls) {
    html += '<div class="fav-top-row">' +
      '<div class="fav-date-label">播客 | ' + (p.date || '') + '</div>' +
      '<select class="fav-status-select" onchange="changeFavStatus(\\'' + id + '\\',this.value)">' +
        '<option value="unread"' + (favs[id]?.status === 'unread' ? ' selected' : '') + '>待阅读</option>' +
        '<option value="deep"' + (favs[id]?.status === 'deep' ? ' selected' : '') + '>深刻阅读</option>' +
        '<option value="think"' + (favs[id]?.status === 'think' ? ' selected' : '') + '>待思考</option>' +
      '</select>' +
      '<button class="fav-remove-btn" onclick="removeFav(\\'' + id + '\\')" title="取消收藏">&times;</button>' +
    '</div>';
  }
  html += '<div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;">' +
    '<span style="font-size:11px;font-weight:700;background:rgba(99,102,241,0.15);color:#6366f1;padding:2px 8px;border-radius:8px;">&#127911; ' + (p.showName || 'Podcast') + '</span>' +
  '</div>';
  html += '<div style="font-size:14px;font-weight:700;margin-bottom:8px;color:var(--text);">' + (p.title || '') + '</div>';
  if (p.points && p.points.length) {
    html += '<ul style="padding-left:16px;font-size:12px;color:var(--text2);line-height:1.9;margin-bottom:8px;">' +
      p.points.slice(0, 5).map(function(pt) { return '<li>' + pt + '</li>'; }).join('') +
    '</ul>';
  }
  html += (p.url ? '<a class="link-btn" href="' + p.url + '" target="_blank" style="font-size:11px;display:inline-flex;">观看完整内容 &rarr;</a>' : '');
  html += '</div>';
  return html;
}

function buildCardHTML(c) {
  var kwsHTML = (c.kws || []).map(function(k) { return '<span class="' + k.cls + '">' + k.text + '</span>'; }).join('');
  return '<div class="fav-card">' +
    (kwsHTML ? '<div class="kw-row" style="margin-bottom:6px;">' + kwsHTML + '</div>' : '') +
    '<div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;">' +
      (c.avatar ? '<img src="' + c.avatar + '" alt="" style="width:24px;height:24px;border-radius:50%;">' : '') +
      '<span style="font-size:12px;font-weight:600;">' + (c.authorName || '') + '</span>' +
    '</div>' +
    '<div style="font-size:12px;color:var(--text2);line-height:1.6;">' + (c.content || '').slice(0, 200) + ((c.content || '').length > 200 ? '...' : '') + '</div>' +
    (c.link ? '<a class="link-btn" href="' + c.link + '" target="_blank" style="font-size:11px;margin-top:6px;display:inline-flex;">原文 &rarr;</a>' : '') +
  '</div>';
}

var currentFilter = 'all';
function filterFav(status, btn) {
  currentFilter = status;
  document.querySelectorAll('.fav-filter-btn').forEach(function(b) { b.classList.remove('active'); });
  btn.classList.add('active');
  renderFavorites();
}

function renderFavorites() {
  var favs = JSON.parse(localStorage.getItem('digest-favorites') || '{}');
  var view = document.getElementById('favorites-view');
  var items = Object.entries(favs).sort(function(a, b) { return b[1].addedAt - a[1].addedAt; });
  if (currentFilter !== 'all') items = items.filter(function(e) { return e[1].status === currentFilter; });
  var catLabels = { product: '产品启示', tech: '技术启示', user: '用户启示' };

  var html = '<div class="fav-main-view">';
  html += '<div class="fav-header"><h2>&#11088; 我的收藏</h2></div>';
  html += '<div class="fav-filters">' +
    '<button class="fav-filter-btn ' + (currentFilter === 'all' ? 'active' : '') + '" onclick="filterFav(\\'all\\',this)">全部 (' + Object.keys(favs).length + ')</button>' +
    '<button class="fav-filter-btn ' + (currentFilter === 'unread' ? 'active' : '') + '" onclick="filterFav(\\'unread\\',this)">待阅读</button>' +
    '<button class="fav-filter-btn ' + (currentFilter === 'deep' ? 'active' : '') + '" onclick="filterFav(\\'deep\\',this)">深刻阅读</button>' +
    '<button class="fav-filter-btn ' + (currentFilter === 'think' ? 'active' : '') + '" onclick="filterFav(\\'think\\',this)">待思考</button>' +
  '</div>';

  if (!items.length) {
    html += '<div class="fav-empty-msg">' + (currentFilter === 'all' ? '还没有收藏内容。点击卡片上的 &#9734; 按钮收藏。' : '该分类下暂无内容。') + '</div>';
  } else {
    html += '<div class="fav-grid">';
    items.forEach(function(entry) {
      var id = entry[0], f = entry[1];
      if (f.type === 'podcast') {
        html += buildPodcastCardHTML(f, true);
      } else {
        var isInsight = f.type === 'insight';
        var catLabel = isInsight && f.category ? (catLabels[f.category] || '启示') : '';
        html += '<div class="fav-card">' +
          '<div class="fav-top-row">' +
            '<div class="fav-date-label">' + (catLabel ? catLabel + ' | ' : '') + (f.date || '') + '</div>' +
            '<select class="fav-status-select" onchange="changeFavStatus(\\'' + id + '\\',this.value)">' +
              '<option value="unread"' + (f.status === 'unread' ? ' selected' : '') + '>待阅读</option>' +
              '<option value="deep"' + (f.status === 'deep' ? ' selected' : '') + '>深刻阅读</option>' +
              '<option value="think"' + (f.status === 'think' ? ' selected' : '') + '>待思考</option>' +
            '</select>' +
            '<button class="fav-remove-btn" onclick="removeFav(\\'' + id + '\\')" title="取消收藏">&times;</button>' +
          '</div>' +
          (isInsight ? '<div style="font-weight:700;font-size:13px;margin-bottom:4px;">' + (f.title || '') + '</div>' : '') +
          '<div style="font-size:12px;color:var(--text2);line-height:1.6;">' + (f.content || '').slice(0, 200) + '</div>' +
          (f.link ? '<a class="link-btn" href="' + f.link + '" target="_blank" style="font-size:11px;margin-top:6px;display:inline-flex;">原文 &rarr;</a>' : '') +
        '</div>';
      }
    });
    html += '</div>';
  }
  html += '</div>';
  view.innerHTML = html;
  updateBadges();
}

function changeFavStatus(id, status) {
  var favs = JSON.parse(localStorage.getItem('digest-favorites') || '{}');
  if (favs[id]) { favs[id].status = status; localStorage.setItem('digest-favorites', JSON.stringify(favs)); renderFavorites(); }
}

function removeFav(id) {
  var favs = JSON.parse(localStorage.getItem('digest-favorites') || '{}');
  delete favs[id]; localStorage.setItem('digest-favorites', JSON.stringify(favs));
  document.querySelectorAll('.bm-btn, .insight-bm-btn').forEach(function(btn) {
    var card = btn.closest('.detail-card') || btn.closest('.insight-card');
    if (!card) return;
    var data = card.classList.contains('insight-card') ? extractInsightData(card) : extractCardData(card);
    if (data.id === id) { btn.classList.remove('bookmarked'); btn.innerHTML = '&#9734;'; }
  });
  renderFavorites();
}

function updateBadges() {
  var favs = JSON.parse(localStorage.getItem('digest-favorites') || '{}');
  document.getElementById('badge-fav').textContent = Object.keys(favs).length;
}

document.addEventListener('keydown', function(e) { if (e.key === 'Escape' && currentView !== 'today') showToday(); });

// ===== Language Toggle =====
var currentLang = localStorage.getItem('digest-lang') || 'zh';
function applyLang() {
  document.querySelectorAll('.lang-text').forEach(function(el) {
    el.textContent = el.dataset[currentLang] || el.dataset.en || '';
  });
  var btn = document.getElementById('lang-toggle');
  if (btn) btn.textContent = currentLang === 'zh' ? '中文' : 'EN';
}
function toggleLang() {
  currentLang = currentLang === 'zh' ? 'en' : 'zh';
  localStorage.setItem('digest-lang', currentLang);
  applyLang();
}
applyLang();
</script>
</body>
</html>`;
}

// -- Main --
async function main() {
  console.log('Fetching feeds...');

  let feedX, feedPodcasts;
  const localXPath = join(process.env.HOME || '', '.claude/skills/follow-builders/feed-x.json');
  const localPodPath = join(process.env.HOME || '', '.claude/skills/follow-builders/feed-podcasts.json');

  try {
    [feedX, feedPodcasts] = await Promise.all([
      fetchJSON(FEED_X_URL),
      fetchJSON(FEED_PODCASTS_URL)
    ]);
    console.log('Fetched from remote.');
  } catch (err) {
    console.log('Remote fetch failed, trying local cache...');
    if (existsSync(localXPath) && existsSync(localPodPath)) {
      feedX = JSON.parse(readFileSync(localXPath, 'utf-8'));
      feedPodcasts = JSON.parse(readFileSync(localPodPath, 'utf-8'));
      console.log('Loaded from local cache.');
    } else {
      throw err;
    }
  }

  const dateStr = getDateStr();
  console.log(`Building digest for ${dateStr}...`);

  // Translate all content via Claude API
  const { byUrl: translationsByUrl, podcast: podcastZh } = await translateAllContent(feedX, feedPodcasts);

  // Archive previous index.html
  const indexPath = join(__dirname, 'index.html');
  if (existsSync(indexPath)) {
    const archiveDir = join(__dirname, 'archive');
    if (!existsSync(archiveDir)) mkdirSync(archiveDir);
    const old = readFileSync(indexPath, 'utf-8');
    const oldDate = old.match(/Daily Digest - ([\d.]+)/)?.[1] || 'unknown';
    if (oldDate !== dateStr) {
      copyFileSync(indexPath, join(archiveDir, `${oldDate}.html`));
      console.log(`Archived previous digest: archive/${oldDate}.html`);
    }
  }

  const html = buildHTML(feedX, feedPodcasts, dateStr, translationsByUrl, podcastZh);
  writeFileSync(indexPath, html);
  console.log(`Generated index.html (${(html.length / 1024).toFixed(1)} KB)`);

  const cssPath = join(__dirname, 'template.css');
  if (!existsSync(cssPath)) {
    const m = html.match(/<style>([\s\S]*?)<\/style>/);
    if (m) writeFileSync(cssPath, m[1]);
  }
}

main().catch(err => { console.error('Build failed:', err); process.exit(1); });
