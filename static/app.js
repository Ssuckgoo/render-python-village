'use strict';
const $ = (s) => document.querySelector(s);
const W = 960, H = 600, TS = 32;
const cv = $('#cv');
const ctx = cv.getContext('2d');
const FONT = (px) => `${px}px Galmuri11, "Malgun Gothic", sans-serif`;
const RES_TILES = { T: 'wood', R: 'stone', '~': 'fish', F: 'food', m: 'ore' };
const TILE_HINT = { T: '나무', R: '바위', '~': '물', F: '밭', m: '광석' };
const VERB = { wood: '벌목', stone: '채석', fish: '낚시', food: '농사', ore: '채광' };

let META = null, ws = null, code = null, me = null, S = null, fatal = false;
let timeOffset = 0;
let mapRows = null, mapCache = null, mapBridge = null;
let cam = { x: 0, y: 0 };
let mouse = null;
let selected = null;           // 선택한 건물 id
let tab = 'build';
let unreadChat = 0;
const rpos = {};
const fx = [], parts = [], beams = [];
const flashAt = {};
let lastFrame = performance.now();
// 내 캐릭터는 브라우저가 직접 움직인다 (서버는 검증만). 좌표는 칸 중심 기준 실수.
const SPEED = 6.5, RADIUS = 0.3;
let L = null;                  // 내 위치
let auto = null;               // 자동 걷기 {wps: [[x, y]...], done}
let chase = null;              // 쫓아가는 습격 몬스터 {id, repath}
let meMoving = false;
let lastSent = { x: 0, y: 0, t: 0 };

// ---------------- 공통 ----------------
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (t.hidden = true), 2600);
}
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const lsGet = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch { /* 무시 */ } };
const now = () => Date.now() / 1000 + timeOffset;
function send(m) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(m)); }
const iconUrls = {};
function iconURL(kind, opt) {
  const key = kind + JSON.stringify(opt || {});
  return iconUrls[key] || (iconUrls[key] = buildSprite(kind, opt).toDataURL());
}
const img = (kind, size, opt) => `<img src="${iconURL(kind, opt)}" width="${size}" height="${size}" alt="" style="image-rendering:pixelated">`;
const resName = (r) => META.resources[r].name;
function fmtDur(sec) {
  sec = Math.max(0, Math.round(sec));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return h ? `${h}시간 ${m}분` : m ? `${m}분 ${s}초` : `${s}초`;
}
function ago(t) {
  const d = now() - t;
  if (d < 60) return '방금';
  if (d < 3600) return `${Math.floor(d / 60)}분 전`;
  if (d < 86400) return `${Math.floor(d / 3600)}시간 전`;
  return `${Math.floor(d / 86400)}일 전`;
}
function myMember() { return S && S.members[me]; }

// ---------------- 접속 ----------------
async function init() {
  META = await (await fetch('/api/meta')).json();
  $('#name').value = lsGet('name') || '';
  const q = new URLSearchParams(location.search).get('v');
  if (q) $('#code').value = q.toUpperCase();
  $('#btn-join').onclick = () => enter($('#code').value.trim().toUpperCase());
  $('#code').onkeydown = (e) => { if (e.key === 'Enter') $('#btn-join').click(); };
  $('#btn-create').onclick = createVillage;
  $('#vname').onkeydown = (e) => { if (e.key === 'Enter') createVillage(); };
  $('#btn-copy').onclick = () => {
    const url = `${location.origin}/?v=${code}`;
    navigator.clipboard.writeText(url).then(() => toast('초대 링크를 복사했습니다.'), () => toast(url));
  };
  document.querySelectorAll('.tabs button').forEach((b) => (b.onclick = () => setTab(b.dataset.tab)));
  $('#chat-in').onkeydown = (e) => {
    e.stopPropagation();
    if (e.key === 'Enter' && e.target.value.trim()) { send({ t: 'chat', text: e.target.value }); e.target.value = ''; }
    if (e.key === 'Escape') e.target.blur();
  };
  renderRecent();
  requestAnimationFrame(loop);
  if (q && lsGet('tok_' + q.toUpperCase())) enter(q.toUpperCase());
}

function recentList() { try { return JSON.parse(lsGet('recent') || '[]'); } catch { return []; } }
function renderRecent() {
  const list = recentList();
  $('#recent').innerHTML = list.length ? '<span class="muted">최근 마을</span>' +
    list.map((v) => `<a data-code="${esc(v.code)}">${esc(v.name)} (${esc(v.code)})</a>`).join('') : '';
  $('#recent').querySelectorAll('a').forEach((a) => (a.onclick = () => enter(a.dataset.code)));
}
function remember(c, name) {
  const list = recentList().filter((v) => v.code !== c);
  list.unshift({ code: c, name });
  lsSet('recent', JSON.stringify(list.slice(0, 5)));
}

async function createVillage() {
  const name = $('#vname').value.trim();
  if (!name) return ($('#home-err').textContent = '마을 이름을 입력하세요.');
  const r = await fetch('/api/villages', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) });
  const j = await r.json();
  if (!r.ok) return ($('#home-err').textContent = j.detail || '만들 수 없습니다.');
  enter(j.code);
}

function enter(c) {
  if (!/^[A-Z0-9]{5}$/.test(c)) return ($('#home-err').textContent = '마을 코드 5자리를 입력하세요.');
  code = c;
  fatal = false;
  lsSet('name', $('#name').value.trim() || lsGet('name') || '주민');
  history.replaceState(null, '', '?v=' + c);
  connect();
}

function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws/${code}`);
  const sock = ws;
  sock.onopen = () => sock.send(JSON.stringify({ t: 'hello', name: lsGet('name') || '주민', token: lsGet('tok_' + code) }));
  sock.onmessage = (e) => onMessage(JSON.parse(e.data));
  sock.onclose = () => {
    if (ws !== sock || fatal) return;
    toast('연결이 끊겼습니다. 재접속 중...');
    setTimeout(() => { if (ws === sock) connect(); }, 2500);
  };
}

function onMessage(m) {
  if (m.t === 'welcome') {
    me = m.you;
    L = null;
    lsSet('tok_' + code, m.token);
    $('#chat-log').innerHTML = '';
    m.chat.forEach(addChat);
    unreadChat = 0;
  } else if (m.t === 'state') {
    applyState(m.s);
    playEvents(m.ev || []);
  } else if (m.t === 'tk') applyTick(m);
  else if (m.t === 'you') { L = { x: m.x, y: m.y }; auto = null; chase = null; lastSent = { x: m.x, y: m.y, t: performance.now() }; }
  else if (m.t === 'chat') { addChat(m.line); if (tab !== 'chat') { unreadChat++; renderTabs(); } }
  else if (m.t === 'error') toast(m.msg);
  else if (m.t === 'fatal') {
    fatal = true;
    $('#home-err').textContent = m.msg;
    showScreen('home');
  }
}

function showScreen(n) { $('#home').hidden = n !== 'home'; $('#game').hidden = n !== 'game'; }

function addChat(line) {
  const box = $('#chat-log');
  const div = document.createElement('div');
  const t = new Date(line.t * 1000);
  div.innerHTML = `<span class="t">${t.getMonth() + 1}/${t.getDate()} ${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}</span><b>${esc(line.name)}</b> ${esc(line.text)}`;
  box.appendChild(div);
  box.scrollTop = box.scrollHeight;
}

// ---------------- 상태 ----------------
function applyState(s) {
  const first = !S;
  S = s;
  timeOffset = s.now - Date.now() / 1000;
  if (mapBridge !== s.map_bridge) {
    mapBridge = s.map_bridge;
    mapRows = META.map.map((r) => (mapBridge ? r.replace(/b/g, '=') : r));
    buildMapCache();
  }
  if (first) {
    showScreen('game');
    remember(s.code, s.name);
  }
  const mine = myMember();
  if (mine && !L) {
    L = { x: mine.x, y: mine.y };
    lastSent = { x: L.x, y: L.y, t: performance.now() };
    cam.x = L.x * TS - W / 2; cam.y = L.y * TS - H / 2;
  }
  renderTop();
  renderSide();
}

function applyTick(m) {
  if (!S) return;
  for (const [pid, x, y] of m.p) if (S.members[pid]) { S.members[pid].x = x; S.members[pid].y = y; }
  if (S.raid) {
    for (const [id, x, y, hp] of m.m) {
      const mo = S.raid.monsters.find((q) => q.id === id);
      if (mo) { mo.x = x; mo.y = y; mo.hp = hp; }
    }
  }
  playEvents(m.ev || []);
}

function entityPos(id) {
  if (id === 'boss') { const [x, y] = META.building_pos.dungeon; return { x, y: y - 0.5 }; }
  if (rpos[id]) return rpos[id];
  const mem = S.members[id];
  if (mem) return { x: mem.x - 0.5, y: mem.y - 0.5 };
  const mo = S.raid && S.raid.monsters.find((q) => q.id === id);
  return mo ? { x: mo.x, y: mo.y } : null;
}

function playEvents(evs) {
  const t = performance.now();
  for (const e of evs) {
    if (e.k === 'gain') {
      const p = entityPos(e.pid);
      if (p) floatText(p.x, p.y - 0.8, `+${e.n} ${resName(e.res)}`, META.resources[e.res].color, 12, e.res);
    } else if (e.k === 'hit') {
      const p = entityPos(e.tgt);
      flashAt[e.tgt] = t;
      if (p) floatText(p.x + (Math.random() - 0.5) * 0.6, p.y - 0.6, `${e.v}`, '#ffffff', 14);
    } else if (e.k === 'die') {
      const p = entityPos(e.tgt);
      if (p) burst(p.x, p.y, '#ffffff', 14);
      if (S.raid) S.raid.monsters = S.raid.monsters.filter((q) => q.id !== e.tgt);
    } else if (e.k === 'tower') {
      const [tx, ty] = META.building_pos.tower;
      const p = entityPos(e.tgt);
      if (p) beams.push({ x0: tx, y0: ty - 1.2, x: p.x, y: p.y, t0: t });
    } else if (e.k === 'built') {
      const [bx, by] = META.building_pos[e.id];
      burst(bx, by - 0.5, '#f5c542', 40);
      toast(`${META.buildings[e.id].name} 완공!`);
    } else if (e.k === 'raid') toast('🚨 습격이다! 몬스터를 클릭해서 물리치세요!');
  }
}

function floatText(x, y, text, color, size, icon) {
  fx.push({ x: x * TS + TS / 2, y: y * TS, text, color, size, icon, t0: performance.now() });
}
function burst(x, y, color, n) {
  const t = performance.now();
  for (let i = 0; i < n; i++) {
    const a = Math.random() * Math.PI * 2, sp = 0.5 + Math.random() * 2;
    parts.push({ x: x + 0.5, y: y + 0.5, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 1.5, t0: t, c: i % 3 ? color : '#ffffff' });
  }
}

// ---------------- 상단/사이드 ----------------
function renderTop() {
  $('#v-name').textContent = S.name;
  $('#v-level').textContent = `마을 Lv.${S.level}`;
  $('#v-code').textContent = S.code;
  const online = Object.values(S.members).filter((m) => m.online).length;
  $('#v-online').textContent = `접속 ${online} / 주민 ${Object.keys(S.members).length}`;
  $('#resbar').innerHTML = Object.keys(META.resources).map((r) => {
    const v = S.res[r], cap = S.caps[r];
    return `<span class="res ${v >= cap ? 'full' : ''}" title="${resName(r)} (최대 ${cap})">${img(r, 20)}
      <span><b>${v}</b><span class="muted">/${cap}</span><div class="bar"><div style="width:${Math.min(100, (v / cap) * 100)}%;background:${META.resources[r].color}"></div></div></span></span>`;
  }).join('');
  const warn = $('#storage-warn');
  warn.hidden = META.storage === 'Postgres';
  warn.textContent = '⚠ 저장소가 임시 SQLite입니다. 서버를 다시 배포하면 마을이 초기화될 수 있어요. (Render에 DATABASE_URL 설정 필요)';
}

function setTab(t) {
  tab = t;
  if (t === 'chat') unreadChat = 0;
  renderTabs();
  renderSide();
  if (t === 'chat') { const b = $('#chat-log'); b.scrollTop = b.scrollHeight; $('#chat-in').focus(); }
}
function renderTabs() {
  document.querySelectorAll('.tabs button').forEach((b) => {
    b.classList.toggle('on', b.dataset.tab === tab);
    if (b.dataset.tab === 'chat') b.innerHTML = '채팅' + (unreadChat ? ` <span class="dot">●${unreadChat}</span>` : '');
  });
  for (const id of ['build', 'news', 'chat', 'people', 'me']) $('#tab-' + id).hidden = id !== tab;
}

function renderSide() {
  if (!S) return;
  if (tab === 'build') renderBuild();
  else if (tab === 'news') renderNews();
  else if (tab === 'people') renderPeople();
  else if (tab === 'me') renderMe();
}

function costHTML(cost) {
  return Object.entries(cost).map(([r, v]) => `<span class="${S.res[r] < v ? 'no' : ''}">${img(r, 14)}${v}</span>`).join('');
}

function buildBlock(bid) {
  const b = META.buildings[bid], lvl = S.buildings[bid];
  if (lvl >= b.max) return '최대 레벨';
  if (S.construction) return '다른 공사 중';
  if (bid !== 'hall' && lvl + 1 > S.buildings.hall + 1) return `회관 Lv.${lvl} 필요`;
  if (b.needs && S.buildings[b.needs] <= 0) return `${META.buildings[b.needs].name} 필요`;
  const cost = S.costs[bid];
  if (Object.entries(cost).some(([r, v]) => S.res[r] < v)) return '자원 부족';
  return null;
}

function renderBuild() {
  let h = '';
  const c = S.construction;
  if (c) {
    const b = META.buildings[c.id];
    const pct = (1 - c.left / c.total) * 100;
    h += `<div class="cons"><b>🔨 ${b.name} Lv.${c.level} 공사 중</b>
      <div class="prog"><div style="width:${pct}%"></div></div>
      <div class="muted">남은 시간 약 ${fmtDur(c.left / (1 + c.helpers))} · 돕는 주민 ${c.helpers}명</div>
      <div class="muted">공사장 근처(3칸)에 서 있으면 1명당 속도 +100%</div></div>`;
  }
  if (S.boss) {
    const mm = myMember();
    h += `<div class="bossbox"><b>👹 동굴 트롤 ${S.boss.level}단계</b>
      <div class="prog red"><div style="width:${(S.boss.hp / S.boss.max_hp) * 100}%"></div></div>
      <div class="muted">${Math.max(0, Math.round(S.boss.hp))} / ${S.boss.max_hp} · 내 행동력 ${mm ? Math.floor(mm.energy) : 0}/${META.energy_max}</div>
      <button class="btn small" data-boss>던전으로 가서 공격</button></div>`;
  }
  for (const [bid, b] of Object.entries(META.buildings)) {
    const lvl = S.buildings[bid];
    const block = buildBlock(bid);
    const locked = b.needs && S.buildings[b.needs] <= 0 && lvl === 0;
    h += `<div class="bld ${selected === bid ? 'sel' : ''} ${locked ? 'locked' : ''}" data-sel="${bid}">
      <div class="head"><b>${b.name}</b><span class="lv">${lvl ? `Lv.${lvl}` : '미건설'}</span><span class="muted">/ ${b.max}</span>
      <span class="spacer"></span>
      ${lvl < b.max ? `<button class="btn small" data-build="${bid}" ${block ? 'disabled' : ''} title="${block || ''}">${lvl ? '레벨업' : '짓기'}</button>` : ''}</div>
      <div class="desc">${esc(b.desc)}</div>
      ${lvl < b.max ? `<div class="cost">${costHTML(S.costs[bid])}<span class="muted">⏱ ${fmtDur(S.times[bid])}</span>
        ${block && block !== '자원 부족' ? `<span class="muted">· ${block}</span>` : ''}</div>` : ''}</div>`;
  }
  $('#tab-build').innerHTML = h;
  if (selected) {
    const el = $(`#tab-build [data-sel="${selected}"]`);
    if (el && renderBuild.scrollTo === selected) { el.scrollIntoView({ block: 'nearest' }); renderBuild.scrollTo = null; }
  }
}
$('#tab-build').addEventListener('click', (e) => {
  const b = e.target.closest('[data-build]');
  if (b) return send({ t: 'build', id: b.dataset.build });
  if (e.target.closest('[data-boss]')) return send({ t: 'boss' });
  const s = e.target.closest('[data-sel]');
  if (s) { selected = s.dataset.sel; renderBuild(); }
});

function renderNews() {
  $('#tab-news').innerHTML = S.log.slice().reverse().map((l) =>
    `<div class="news"><span class="t">${ago(l.t)}</span>${esc(l.text)}</div>`).join('') || '<p class="muted">아직 소식이 없습니다.</p>';
}

function jobText(m) {
  if (!m.job) return '쉬는 중';
  const left = m.job.end - now();
  return `${VERB[m.job.res]} 중 · 분당 ${m.job.rate} · +${m.job.total} · ${left > 0 ? `${fmtDur(left)} 남음` : '곧 끝남'}`;
}

function renderPeople() {
  const list = Object.entries(S.members).sort((a, b) => b[1].contrib - a[1].contrib);
  $('#tab-people').innerHTML = list.map(([pid, m], i) => `<div class="person">
    ${img('villager', 28, { cloth: m.color })}
    <div class="info"><b>${i + 1}. ${esc(m.name)}</b>${pid === me ? ' (나)' : ''}
      <span class="${m.online ? 'on' : 'muted'}">${m.online ? '● 접속 중' : `· ${ago(m.last_seen)}`}</span>
      <div class="muted">${jobText(m)}</div>
      <div class="muted">기여 ${m.contrib} · ${Object.entries(m.skills).map(([k, v]) => `${k === 'combat' ? '전투' : VERB[k]} ${v}`).join(' ')}</div></div></div>`).join('');
}

function renderMe() {
  const m = myMember();
  if (!m) return;
  const smithy = S.buildings.smithy;
  let h = `<div class="person">${img('villager', 40, { cloth: m.color })}<div class="info"><b>${esc(m.name)}</b>
    <div>${img('gold', 14)} 동전 ${m.coins} · 기여도 ${m.contrib}</div>
    ${S.buildings.dungeon ? `<div class="muted">행동력 ${Math.floor(m.energy)}/${META.energy_max} (${META.energy_regen / 60}분마다 1)</div>` : ''}</div></div>
    <h4>숙련도</h4><div class="skills">`;
  for (const [k, v] of Object.entries(m.skills)) {
    h += `<span>${k === 'combat' ? '전투' : VERB[k]} <b>Lv.${v}</b> <span class="muted">(${m.xp[k]}xp)</span></span>`;
  }
  h += `</div><h4>도구 ${smithy ? `<span class="muted">(대장간 Lv.${smithy}까지)</span>` : '<span class="muted">— 대장간을 지으면 살 수 있어요</span>'}</h4>`;
  for (const [k, name] of Object.entries(META.tools)) {
    const lvl = m.tools[k];
    const price = META.tool_prices[lvl];
    const can = smithy && lvl < Math.min(META.tool_max, smithy) && m.coins >= price;
    h += `<div class="tool">${img(k === 'weapon' ? 'ore' : k, 18)}<span class="nm">${name} <b>+${lvl}</b>
      <span class="muted">${k === 'weapon' ? '공격력 +4/단계' : '채집 +15%/단계'}</span></span>
      ${lvl < META.tool_max ? `<button class="btn small" data-buy="${k}" ${can ? '' : 'disabled'}>${price}동전</button>` : '<span class="muted">최대</span>'}</div>`;
  }
  h += `<p class="muted">동전은 채집(10개당 1), 습격 방어, 보스 공격으로 얻어요.</p>
    <h4>마을 기록</h4><div class="muted">습격 방어 ${S.stats.raids_won} · 실패 ${S.stats.raids_lost} · 보스 처치 ${S.stats.bosses}</div>`;
  $('#tab-me').innerHTML = h;
}
$('#tab-me').addEventListener('click', (e) => {
  const b = e.target.closest('[data-buy]');
  if (b) send({ t: 'buy', kind: b.dataset.buy });
});
setInterval(() => { if (S && (tab === 'news' || tab === 'people' || tab === 'build')) renderSide(); }, 5000);

// ---------------- 지도 ----------------
const tileAt = (x, y) => (mapRows && y >= 0 && y < mapRows.length && x >= 0 && x < mapRows[0].length ? mapRows[y][x] : '#');
function hash(x, y) {
  let h = (x * 374761393 + y * 668265263) ^ 0x5bd1e995;
  h = (h ^ (h >>> 13)) * 1274126177;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function buildMapCache() {
  const w = mapRows[0].length, h = mapRows.length;
  mapCache = document.createElement('canvas');
  mapCache.width = w * TS;
  mapCache.height = h * TS;
  const c = mapCache.getContext('2d');
  c.imageSmoothingEnabled = false;
  const grass = (px, py, r) => {
    c.fillStyle = r < 0.5 ? '#4f8a3c' : '#558f40';
    c.fillRect(px, py, TS, TS);
    if (r > 0.75) { c.fillStyle = '#67a64e'; c.fillRect(px + ((r * 97) | 0) % 26, py + ((r * 53) | 0) % 26, 2, 4); }
    if (r < 0.05) { c.fillStyle = '#f5e27a'; c.fillRect(px + 12, py + 14, 3, 3); }
  };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const t = mapRows[y][x], px = x * TS, py = y * TS, r = hash(x, y);
      if (t === '~' || t === 'b') {
        c.fillStyle = '#2f6fa8'; c.fillRect(px, py, TS, TS);
        c.fillStyle = '#3d82bd'; if (r > 0.5) c.fillRect(px + 4, py + 10, 10, 2);
        if (t === 'b') { c.fillStyle = '#5a3a1a'; c.fillRect(px + 4, py + 4, 4, 24); c.fillRect(px + 24, py + 4, 4, 24); }
      } else if (t === '=') {
        c.fillStyle = '#2f6fa8'; c.fillRect(px, py, TS, TS);
        c.fillStyle = '#8b5a2b'; c.fillRect(px, py + 2, TS, TS - 4);
        c.fillStyle = '#6b4220'; for (let i = 0; i < TS; i += 8) c.fillRect(px + i, py + 2, 1, TS - 4);
      } else if (t === ':' || t === 'm') {
        c.fillStyle = r < 0.5 ? '#4a4452' : '#4e4856'; c.fillRect(px, py, TS, TS);
        if (r > 0.8) { c.fillStyle = '#5c5566'; c.fillRect(px + 8, py + 18, 6, 3); }
      } else if (t === ',') {
        c.fillStyle = r < 0.5 ? '#b89a68' : '#bfa16e'; c.fillRect(px, py, TS, TS);
        c.fillStyle = '#a88a5a'; if (r > 0.6) c.fillRect(px + 6, py + 20, 4, 3);
      } else if (t === 'F') {
        c.fillStyle = '#6b4a2b'; c.fillRect(px, py, TS, TS);
        c.fillStyle = '#5a3d22'; for (let i = 4; i < TS; i += 8) c.fillRect(px, py + i, TS, 2);
        c.fillStyle = '#8bc34a'; for (let i = 3; i < TS; i += 8) { c.fillRect(px + i, py + 6, 3, 4); c.fillRect(px + i + 2, py + 22, 3, 4); }
      } else if (t === '#') {
        c.fillStyle = '#2b4a24'; c.fillRect(px, py, TS, TS);
        c.drawImage(buildSprite('tree'), px, py - 4, TS, TS);
      } else {
        grass(px, py, r);
      }
      if (t === 'T') c.drawImage(buildSprite('tree'), px - 2, py - 10, TS + 4, TS + 6);
      if (t === 'R') c.drawImage(buildSprite('rock'), px, py, TS, TS);
      if (t === 'm') c.drawImage(buildSprite('orerock'), px, py, TS, TS);
    }
  }
}

// 건물 그리기 (레벨 0이면 공터 표지판)
const BCOL = {
  hall: ['#b5473a', '#e8d9b5'], warehouse: ['#7a4a26', '#a8743f'], smithy: ['#4a4a55', '#8a8a95'],
  inn: ['#3b5fa8', '#e8d9b5'], tower: ['#6b6b75', '#9a9aa5'], lumber: ['#3e7d32', '#a8743f'],
  quarry: ['#6b6b75', '#c2b49a'], farm: ['#b5473a', '#c99a5a'], mine: ['#3a3440', '#6b5f75'],
  dungeon: ['#2a1a35', '#5a3a6a'],
};

function drawBuilding(bid, t) {
  const [bx, by] = META.building_pos[bid];
  const lvl = S.buildings[bid];
  const cons = S.construction && S.construction.id === bid;
  const px = bx * TS - Math.round(cam.x) + TS / 2, py = (by + 1) * TS - Math.round(cam.y);
  if (px < -100 || px > W + 100 || py < -100 || py > H + 140) return;
  if (bid === 'bridge') { if (lvl || cons) label(bid, px, py - TS - 4, lvl); return; }
  if (!lvl && !cons) {
    ctx.strokeStyle = 'rgba(255,255,255,0.35)';
    ctx.setLineDash([4, 4]);
    ctx.strokeRect(px - TS, py - TS * 1.6, TS * 2, TS * 1.6);
    ctx.setLineDash([]);
    ctx.fillStyle = '#7a4a26'; ctx.fillRect(px - 2, py - 26, 4, 22);
    ctx.fillStyle = '#c99a5a'; ctx.fillRect(px - 14, py - 34, 28, 12);
    ctx.font = FONT(9); ctx.textAlign = 'center'; ctx.fillStyle = '#3a2410'; ctx.fillText('공터', px, py - 25);
    label(bid, px, py - TS * 1.6 - 6, 0, true);
    return;
  }
  const [roof, wall] = BCOL[bid] || ['#888', '#ccc'];
  const sc = 1 + Math.min(lvl, 6) * 0.06;
  const w = TS * 1.8 * sc, hgt = TS * 1.1 * sc;
  ctx.fillStyle = 'rgba(0,0,0,0.3)';
  ctx.fillRect(px - w / 2 + 4, py - 4, w, 8);
  if (bid === 'fountain') {
    ctx.fillStyle = '#9a9aa5'; ctx.beginPath(); ctx.ellipse(px, py - 10, 26 * sc, 12 * sc, 0, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#4fa3e0'; ctx.beginPath(); ctx.ellipse(px, py - 11, 20 * sc, 8 * sc, 0, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#c9e8ff';
    for (let i = 0; i < 6; i++) { const a = t / 300 + i; ctx.fillRect(px + Math.cos(a) * 6, py - 22 - Math.abs(Math.sin(a * 2)) * 10, 2, 2); }
    ctx.fillStyle = '#8a8a95'; ctx.fillRect(px - 3, py - 30, 6, 18);
  } else if (bid === 'tower') {
    ctx.fillStyle = wall; ctx.fillRect(px - 12, py - 70, 24, 70);
    ctx.fillStyle = roof; ctx.fillRect(px - 16, py - 76, 32, 10);
    for (let i = 0; i < 4; i++) ctx.fillRect(px - 16 + i * 9, py - 82, 5, 6);
    ctx.fillStyle = '#1a1423'; ctx.fillRect(px - 3, py - 50, 6, 10);
  } else if (bid === 'mine' || bid === 'dungeon') {
    ctx.fillStyle = wall; ctx.beginPath(); ctx.moveTo(px - w / 2, py); ctx.lineTo(px - w / 4, py - hgt * 1.4); ctx.lineTo(px + w / 4, py - hgt * 1.5); ctx.lineTo(px + w / 2, py); ctx.fill();
    ctx.fillStyle = '#0a0810'; ctx.beginPath(); ctx.arc(px, py, 14 * sc, Math.PI, 0); ctx.fill();
    if (bid === 'dungeon') {
      ctx.fillStyle = `rgba(160,80,255,${0.3 + Math.sin(t / 300) * 0.15})`;
      ctx.beginPath(); ctx.arc(px, py - 4, 18 * sc, Math.PI, 0); ctx.fill();
      ctx.fillStyle = '#e8e8e8'; ctx.fillRect(px - 4, py - hgt * 1.2, 8, 7); ctx.fillStyle = '#1a1423'; ctx.fillRect(px - 3, py - hgt * 1.2 + 2, 2, 2); ctx.fillRect(px + 1, py - hgt * 1.2 + 2, 2, 2);
    } else {
      ctx.fillStyle = '#8b5a2b'; ctx.fillRect(px - 16 * sc, py - 16 * sc, 4, 16 * sc); ctx.fillRect(px + 12 * sc, py - 16 * sc, 4, 16 * sc); ctx.fillRect(px - 16 * sc, py - 18 * sc, 32 * sc, 4);
    }
  } else {
    // 일반 건물: 벽 + 지붕 + 문
    ctx.fillStyle = wall; ctx.fillRect(px - w / 2, py - hgt, w, hgt);
    ctx.fillStyle = 'rgba(0,0,0,0.15)'; ctx.fillRect(px - w / 2, py - hgt, w, 4);
    ctx.fillStyle = roof;
    ctx.beginPath(); ctx.moveTo(px - w / 2 - 6, py - hgt + 2); ctx.lineTo(px, py - hgt - TS * 0.9 * sc); ctx.lineTo(px + w / 2 + 6, py - hgt + 2); ctx.fill();
    ctx.fillStyle = '#4a2c14'; ctx.fillRect(px - 6, py - 18, 12, 18);
    ctx.fillStyle = '#ffe27a';
    if (w > 60) { ctx.fillRect(px - w / 2 + 8, py - hgt + 10, 9, 9); ctx.fillRect(px + w / 2 - 17, py - hgt + 10, 9, 9); }
    if (bid === 'hall') {
      ctx.fillStyle = '#5a3a1a'; ctx.fillRect(px - 1, py - hgt - TS * 0.9 * sc - 16, 2, 18);
      ctx.fillStyle = '#9be15d'; ctx.fillRect(px + 1, py - hgt - TS * 0.9 * sc - 16, 12 + Math.sin(t / 200) * 2, 7);
    }
    if (bid === 'smithy') {
      ctx.fillStyle = '#3a3a44'; ctx.fillRect(px + w / 4, py - hgt - 20, 8, 22);
      ctx.fillStyle = 'rgba(200,200,200,0.4)';
      for (let i = 0; i < 3; i++) { const k = ((t / 1500 + i / 3) % 1); ctx.beginPath(); ctx.arc(px + w / 4 + 4 + k * 8, py - hgt - 24 - k * 26, 3 + k * 5, 0, Math.PI * 2); ctx.fill(); }
    }
    if (bid === 'lumber') { ctx.fillStyle = '#8b5a2b'; for (let i = 0; i < 3; i++) ctx.fillRect(px + w / 2 + 2, py - 8 - i * 6, 18, 5); }
    if (bid === 'quarry') { ctx.fillStyle = '#9a9aa5'; ctx.fillRect(px + w / 2 + 2, py - 10, 14, 10); ctx.fillRect(px + w / 2 + 6, py - 16, 10, 7); }
    if (bid === 'warehouse') { ctx.strokeStyle = '#4a2c14'; ctx.lineWidth = 2; ctx.strokeRect(px - 10, py - 22, 20, 22); ctx.beginPath(); ctx.moveTo(px - 10, py - 22); ctx.lineTo(px + 10, py); ctx.moveTo(px + 10, py - 22); ctx.lineTo(px - 10, py); ctx.stroke(); }
    if (bid === 'dock') { ctx.fillStyle = '#8b5a2b'; ctx.fillRect(px + 10, py - 6, 40, 8); }
    if (bid === 'farm') { ctx.fillStyle = '#e8d9b5'; ctx.fillRect(px - 4, py - hgt - 8, 8, 8); }
  }
  if (cons) {
    ctx.strokeStyle = '#c99a5a'; ctx.lineWidth = 2;
    for (let i = -1; i <= 1; i++) { ctx.beginPath(); ctx.moveTo(px + i * 20, py); ctx.lineTo(px + i * 20, py - hgt - 20); ctx.stroke(); }
    for (let j = 0; j < 3; j++) { ctx.beginPath(); ctx.moveTo(px - 24, py - j * 18 - 6); ctx.lineTo(px + 24, py - j * 18 - 6); ctx.stroke(); }
    const c = S.construction, k = 1 - c.left / c.total;
    ctx.fillStyle = '#000'; ctx.fillRect(px - 24, py + 4, 48, 6);
    ctx.fillStyle = '#5fbf4f'; ctx.fillRect(px - 24, py + 4, 48 * k, 6);
    if (Math.random() < 0.05) burst(bx + Math.random() - 0.5, by - 0.5, '#c99a5a', 2);
  }
  label(bid, px, py - hgt - TS * 0.9 * sc - 6, lvl);
}

function label(bid, x, y, lvl, dim) {
  const text = `${META.buildings[bid].name}${lvl ? ` Lv.${lvl}` : ''}`;
  ctx.font = FONT(11);
  ctx.textAlign = 'center';
  ctx.fillStyle = '#000a';
  ctx.fillText(text, x + 1, y + 1);
  ctx.fillStyle = selected === bid ? '#f5c542' : dim ? '#c8c8c8' : '#ffffff';
  ctx.fillText(text, x, y);
}

// ---------------- 입력 ----------------
function canvasPoint(e) {
  const r = cv.getBoundingClientRect();
  const px = (e.clientX - r.left) * (W / r.width), py = (e.clientY - r.top) * (H / r.height);
  return { px, py, wx: (px + cam.x) / TS, wy: (py + cam.y) / TS };
}
function monsterAt(wx, wy) {
  if (!S || !S.raid) return null;
  return S.raid.monsters.find((m) => { const p = rpos[m.id] || m; return Math.abs(p.x + 0.5 - wx) < 0.7 && Math.abs(p.y + 0.4 - wy) < 0.7; });
}
function memberAt(wx, wy) {
  return Object.entries(S.members).find(([id]) => { const p = entityPos(id); return Math.abs(p.x + 0.5 - wx) < 0.5 && Math.abs(p.y + 0.3 - wy) < 0.6; });
}
function buildingAt(wx, wy) {
  return Object.entries(META.building_pos).find(([bid, [bx, by]]) =>
    bid !== 'bridge' && wx >= bx - 0.6 && wx <= bx + 1.6 && wy >= by - 1.2 && wy <= by + 1);
}
function bossAt(wx, wy) {
  if (!S.boss) return false;
  const [bx, by] = META.building_pos.dungeon;
  return Math.abs(wx - (bx + 0.5)) < 1.2 && Math.abs(wy - (by + 1.3)) < 1.2;
}

cv.addEventListener('mousemove', (e) => {
  if (!S) return;
  mouse = canvasPoint(e);
  const tx = Math.floor(mouse.wx), ty = Math.floor(mouse.wy);
  const t = tileAt(tx, ty);
  cv.style.cursor = monsterAt(mouse.wx, mouse.wy) || bossAt(mouse.wx, mouse.wy) ? 'crosshair' : (RES_TILES[t] || buildingAt(mouse.wx, mouse.wy)) ? 'pointer' : 'default';
  showCanvasTip(e);
});
cv.addEventListener('mouseleave', () => { mouse = null; $('#tip').hidden = true; });
cv.addEventListener('click', (e) => {
  if (!S) return;
  const p = canvasPoint(e);
  const tx = Math.floor(p.wx), ty = Math.floor(p.wy);
  const mon = monsterAt(p.wx, p.wy);
  if (mon) { chase = { id: mon.id, repath: 0 }; auto = null; return send({ t: 'attack', id: mon.id }); }
  if (bossAt(p.wx, p.wy)) {
    const [bx, by] = META.building_pos.dungeon;
    if (nearTile(bx, by, 2)) return send({ t: 'boss' });
    return walkTo([[bx, by + 1]], () => send({ t: 'boss' }));
  }
  const b = buildingAt(p.wx, p.wy);
  if (b) {
    selected = b[0];
    renderBuild.scrollTo = selected;
    setTab('build');
    return;
  }
  const t = tileAt(tx, ty);
  if (RES_TILES[t]) gatherAt(tx, ty);
});

function nearTile(x, y, reach = 1) {
  return L && Math.max(Math.abs(Math.floor(L.x) - x), Math.abs(Math.floor(L.y) - y)) <= reach;
}
function gatherAt(tx, ty) {
  if (nearTile(tx, ty)) return send({ t: 'gather', x: tx, y: ty });
  const stands = [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, 1], [1, -1], [-1, -1]]
    .map(([dx, dy]) => [tx + dx, ty + dy]).filter(([x, y]) => walkable(x, y));
  walkTo(stands, () => send({ t: 'gather', x: tx, y: ty }));
}

function showCanvasTip(e) {
  const tip = $('#tip');
  const { wx, wy } = mouse;
  const tx = Math.floor(wx), ty = Math.floor(wy);
  let h = null;
  const mon = monsterAt(wx, wy);
  const mem = memberAt(wx, wy);
  const b = buildingAt(wx, wy);
  const t = tileAt(tx, ty);
  if (mon) h = `<b>${META.monsters[mon.kind] || mon.kind}</b> ${Math.max(0, Math.round(mon.hp))}/${mon.max_hp}<br><span class="muted">클릭: 공격</span>`;
  else if (bossAt(wx, wy)) h = `<b>동굴 트롤 ${S.boss.level}단계</b><br>${Math.round(S.boss.hp)}/${S.boss.max_hp}<br><span class="muted">클릭: 공격 (행동력 1)</span>`;
  else if (mem) {
    const [, m] = mem;
    h = `<b style="color:${m.color}">${esc(m.name)}</b> ${m.online ? '<span style="color:#5fbf4f">● 접속 중</span>' : `<span class="muted">${ago(m.last_seen)}</span>`}<br>${jobText(m)}`;
  } else if (b) {
    const [bid] = b;
    h = `<b>${META.buildings[bid].name}</b> ${S.buildings[bid] ? `Lv.${S.buildings[bid]}` : '(미건설)'}<br><span class="muted">${esc(META.buildings[bid].desc)}</span>`;
  } else if (RES_TILES[t]) {
    const res = RES_TILES[t];
    const bld = META.jobs[res].building;
    h = S.buildings[bld] ? `<b>${TILE_HINT[t]}</b> — 클릭(또는 옆에서 Space)으로 ${VERB[res]} 시작<br><span class="muted">걸어두면 나가 있어도 ${fmtDur(META.offline_cap + 3600 * S.buildings.inn)} 동안 계속</span>`
      : `<b>${TILE_HINT[t]}</b> — ${META.buildings[bld].name}을(를) 먼저 지어야 해요`;
  }
  if (!h) { tip.hidden = true; return; }
  tip.innerHTML = h;
  tip.hidden = false;
  tip.style.left = Math.min(window.innerWidth - tip.offsetWidth - 8, e.clientX + 14) + 'px';
  tip.style.top = Math.min(window.innerHeight - tip.offsetHeight - 8, e.clientY + 14) + 'px';
}

// ---------------- 내 캐릭터 이동 ----------------
const MOVE_KEYS = {
  KeyW: [0, -1], ArrowUp: [0, -1], KeyS: [0, 1], ArrowDown: [0, 1],
  KeyA: [-1, 0], ArrowLeft: [-1, 0], KeyD: [1, 0], ArrowRight: [1, 0],
};
const held = new Set();
let facing = [0, 1];
const walkable = (x, y) => '.,F:='.includes(tileAt(x, y));
function free(x, y) {
  const r = RADIUS, f = Math.floor;
  return walkable(f(x - r), f(y - r)) && walkable(f(x + r), f(y - r)) && walkable(f(x - r), f(y + r)) && walkable(f(x + r), f(y + r));
}
function moveBy(dx, dy) {  // 축별로 나눠 움직여 벽을 따라 미끄러지게
  let moved = false;
  if (dx && free(L.x + dx, L.y)) { L.x += dx; moved = true; }
  if (dy && free(L.x, L.y + dy)) { L.y += dy; moved = true; }
  return moved;
}
function lineFree(x0, y0, x1, y1) {
  const n = Math.ceil(Math.hypot(x1 - x0, y1 - y0) / 0.25);
  for (let i = 1; i <= n; i++) if (!free(x0 + (x1 - x0) * i / n, y0 + (y1 - y0) * i / n)) return false;
  return true;
}
function findPath(sx, sy, goals) {
  const W_ = mapRows[0].length, key = (x, y) => y * W_ + x;
  const goalSet = new Set(goals.map(([x, y]) => key(x, y)));
  const prev = new Map([[key(sx, sy), -1]]);
  const q = [[sx, sy]];
  const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
  for (let h = 0; h < q.length && q.length < 5000; h++) {
    const [x, y] = q[h];
    if (goalSet.has(key(x, y))) {
      const out = [];
      for (let k = key(x, y); k !== key(sx, sy); k = prev.get(k)) out.push([k % W_, Math.floor(k / W_)]);
      return out.reverse();
    }
    for (const [dx, dy] of dirs) {
      const nx = x + dx, ny = y + dy;
      if (!walkable(nx, ny) || prev.has(key(nx, ny))) continue;
      if (dx && dy && !(walkable(x + dx, y) && walkable(x, y + dy))) continue;
      prev.set(key(nx, ny), key(x, y));
      q.push([nx, ny]);
    }
  }
  return null;
}
// goals 중 가장 가까운 칸까지 걸어간 뒤 done 실행
function walkTo(goals, done) {
  if (!L) return false;
  const path = findPath(Math.floor(L.x), Math.floor(L.y), goals);
  if (!path) { toast('갈 수 없는 곳이에요.'); return false; }
  auto = { wps: path.map(([x, y]) => [x + 0.5, y + 0.5]), done, stuck: 0 };
  return true;
}

function updateMe(dt, t) {
  if (!L || !S || S.members[me] === undefined) return;
  const step = SPEED * dt / 1000;
  let dx = 0, dy = 0;
  for (const k of held) { dx += MOVE_KEYS[k][0]; dy += MOVE_KEYS[k][1]; }
  meMoving = false;
  if (dx || dy) {
    auto = null; chase = null;
    const n = Math.hypot(dx, dy);
    meMoving = moveBy(dx / n * step, dy / n * step);
    facing = [Math.sign(dx), Math.sign(dy)];
  } else if (auto) {
    let budget = step;
    const ox = L.x, oy = L.y;
    while (budget > 1e-6 && auto.wps.length) {
      while (auto.wps.length > 1 && lineFree(L.x, L.y, auto.wps[1][0], auto.wps[1][1])) auto.wps.shift();
      const [wx, wy] = auto.wps[0];
      const d = Math.hypot(wx - L.x, wy - L.y);
      if (d <= budget) { moveBy(wx - L.x, wy - L.y); auto.wps.shift(); budget -= d; }
      else { moveBy((wx - L.x) / d * budget, (wy - L.y) / d * budget); budget = 0; }
    }
    meMoving = Math.hypot(L.x - ox, L.y - oy) > 1e-4;
    if (!meMoving && auto.wps.length && ++auto.stuck > 15) auto = null;  // 벽에 걸림
    else if (auto && !auto.wps.length) { const done = auto.done; auto = null; if (done) done(); }
  }
  if (chase) {
    const mon = S.raid && S.raid.monsters.find((q) => q.id === chase.id);
    if (!mon) chase = null;
    else if (nearTile(mon.x, mon.y)) auto = null;
    else if (!auto || t > chase.repath) {
      chase.repath = t + 400;
      const path = findPath(Math.floor(L.x), Math.floor(L.y), [[mon.x, mon.y]]);
      auto = path ? { wps: path.slice(0, -1).map(([x, y]) => [x + 0.5, y + 0.5]), stuck: 0 } : null;
    }
  }
  // 서버에 위치 보고 (최대 초당 10회)
  if ((Math.abs(L.x - lastSent.x) > 0.01 || Math.abs(L.y - lastSent.y) > 0.01) && t - lastSent.t > 100) {
    lastSent = { x: L.x, y: L.y, t };
    send({ t: 'pos', x: Math.round(L.x * 100) / 100, y: Math.round(L.y * 100) / 100 });
  }
}

function releaseAll() { held.clear(); }
window.addEventListener('blur', releaseAll);

// Space: 일하는 중이면 열심히 일하기, 아니면 바라보는 쪽(없으면 주변) 자원으로 일 시작
function spaceAction() {
  const m = myMember();
  if (!m || !L) return;
  if (m.job) return send({ t: 'work' });
  const order = [facing, [0, 0], [1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, 1], [1, -1], [-1, -1]];
  const fx_ = Math.floor(L.x), fy = Math.floor(L.y);
  for (const [dx, dy] of order) {
    const x = fx_ + dx, y = fy + dy;
    if (RES_TILES[tileAt(x, y)]) return send({ t: 'gather', x, y });
  }
  toast('주변에 채집할 자원이 없어요. 나무·바위·물·밭 옆으로 가세요.');
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { releaseAll(); return toggleBoss(); }
  if (e.target.tagName === 'INPUT' || !S || $('#game').hidden) return;
  if (MOVE_KEYS[e.code]) {
    e.preventDefault();
    held.add(e.code);
  } else if (e.code === 'Space') {
    e.preventDefault();
    if (!e.repeat) spaceAction();
    else if (myMember() && myMember().job) send({ t: 'work' });
  } else if (e.code === 'Enter') { e.preventDefault(); releaseAll(); setTab('chat'); }
});
document.addEventListener('keyup', (e) => { if (MOVE_KEYS[e.code]) held.delete(e.code); });

const realTitle = document.title;
function toggleBoss() {
  const b = $('#boss');
  b.hidden = !b.hidden;
  document.title = b.hidden ? realTitle : '주간업무_회의록.docx';
  $('#boss-date').textContent = new Date().toLocaleDateString('ko-KR') + ' 10:00';
}

// ---------------- 렌더 ----------------
function loop(t) {
  const dt = Math.min(100, t - lastFrame);
  lastFrame = t;
  if (S && mapCache && !$('#game').hidden) draw(t, dt);
  requestAnimationFrame(loop);
}

function lerp(id, x, y, dt) {
  const r = rpos[id];
  if (!r || Math.abs(r.x - x) + Math.abs(r.y - y) > 4) return (rpos[id] = { x, y, moving: false });
  const k = Math.min(1, dt / 110);
  r.moving = Math.hypot(x - r.x, y - r.y) > 0.04;
  r.x += (x - r.x) * k;
  r.y += (y - r.y) * k;
  return r;
}

function draw(t, dt) {
  ctx.imageSmoothingEnabled = false;
  updateMe(dt, t);
  if (L) {
    rpos[me] = { x: L.x - 0.5, y: L.y - 0.5, moving: meMoving };
    const gx = Math.max(0, Math.min(mapCache.width - W, L.x * TS - W / 2));
    const gy = Math.max(0, Math.min(mapCache.height - H, L.y * TS - H / 2));
    cam.x += (gx - cam.x) * Math.min(1, dt / 80);
    cam.y += (gy - cam.y) * Math.min(1, dt / 80);
  }
  const cx = Math.round(cam.x), cy = Math.round(cam.y);
  const sx = (x) => x * TS - cx, sy = (y) => y * TS - cy;
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, W, H);
  ctx.drawImage(mapCache, -cx, -cy);

  // 물결
  ctx.fillStyle = 'rgba(200,230,255,0.25)';
  for (let i = 0; i < 30; i++) {
    const x = Math.floor(hash(i, 7) * mapRows[0].length), y = Math.floor(hash(i, 3) * mapRows.length);
    if (tileAt(x, y) === '~') ctx.fillRect(sx(x) + 6 + Math.sin(t / 500 + i) * 6, sy(y) + 14, 10, 2);
  }

  // 건물 + 사람 + 몬스터를 y 순서로
  const ents = [];
  for (const bid of Object.keys(META.building_pos)) ents.push({ y: META.building_pos[bid][1] + 0.9, f: () => drawBuilding(bid, t) });
  for (const [pid, m] of Object.entries(S.members)) {
    const r = pid === me && L ? rpos[me] : lerp(pid, m.x - 0.5, m.y - 0.5, dt);
    ents.push({ y: r.y, f: () => drawVillager(pid, m, r, sx, sy, t) });
  }
  if (S.raid) for (const mo of S.raid.monsters) {
    const r = lerp(mo.id, mo.x, mo.y, dt);
    ents.push({ y: r.y, f: () => drawMonster(mo, r, sx, sy, t) });
  }
  if (S.boss) {
    const [bx, by] = META.building_pos.dungeon;
    ents.push({ y: by + 1.5, f: () => drawBoss(bx, by + 1, sx, sy, t) });
  }
  ents.sort((a, b) => a.y - b.y).forEach((e) => e.f());

  // 망루 사격
  for (let i = beams.length - 1; i >= 0; i--) {
    const b = beams[i], k = (t - b.t0) / 250;
    if (k >= 1) { beams.splice(i, 1); continue; }
    ctx.strokeStyle = `rgba(255,230,120,${1 - k})`;
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(sx(b.x0) + 16, sy(b.y0)); ctx.lineTo(sx(b.x) + 16, sy(b.y) + 16); ctx.stroke();
  }
  drawParticles(t, dt, sx, sy);
  drawNight(sx, sy, t);
  drawFx(cx, cy, t);
  drawHud(t);
  drawMinimap();
  const ban = $('#banner');
  if (S.raid) {
    ban.hidden = false;
    ban.innerHTML = `🚨 습격! 남은 시간 ${fmtDur(S.raid.deadline - now())} · 남은 몬스터 ${S.raid.monsters.length}<br><span class="muted">몬스터를 클릭해서 공격 · 못 막으면 자원을 빼앗겨요</span>`;
  } else ban.hidden = true;
}

function drawVillager(pid, m, r, sx, sy, t) {
  // 같은 칸에 여러 명이 서도 겹치지 않게 사람마다 살짝 비켜 그림
  const off = (parseInt(pid.slice(0, 2), 16) % 5) - 2;
  const px = sx(r.x) + off * 4, py = sy(r.y) + (off % 2) * 3;
  if (px < -40 || px > W + 40 || py < -40 || py > H + 40) return;
  const moving = r.moving;
  const working = m.job && !moving;
  let bob = moving ? -Math.abs(Math.sin(t / 70)) * 3 : 0;
  if (working && m.online) bob = -Math.abs(Math.sin(t / 180)) * 2;
  ctx.fillStyle = 'rgba(0,0,0,0.3)';
  ctx.beginPath(); ctx.ellipse(px + 16, py + 29, 9, 3, 0, 0, Math.PI * 2); ctx.fill();
  ctx.globalAlpha = m.online ? 1 : 0.55;
  ctx.drawImage(buildSprite('villager', { cloth: m.color }), px, py + bob, TS, TS);
  // 하는 일 표시
  if (working) {
    const swing = m.online ? Math.sin(t / 150) * 0.6 : 0.2;
    ctx.save();
    ctx.translate(px + 26, py + 16);
    ctx.rotate(swing);
    ctx.drawImage(buildSprite(m.job.res), -6, -14, 14, 14);
    ctx.restore();
  }
  ctx.globalAlpha = 1;
  // 이름
  ctx.font = FONT(11);
  ctx.textAlign = 'center';
  const name = m.name + (m.online ? '' : ' (zZ)');
  ctx.fillStyle = '#000b'; ctx.fillText(name, px + 17, py - 3);
  ctx.fillStyle = m.online ? m.color : '#c8c8c8'; ctx.fillText(name, px + 16, py - 4);
  if (pid === me) {
    ctx.fillStyle = '#f5c542';
    const ty = py - 24 + Math.sin(t / 200) * 2;
    ctx.beginPath(); ctx.moveTo(px + 12, ty); ctx.lineTo(px + 20, ty); ctx.lineTo(px + 16, ty + 5); ctx.fill();
  }
}

function drawMonster(mo, r, sx, sy, t) {
  const n = parseInt(mo.id.slice(1), 10) || 0;  // 같은 칸에 몰려도 구분되게
  const px = sx(r.x) + ((n % 3) - 1) * 9, py = sy(r.y) + ((Math.floor(n / 3) % 3) - 1) * 6;
  const flash = flashAt[mo.id] && t - flashAt[mo.id] < 100;
  ctx.fillStyle = 'rgba(0,0,0,0.3)';
  ctx.beginPath(); ctx.ellipse(px + 16, py + 29, 9, 3, 0, 0, Math.PI * 2); ctx.fill();
  ctx.drawImage(buildSprite(mo.kind, { flash }), px, py + Math.sin(t / 200 + px) * 1.5, TS, TS);
  ctx.fillStyle = '#000'; ctx.fillRect(px + 2, py - 4, 28, 4);
  ctx.fillStyle = '#e0524a'; ctx.fillRect(px + 2, py - 4, 28 * Math.max(0, mo.hp / mo.max_hp), 4);
}

function drawBoss(bx, by, sx, sy, t) {
  const px = sx(bx) - TS * 0.5, py = sy(by) - TS;
  const flash = flashAt.boss && t - flashAt.boss < 100;
  const size = TS * 2;
  ctx.drawImage(buildSprite('troll', { flash }), px, py + Math.sin(t / 400) * 2, size, size);
  const w = 70;
  ctx.fillStyle = '#000'; ctx.fillRect(px + size / 2 - w / 2, py - 8, w, 6);
  ctx.fillStyle = '#ff3b2f'; ctx.fillRect(px + size / 2 - w / 2, py - 8, w * Math.max(0, S.boss.hp / S.boss.max_hp), 6);
  ctx.font = FONT(11); ctx.textAlign = 'center'; ctx.fillStyle = '#ff9a8a';
  ctx.fillText(`동굴 트롤 ${S.boss.level}단계`, px + size / 2, py - 12);
}

function drawParticles(t, dt, sx, sy) {
  for (let i = parts.length - 1; i >= 0; i--) {
    const p = parts[i], age = (t - p.t0) / 700;
    if (age >= 1) { parts.splice(i, 1); continue; }
    p.x += p.vx * dt / 1000 * 2; p.y += p.vy * dt / 1000 * 2; p.vy += dt / 1000 * 5;
    ctx.globalAlpha = 1 - age;
    ctx.fillStyle = p.c;
    ctx.fillRect(sx(p.x) - 2, sy(p.y) - 2, 4, 4);
  }
  ctx.globalAlpha = 1;
}

function drawFx(cx, cy, t) {
  ctx.textAlign = 'center';
  for (let i = fx.length - 1; i >= 0; i--) {
    const f = fx[i], age = (t - f.t0) / 1100;
    if (age >= 1) { fx.splice(i, 1); continue; }
    ctx.globalAlpha = 1 - age * age;
    ctx.font = FONT(f.size);
    const x = f.x - cx, y = f.y - cy - age * 28;
    if (f.icon) ctx.drawImage(buildSprite(f.icon), x - ctx.measureText(f.text).width / 2 - 16, y - 12, 14, 14);
    ctx.fillStyle = '#000'; ctx.fillText(f.text, x + 1, y + 1);
    ctx.fillStyle = f.color; ctx.fillText(f.text, x, y);
  }
  ctx.globalAlpha = 1;
}

// 실제 시각에 맞춘 낮/밤
function drawNight(sx, sy) {
  const h = new Date().getHours() + new Date().getMinutes() / 60;
  let dark = 0;
  if (h >= 18 && h < 20) dark = (h - 18) / 2;
  else if (h >= 20 || h < 5) dark = 1;
  else if (h >= 5 && h < 7) dark = 1 - (h - 5) / 2;
  if (dark <= 0) return;
  ctx.save();
  ctx.fillStyle = `rgba(10,15,45,${0.45 * dark})`;
  ctx.fillRect(0, 0, W, H);
  ctx.globalCompositeOperation = 'lighter';
  const lights = Object.entries(META.building_pos).filter(([bid]) => S.buildings[bid] > 0 && bid !== 'bridge')
    .map(([, [x, y]]) => [x, y]);
  for (const m of Object.values(S.members)) if (m.online) lights.push([m.x - 0.5, m.y - 0.5]);
  for (const [x, y] of lights) {
    const px = sx(x) + 16, py = sy(y) + 8;
    const g = ctx.createRadialGradient(px, py, 4, px, py, 70);
    g.addColorStop(0, `rgba(255,190,90,${0.25 * dark})`);
    g.addColorStop(1, 'rgba(255,190,90,0)');
    ctx.fillStyle = g;
    ctx.fillRect(px - 70, py - 70, 140, 140);
  }
  ctx.restore();
}

function drawMinimap() {
  const s = 3, w = mapRows[0].length * s, h = mapRows.length * s;
  const ox = W - w - 8, oy = 8;
  if (!drawMinimap.cache || drawMinimap.bridge !== mapBridge) {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const g = c.getContext('2d');
    const col = { '~': '#2f6fa8', b: '#2f6fa8', '=': '#8b5a2b', T: '#2e6b2a', R: '#8a8a95', F: '#7a5a32', ':': '#4a4452', m: '#c98e62', ',': '#b89a68', '#': '#1e3a1a', B: '#558f40' };
    for (let y = 0; y < mapRows.length; y++) for (let x = 0; x < mapRows[0].length; x++) {
      g.fillStyle = col[mapRows[y][x]] || '#558f40';
      g.fillRect(x * s, y * s, s, s);
    }
    drawMinimap.cache = c;
    drawMinimap.bridge = mapBridge;
  }
  ctx.globalAlpha = 0.85;
  ctx.fillStyle = '#000'; ctx.fillRect(ox - 3, oy - 3, w + 6, h + 6);
  ctx.drawImage(drawMinimap.cache, ox, oy);
  ctx.globalAlpha = 1;
  for (const [bid, [x, y]] of Object.entries(META.building_pos)) {
    if (!S.buildings[bid]) continue;
    ctx.fillStyle = '#e8d9b5'; ctx.fillRect(ox + x * s - 1, oy + y * s - 1, 4, 4);
  }
  if (S.raid) for (const mo of S.raid.monsters) { ctx.fillStyle = '#ff3b2f'; ctx.fillRect(ox + mo.x * s, oy + mo.y * s, 3, 3); }
  for (const m of Object.values(S.members)) {
    ctx.fillStyle = m.online ? m.color : '#888';
    ctx.fillRect(ox + m.x * s - 1, oy + m.y * s - 1, 4, 4);
  }
  ctx.strokeStyle = 'rgba(255,255,255,0.6)';
  ctx.strokeRect(ox + (cam.x / TS) * s, oy + (cam.y / TS) * s, (W / TS) * s, (H / TS) * s);
}

// 하단: 내 작업 카드
function drawHud(t) {
  const m = myMember();
  if (!m) return;
  const x = 10, y = H - 70, w = 360, h = 60;
  ctx.fillStyle = 'rgba(0,0,0,0.65)';
  ctx.fillRect(x, y, w, h);
  ctx.strokeStyle = '#3f3a4d';
  ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
  ctx.textAlign = 'left';
  if (!m.job) {
    ctx.font = FONT(13); ctx.fillStyle = '#ece8f2';
    ctx.fillText('WASD/방향키로 이동 · 자원을 클릭하거나', x + 12, y + 24);
    ctx.fillText('자원 옆에서 Space를 누르면 일을 시작해요', x + 12, y + 42);
    ctx.font = FONT(11); ctx.fillStyle = '#9c95ad';
    ctx.fillText('일을 걸어두면 창을 닫아도 계속 일해요', x + 12, y + 56);
    return;
  }
  const j = m.job, left = j.end - now();
  ctx.drawImage(buildSprite(j.res), x + 8, y + 10, 40, 40);
  ctx.font = FONT(13); ctx.fillStyle = '#ece8f2';
  ctx.fillText(`${VERB[j.res]} 중 · 분당 ${j.rate}개`, x + 56, y + 22);
  ctx.font = FONT(11); ctx.fillStyle = '#9c95ad';
  ctx.fillText(`이번 작업 +${j.total} · ${left > 0 ? fmtDur(left) + ' 동안 계속' : '곧 끝남'}`, x + 56, y + 40);
  ctx.fillStyle = '#f5c542';
  ctx.fillText('Space: 열심히 일하기', x + 56, y + 54);
}

init();
