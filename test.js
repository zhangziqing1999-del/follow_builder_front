#!/usr/bin/env node

import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
let passed = 0, failed = 0;

function assert(condition, name) {
  if (condition) { passed++; console.log(`  \u2713 ${name}`); }
  else { failed++; console.log(`  \u2717 FAIL: ${name}`); }
}

const html = readFileSync(join(__dirname, 'index.html'), 'utf-8');

console.log('\n[TC1] Build Output');
assert(html.length > 10000, `index.html has content (${(html.length / 1024).toFixed(1)} KB)`);

console.log('\n[TC2] HTML Structure');
assert(html.includes('<!DOCTYPE html>'), 'Has DOCTYPE');
assert(html.includes('AI Builders Daily Digest'), 'Has title');
assert(html.includes('2026.03.22'), 'Has today date');

console.log('\n[TC3] Sliding Drawer Sidebar');
assert(html.includes('sidebar-triggers'), 'Has sidebar triggers (fixed right edge)');
assert(html.includes('sidebar-overlay'), 'Has overlay');
assert(html.includes('sidebar-trigger'), 'Has trigger buttons');
assert(html.includes('trigger-history'), 'Has history trigger');
assert(html.includes('trigger-fav'), 'Has favorites trigger');
assert(html.includes('function openSidebar'), 'Has openSidebar function');
assert(html.includes('function closeSidebar'), 'Has closeSidebar function');
assert(html.includes('sidebar-close'), 'Has close button in sidebar');
assert(!html.includes('app-layout'), 'No fixed-sidebar app-layout');
assert(!html.includes('right-panel'), 'No fixed right-panel');
assert(!html.includes('switchPanel'), 'No switchPanel (sliding drawer uses openSidebar)');

console.log('\n[TC4] Insights Grid');
assert(html.includes('insights-grid'), 'Has insights grid');
assert(html.includes('col-product'), 'Has product column');
assert(html.includes('col-tech'), 'Has tech column');
assert(html.includes('col-user'), 'Has user column');
const insightCards = (html.match(/data-bookmarkable="1"/g) || []).length;
assert(insightCards >= 6, `Has ${insightCards} bookmarkable insight cards`);

console.log('\n[TC5] Insight Bookmarks');
assert(html.includes('insight-bm-btn'), 'Has insight bookmark class');
assert(html.includes('extractInsightData'), 'Has extractInsightData function');
assert(html.includes('addInsightBookmarks'), 'Has initializer');

console.log('\n[TC6] Detail Cards');
const detailCards = (html.match(/class="detail-card"/g) || []).length;
assert(detailCards >= 10, `Has ${detailCards} detail cards`);
assert(html.includes('unavatar.io'), 'Uses unavatar.io');
assert(html.includes('heat-bar'), 'Has heat bars');

console.log('\n[TC7] History Saves Insights');
assert(html.includes('const insights = []'), 'Captures insights');
assert(html.includes("querySelectorAll('.insight-card[data-bookmarkable]')"), 'Queries insight cards');
assert(html.includes('insights, cards'), 'Stores both');
assert(html.includes('mini-insight'), 'Has mini-insight card');

console.log('\n[TC8] Favorites');
assert(html.includes('fav-filters'), 'Has filter bar');
assert(html.includes("filterFav('all'"), 'Has all filter');
assert(html.includes("filterFav('deep'"), 'Has deep filter');
assert(html.includes('fav-status-select'), 'Has status select');
assert(html.includes('fav-remove-btn'), 'Has remove button');

console.log('\n[TC9] Core JS');
assert(html.includes('function toggleBookmark'), 'Has toggleBookmark');
assert(html.includes('function renderHistory'), 'Has renderHistory');
assert(html.includes('function renderFavorites'), 'Has renderFavorites');
assert(html.includes('function updateBadges'), 'Has updateBadges');
assert(html.includes('localStorage'), 'Uses localStorage');

console.log('\n[TC10] Build Script');
assert(readFileSync(join(__dirname, 'build.js'), 'utf-8').includes('function buildHTML'), 'build.js has buildHTML function');
assert(!readFileSync(join(__dirname, 'build.js'), 'utf-8').includes('generateChineseSummaries'), 'No Chinese summary function (reverted)');
assert(!readFileSync(join(__dirname, 'build.js'), 'utf-8').includes('ANTHROPIC_API_KEY'), 'No API key config (reverted)');

console.log('\n[TC11] Links');
const xLinks = html.match(/href="https:\/\/x\.com\/[^"]+"/g) || [];
assert(xLinks.length >= 5, `Has ${xLinks.length} X links`);
assert(!(html.match(/href="undefined"/g) || []).length, 'No broken hrefs');

console.log('\n[TC12] Config');
assert(existsSync(join(__dirname, 'vercel.json')), 'vercel.json exists');
assert(existsSync(join(__dirname, '.github', 'workflows', 'daily-digest.yml')), 'workflow exists');

console.log(`\n${'='.repeat(40)}`);
console.log(`Results: ${passed} passed, ${failed} failed, ${passed + failed} total`);
console.log(`${'='.repeat(40)}`);
process.exit(failed > 0 ? 1 : 0);
