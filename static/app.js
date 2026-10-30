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
const shakeAt = {};            // 자원 칸 "x,y" -> 맞은 시각 (흔들림)
const attackAt = {};           // 주민 id -> 공격한 시각 (무기 휘두르기)
const workAnim = {};           // 주민 id -> 지난 프레임의 작업 동작 위치
let hurtAt = 0;                // 내가 맞은 시각 (화면 붉게)
let objRows = [];              // 줄마다 나무·바위 같은 오브젝트 목록
let lastFrame = performance.now();
// 내 캐릭터는 브라우저가 직접 움직인다 (서버는 검증만). 좌표는 칸 중심 기준 실수.
const SPEED = 6.5, RADIUS = 0.3;
let L = null;                  // 내 위치
let auto = null;               // 자동 걷기 {wps: [[x, y]...], done}
let chase = null;              // 쫓아가는 습격 몬스터 {id, repath}
let meMoving = false;
let meFlip = false;            // 왼쪽을 보고 있는지 (Kenney 캐릭터는 기본이 오른쪽)
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
const tileImg = (t, size) => `<img src="${tileURL(t)}" width="${size}" height="${size}" alt="" style="image-rendering:pixelated">`;
const resImg = (r, size) => (RES_ICON[r] ? tileImg(RES_ICON[r], size) : img(r, size));
function heroOf(pid) {
  const i = Object.keys(S.members).indexOf(pid);
  return HEROES[(i < 0 ? 0 : i) % HEROES.length];
}
function drawResIcon(c, r, x, y, size) {
  if (RES_ICON[r]) drawTile(c, RES_ICON[r], x, y, size);
  else c.drawImage(buildSprite(r), x, y, size, size);
}
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
function allMonsters() { return S ? [...((S.raid && S.raid.monsters) || []), ...(S.wild || [])] : []; }
const depKey = (x, y) => `${x},${y}`;
function depleted(x, y) { return S && S.dep && S.dep[depKey(x, y)]; }

// ---------------- 접속 ----------------
async function init() {
  META = await (await fetch('/api/meta')).json();
  await loadSheets();
  $('#name').value = lsGet('name') || '';
  const q = new URLSearchParams(location.search).get('v');
  if (q) $('#code').value = q.toUpperCase();
  $('#btn-join').onclick = () => enter($('#code').value.trim().toUpperCase());
  $('#code').onkeydown = (e) => { if (e.key === 'Enter') $('#btn-join').click(); };
  $('#btn-create').onclick = createVillage;
  $('#vname').onkeydown = (e) => { if (e.key === 'Enter') createVillage(); };
  $('#btn-gear').onclick = () => toggleGear();
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
  renderGear();
}

function applyTick(m) {
  if (!S) return;
  for (const [pid, x, y, hp] of m.p) {
    const mem = S.members[pid];
    if (mem) { mem.x = x; mem.y = y; if (hp !== undefined) mem.hp = hp; }
  }
  if (m.w && S.wild) {
    const rows = new Map(m.w.map((r) => [r[0], r]));
    for (const mo of S.wild) { const r = rows.get(mo.id); if (r) { mo.x = r[1]; mo.y = r[2]; mo.hp = r[3]; } }
  }
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
  const mo = allMonsters().find((q) => q.id === id);
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
      if (S.members[e.src]) attackAt[e.src] = t;
      const onPlayer = !!S.members[e.tgt];
      if (e.tgt === me) hurtAt = t;
      if (p) floatText(p.x + (Math.random() - 0.5) * 0.6, p.y - 0.6, `${onPlayer ? '-' : ''}${e.v}`, onPlayer ? '#ff6b5e' : '#ffffff', 14);
    } else if (e.k === 'die') {
      const p = entityPos(e.tgt);
      if (p) {
        burst(p.x, p.y, '#ffffff', 14);
        (e.drops || []).forEach((d, i) => floatText(p.x, p.y - 0.9 - i * 0.45, d, '#ffd27a', 12));
      }
      if (S.raid) S.raid.monsters = S.raid.monsters.filter((q) => q.id !== e.tgt);
      if (S.wild) S.wild = S.wild.filter((q) => q.id !== e.tgt);
    } else if (e.k === 'fell') {
      if (S.dep) S.dep[depKey(e.x, e.y)] = now() + (META.regrow[e.res] || 600);
      burst(e.x, e.y - 0.3, e.res === 'wood' ? '#b07b45' : e.res === 'food' ? '#9bd35a' : '#c0cbdc', 18);
    } else if (e.k === 'regrow') {
      if (S.dep) delete S.dep[depKey(e.x, e.y)];
    } else if (e.k === 'down') {
      if (e.pid === me) toast('쓰러졌어요... 마을 분수 앞에서 정신을 차렸습니다.');
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
    return `<span class="res ${v >= cap ? 'full' : ''}" title="${resName(r)} (최대 ${cap})">${resImg(r, 20)}
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
  return Object.entries(cost).map(([r, v]) => `<span class="${S.res[r] < v ? 'no' : ''}">${resImg(r, 14)}${v}</span>`).join('');
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
    ${tileImg(heroOf(pid), 28)}
    <div class="info"><b>${i + 1}. ${esc(m.name)}</b>${pid === me ? ' (나)' : ''}
      <span class="${m.online ? 'on' : 'muted'}">${m.online ? '● 접속 중' : `· ${ago(m.last_seen)}`}</span>
      <div class="muted">${jobText(m)}</div>
      <div class="muted">기여 ${m.contrib} · ${Object.entries(m.skills).map(([k, v]) => `${k === 'combat' ? '전투' : VERB[k]} ${v}`).join(' ')}</div></div></div>`).join('');
}

function renderMe() {
  const m = myMember();
  if (!m) return;
  const smithy = S.buildings.smithy;
  let h = `<div class="person">${tileImg(heroOf(me), 40)}<div class="info"><b>${esc(m.name)}</b>
    <div>${resImg('gold', 14)} 동전 ${m.coins} · 기여도 ${m.contrib}</div>
    ${S.buildings.dungeon ? `<div class="muted">행동력 ${Math.floor(m.energy)}/${META.energy_max} (${META.energy_regen / 60}분마다 1)</div>` : ''}</div></div>
    <h4>숙련도</h4><div class="skills">`;
  for (const [k, v] of Object.entries(m.skills)) {
    h += `<span>${k === 'combat' ? '전투' : VERB[k]} <b>Lv.${v}</b> <span class="muted">(${m.xp[k]}xp)</span></span>`;
  }
  const w = META.gear[m.eq.weapon], a = META.gear[m.eq.armor];
  h += `</div><h4>장비</h4><div class="tool"><span class="nm">${w ? w.name : '무기 없음'} · ${a ? a.name : '갑옷 없음'}</span>
    <button class="btn small" data-open-gear>장비창 열기 (I)</button></div>
    <p class="muted">동전은 채집(10개당 1), 몬스터 사냥, 습격 방어, 보스 공격으로 얻어요.</p>
    <h4>마을 기록</h4><div class="muted">습격 방어 ${S.stats.raids_won} · 실패 ${S.stats.raids_lost} · 보스 처치 ${S.stats.bosses} · 사냥 ${S.stats.kills || 0}</div>`;
  $('#tab-me').innerHTML = h;
}
$('#tab-me').addEventListener('click', (e) => {
  if (e.target.closest('[data-open-gear]')) toggleGear(true);
});

// ---------------- 장비창 ----------------
let gearOpen = false;
function toggleGear(open) {
  gearOpen = open === undefined ? !gearOpen : open;
  $('#win-gear').hidden = !gearOpen;
  if (gearOpen) { releaseAll(); renderGear(); }
}
const SLOT_NAME = { weapon: '무기', armor: '갑옷' };
function statOf(g) { return g.slot === 'weapon' ? `공격 +${g.atk}` : `방어 +${g.df} · 체력 +${g.hp}`; }
function diffOf(g, cur) {
  if (!cur || cur === g) return '';
  const d = g.slot === 'weapon' ? [['공격', g.atk - cur.atk]] : [['방어', g.df - cur.df], ['체력', g.hp - cur.hp]];
  return d.filter(([, v]) => v).map(([k, v]) => `<span class="${v > 0 ? 'up' : 'down'}">${k} ${v > 0 ? '+' : ''}${v}</span>`).join(' ');
}
function renderGear() {
  const m = myMember();
  if (!m || !gearOpen) return;
  const smithy = S.buildings.smithy;
  const w = META.gear[m.eq.weapon], a = META.gear[m.eq.armor];
  const slot = (key, g, gid) => `<div class="slot ${g ? 'filled' : 'empty'}" title="${g ? `${g.name} · ${statOf(g)}` : ''}">
    ${tileImg(g ? GEAR_TILE[gid] : (key === 'weapon' ? GEAR_TILE.club : GEAR_TILE.leather_armor), 40)}
    <span>${g ? g.name : '비어 있음'}</span><span class="sn">${SLOT_NAME[key]}</span></div>`;
  const atk = 6 + (w ? w.atk : 0) + m.skills.combat, df = a ? a.df : 0;
  let L_ = `<div class="doll">${slot('weapon', w, m.eq.weapon)}<div class="hero">${tileImg(heroOf(me), 96)}</div>${slot('armor', a, m.eq.armor)}</div>
    <div class="muted">체력 ${m.hp} / ${m.max_hp}</div><div class="hpbar"><div style="width:${(m.hp / m.max_hp) * 100}%"></div></div>
    <div class="gstats"><span>공격력 <b>${atk}</b></span><span>방어력 <b>${df}</b></span>
      <span>전투 Lv <b>${m.skills.combat}</b></span><span>동전 <b>${m.coins}</b></span></div>
    <h4>채집 도구 ${smithy ? `<span class="muted">(대장간 Lv.${smithy}까지 강화)</span>` : '<span class="muted">— 대장간이 있어야 강화</span>'}</h4>`;
  for (const [k, name] of Object.entries(META.tools)) {
    const lvl = m.tools[k], price = META.tool_prices[lvl];
    const can = smithy && lvl < Math.min(META.tool_max, smithy) && m.coins >= price;
    L_ += `<div class="gitem">${resImg(k, 22)}<span class="nm">${name} <b>+${lvl}</b><br><span class="muted">채집 +${lvl * 15}%</span></span>
      ${lvl < META.tool_max ? `<button class="btn small" data-buy="${k}" ${can ? '' : 'disabled'}>${price}동전</button>` : '<span class="muted">최대</span>'}</div>`;
  }
  $('#gear-left').innerHTML = L_;
  let R = '';
  for (const key of ['weapon', 'armor']) {
    R += `<h4>${SLOT_NAME[key]}</h4>`;
    const cur = META.gear[m.eq[key]];
    for (const [gid, g] of Object.entries(META.gear)) {
      if (g.slot !== key) continue;
      const owned = m.gear.includes(gid), worn = m.eq[key] === gid;
      const needSmithy = g.smithy && smithy < g.smithy;
      const short = Object.entries(g.cost).some(([r, v]) => S.res[r] < v) || m.coins < g.coins;
      let btn;
      if (worn) btn = '<span class="muted">착용 중</span>';
      else if (owned) btn = `<button class="btn small primary" data-equip="${gid}">장착</button>`;
      else btn = `<button class="btn small" data-craft="${gid}" ${needSmithy || short ? 'disabled' : ''}>제작</button>`;
      R += `<div class="gitem ${worn ? 'worn' : ''} ${!owned && needSmithy ? 'locked' : ''}">${tileImg(GEAR_TILE[gid], 32)}
        <span class="nm"><b>${g.name}</b> <span class="muted">${statOf(g)}</span> ${diffOf(g, cur)}
        ${owned ? '<div class="muted">보유</div>' : `<div class="cost">${costHTML(g.cost)}${g.coins ? `<span>${resImg('gold', 12)}${g.coins}동전</span>` : ''}
        ${needSmithy ? `<span class="muted">대장간 Lv.${g.smithy} 필요</span>` : ''}</div>`}</span>${btn}</div>`;
    }
  }
  R += '<p class="muted">재료는 마을 창고에서, 동전은 내 지갑에서 나가요. 가죽은 늑대·쥐 같은 야생 몬스터에게서 얻어요.</p>';
  $('#gear-right').innerHTML = R;
}
$('#win-gear').addEventListener('click', (e) => {
  if (e.target.closest('[data-close]')) return toggleGear(false);
  const b = e.target.closest('[data-buy]');
  if (b) return send({ t: 'buy', kind: b.dataset.buy });
  const c = e.target.closest('[data-craft]');
  if (c) return send({ t: 'craft', id: c.dataset.craft });
  const q = e.target.closest('[data-equip]');
  if (q) send({ t: 'equip', id: q.dataset.equip });
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
  const pick = (arr, x, y) => arr[Math.floor(hash(x, y) * arr.length)];
  const isWater = (x, y) => '~b='.includes(tileAt(x, y));
  const isField = (x, y) => tileAt(x, y) === 'F';
  const waterTile = (x, y) => {
    const W_ = TILES.water;
    const up = !isWater(x, y - 1), dn = !isWater(x, y + 1), lf = !isWater(x - 1, y), rt = !isWater(x + 1, y);
    if (up && lf) return W_.tl;
    if (up && rt) return W_.tr;
    if (dn && lf) return W_.bl;
    if (dn && rt) return W_.br;
    if (up) return W_.t;
    if (dn) return W_.b;
    if (lf) return W_.l;
    if (rt) return W_.r;
    if (!isWater(x - 1, y - 1)) return W_.itl;
    if (!isWater(x + 1, y - 1)) return W_.itr;
    if (!isWater(x - 1, y + 1)) return W_.ibl;
    if (!isWater(x + 1, y + 1)) return W_.ibr;
    return W_.c;
  };
  objRows = Array.from({ length: h }, () => []);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const t = mapRows[y][x], px = x * TS, py = y * TS;
      // 바닥
      if (t === ':' || t === 'm') {
        drawTile(c, pick(TILES.stoneFloor, x, y), px, py);
        const r = hash(x + 7, y);
        if (r > 0.6) { c.fillStyle = '#9aa3b5'; c.fillRect(px + ((r * 97) | 0) % 24 + 2, py + ((r * 53) | 0) % 22 + 4, 4, 3); }
        if (r < 0.15) { c.fillStyle = '#b4bccb'; c.fillRect(px + 8, py + 20, 6, 2); }
      }
      else if (t === ',') drawTile(c, pick(TILES.dirt, x, y), px, py);
      else if (isWater(x, y)) drawTile(c, waterTile(x, y), px, py);
      else if (t === 'F') {
        const F_ = TILES.field;
        drawTile(c, TILES.grass[0], px, py);
        drawTile(c, !isField(x - 1, y) ? F_.l : !isField(x + 1, y) ? F_.r : F_.m[x % 2], px, py);
      } else drawTile(c, pick(TILES.grass, x, y), px, py);
      // 나무·바위·광석·작물은 캐시에 넣지 않고 매 프레임 따로 그린다 (흔들림, 사라짐, 앞뒤 가림)
      if (t === 'T' || t === '#') {
        const tr = t === '#' ? TILES.trees[3] : pick(TILES.trees, x, y);
        objRows[y].push({ x, y, k: t, tile: tr, top: TILES.treeTop[tr[1]] });
      } else if (t === 'R') objRows[y].push({ x, y, k: t, tile: pick(TILES.rocks, x, y) });
      else if (t === 'm') objRows[y].push({ x, y, k: t, tile: TILES.rocks[0], spark: hash(x, y) });
      else if (t === 'F') objRows[y].push({ x, y, k: t, tile: hash(x * 3, y) > 0.35 ? TILES.crops[y % TILES.crops.length] : null });
      else if (t === 'b' || t === '=') {
        c.fillStyle = '#5a3a1a';
        c.fillRect(px + 4, py + 2, 4, 28); c.fillRect(px + 24, py + 2, 4, 28);
        if (t === '=') {
          c.fillStyle = '#b07b45'; c.fillRect(px, py + 4, TS, TS - 8);
          c.fillStyle = '#8b5a2b'; for (let i = 0; i < TS; i += 8) c.fillRect(px + i, py + 4, 2, TS - 8);
          c.fillStyle = '#5a3a1a'; c.fillRect(px, py + 4, TS, 2); c.fillRect(px, py + TS - 6, TS, 2);
        }
      }
    }
  }
  makeAnimals();
}

// 농장 근처를 돌아다니는 동물 (화면 연출)
let animals = [];
const FARM = { x1: 42, x2: 58, y1: 5, y2: 17 };
function makeAnimals() {
  animals = ANIMALS.map((t, i) => {
    const x = FARM.x1 + hash(i, 9) * (FARM.x2 - FARM.x1), y = FARM.y1 + hash(i, 4) * (FARM.y2 - FARM.y1);
    return { t, x, y, tx: x, ty: y, wait: 0, flip: false };
  });
}
function updateAnimals(dt) {
  for (const a of animals) {
    if (a.wait > 0) { a.wait -= dt; continue; }
    const dx = a.tx - a.x, dy = a.ty - a.y, d = Math.hypot(dx, dy);
    if (d < 0.05) {
      a.wait = 1000 + Math.random() * 4000;
      a.tx = Math.min(FARM.x2, Math.max(FARM.x1, a.x + (Math.random() - 0.5) * 4));
      a.ty = Math.min(FARM.y2, Math.max(FARM.y1, a.y + (Math.random() - 0.5) * 3));
      if (!'.F'.includes(tileAt(Math.floor(a.tx), Math.floor(a.ty)))) { a.tx = a.x; a.ty = a.y; }
      continue;
    }
    const sp = Math.min(d, dt / 1000 * 1.2);
    a.x += dx / d * sp; a.y += dy / d * sp;
    a.flip = dx < 0;
  }
}

// 나무·바위·광석·작물 (다 캔 곳은 그루터기/돌무더기/빈 밭, 다시 자라는 중엔 묘목/새싹)
function drawObj(o, sx, sy, t) {
  const px = sx(o.x), py = sy(o.y);
  const k = depKey(o.x, o.y);
  const dep = o.k !== '#' && depleted(o.x, o.y);
  if (dep) {
    const res = RES_TILES[o.k];
    const prog = 1 - Math.max(0, dep - now()) / (META.regrow[res] || 600);
    if (o.k === 'T') {
      if (prog > 0.5) drawTile(ctx, TILES.sapling, px, py);
      else {
        ctx.fillStyle = 'rgba(0,0,0,0.25)'; ctx.beginPath(); ctx.ellipse(px + 16, py + 28, 10, 3, 0, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = '#6b4220'; ctx.fillRect(px + 9, py + 15, 14, 13);
        ctx.fillStyle = '#4a2c14'; ctx.fillRect(px + 9, py + 15, 2, 13); ctx.fillRect(px + 21, py + 15, 2, 13);
        ctx.fillStyle = '#d9a86a'; ctx.beginPath(); ctx.ellipse(px + 16, py + 15, 7, 3.5, 0, 0, Math.PI * 2); ctx.fill();
        ctx.strokeStyle = '#a8743f'; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.ellipse(px + 16, py + 15, 3.5, 1.6, 0, 0, Math.PI * 2); ctx.stroke();
      }
    } else if (o.k === 'F') { if (prog > 0.5) drawTile(ctx, TILES.sprout, px, py); }
    else { ctx.globalAlpha = 0.75; drawTile(ctx, TILES.rubble, px, py + 4, 28); ctx.globalAlpha = 1; }
    return;
  }
  const since = shakeAt[k] ? t - shakeAt[k] : 999;
  const sh = since < 260 ? Math.sin(since / 20) * 3 * (1 - since / 260) : 0;
  if (o.tile) drawTile(ctx, o.tile, px + sh, py);
  if (o.top) drawTile(ctx, o.top, px + sh * 1.6, py - TS);
  if (o.k === 'm') {
    const r = o.spark, glow = 0.6 + Math.sin(t / 300 + r * 9) * 0.4;
    ctx.globalAlpha = glow;
    ctx.fillStyle = r < 0.5 ? '#ff9f1c' : '#c9b8ff';
    ctx.fillRect(px + 10 + ((r * 31) | 0) % 8 + sh, py + 14, 4, 4);
    ctx.fillRect(px + 18 + sh, py + 20 - ((r * 17) | 0) % 6, 3, 3);
    ctx.globalAlpha = 1;
  }
}

// 작업 중 도구가 대상에 닿는 순간: 대상 흔들림 + 파편
const CHIP = { wood: ['#b07b45', '#e0b070', '#5a3a1a'], stone: ['#c0cbdc', '#ffffff', '#8b9bb4'],
  ore: ['#ff9f1c', '#c9b8ff', '#ffffff'], food: ['#9bd35a', '#8b5a2b', '#e8c170'] };
function impact(job, strong) {
  shakeAt[depKey(job.tx, job.ty)] = performance.now();
  const cols = CHIP[job.res];
  if (!cols) return;
  const t = performance.now();
  for (let i = 0; i < (strong ? 6 : 2); i++) {
    const a = -Math.PI / 2 + (Math.random() - 0.5) * 2.2, sp = 0.8 + Math.random() * 1.6;
    parts.push({ x: job.tx + 0.5, y: job.ty + 0.6, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, t0: t, c: cols[i % cols.length] });
  }
}

// 건물 그리기 (레벨 0이면 공터 표지판)
function drawBuilding(bid, t) {
  const art = BUILD_ART[bid];
  const [bx, by] = META.building_pos[bid];
  const lvl = S.buildings[bid];
  const cons = S.construction && S.construction.id === bid;
  if (bid === 'bridge') {
    if (lvl || cons) label(bid, bx * TS - Math.round(cam.x) + TS / 2, by * TS - Math.round(cam.y) - 6, lvl);
    return;
  }
  const w = art.rows[0].length, rows = art.rows.length;
  const left = (w % 2 ? bx - Math.floor(w / 2) : bx) * TS - Math.round(cam.x);
  const bottom = (by + 1) * TS - Math.round(cam.y);
  const top = bottom - rows * TS;
  const cxp = left + (w * TS) / 2;
  if (left < -140 || left > W + 100 || bottom < -40 || top > H + 60) return;
  if (!lvl && !cons) {
    ctx.strokeStyle = 'rgba(255,255,255,0.4)';
    ctx.setLineDash([4, 4]);
    ctx.strokeRect(left + 2, bottom - TS * Math.min(rows, 2) + 2, w * TS - 4, TS * Math.min(rows, 2) - 4);
    ctx.setLineDash([]);
    drawTile(ctx, TILES.sign, cxp - TS / 2, bottom - TS);
    label(bid, cxp, bottom - TS * Math.min(rows, 2) - 6, 0, true);
    return;
  }
  if (cons) ctx.globalAlpha = 0.45 + 0.5 * (1 - S.construction.left / S.construction.total);
  if (art.glow) {
    const g = ctx.createRadialGradient(cxp, bottom - TS, 4, cxp, bottom - TS, 70);
    g.addColorStop(0, `rgba(160,80,255,${0.35 + Math.sin(t / 300) * 0.12})`);
    g.addColorStop(1, 'rgba(160,80,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(cxp - 70, bottom - TS - 70, 140, 140);
  }
  if (art.pier) {
    ctx.fillStyle = '#8b5a2b'; ctx.fillRect(cxp - 10, bottom - 14, 56, 12);
    ctx.fillStyle = '#5a3a1a'; for (let i = 0; i < 56; i += 8) ctx.fillRect(cxp - 10 + i, bottom - 14, 1, 12);
    ctx.fillRect(cxp + 40, bottom - 4, 4, 10);
  }
  ctx.fillStyle = 'rgba(0,0,0,0.25)';
  ctx.fillRect(left + 4, bottom - 4, w * TS, 6);
  art.rows.forEach((row, ri) => row.forEach((tt, ci) => drawTile(ctx, tt, left + ci * TS, top + ri * TS)));
  for (const e of art.extra || []) drawTile(ctx, e.t, cxp - TS / 2 + e.dx * TS, bottom - TS + e.dy * TS);
  if (art.smoke) {
    ctx.fillStyle = 'rgba(220,220,220,0.45)';
    for (let i = 0; i < 3; i++) {
      const k = (t / 1600 + i / 3) % 1;
      ctx.beginPath(); ctx.arc(left + TS * 2 - 6 + k * 10, top - k * 30, 3 + k * 5, 0, Math.PI * 2); ctx.fill();
    }
  }
  ctx.globalAlpha = 1;
  if (cons) {
    ctx.strokeStyle = '#c99a5a'; ctx.lineWidth = 2;
    for (let i = 0; i <= w; i++) { ctx.beginPath(); ctx.moveTo(left + i * TS, bottom); ctx.lineTo(left + i * TS, top - 6); ctx.stroke(); }
    for (let j = 0; j <= rows; j++) { ctx.beginPath(); ctx.moveTo(left - 4, bottom - j * TS); ctx.lineTo(left + w * TS + 4, bottom - j * TS); ctx.stroke(); }
    const k = 1 - S.construction.left / S.construction.total;
    ctx.fillStyle = '#000'; ctx.fillRect(cxp - 30, bottom + 4, 60, 6);
    ctx.fillStyle = '#5fbf4f'; ctx.fillRect(cxp - 30, bottom + 4, 60 * k, 6);
    if (Math.random() < 0.05) burst(bx + Math.random() - 0.5, by - 0.5, '#c99a5a', 2);
  }
  label(bid, cxp, top - (art.extra || []).some((e) => e.dy <= -rows) * TS - 6, lvl);
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
  return allMonsters().find((m) => { const p = rpos[m.id] || m; return Math.abs(p.x + 0.5 - wx) < 0.7 && Math.abs(p.y + 0.4 - wy) < 0.7; });
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
  if (RES_TILES[t]) {
    if (depleted(tx, ty)) return toast('이미 다 캔 곳이에요. 다시 자랄 때까지 기다려주세요.');
    gatherAt(tx, ty);
  }
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
  if (mon) {
    const w = META.wild[mon.kind];
    h = `<b>${META.monsters[mon.kind] || mon.kind}</b> ${Math.max(0, Math.round(mon.hp))}/${mon.max_hp}${w ? ` · 공격력 ${w.atk}` : ''}<br><span class="muted">클릭: 공격</span>`;
  }
  else if (bossAt(wx, wy)) h = `<b>동굴 트롤 ${S.boss.level}단계</b><br>${Math.round(S.boss.hp)}/${S.boss.max_hp}<br><span class="muted">클릭: 공격 (행동력 1)</span>`;
  else if (mem) {
    const [, m] = mem;
    h = `<b style="color:${m.color}">${esc(m.name)}</b> ${m.online ? '<span style="color:#5fbf4f">● 접속 중</span>' : `<span class="muted">${ago(m.last_seen)}</span>`}<br>${jobText(m)}`;
  } else if (b) {
    const [bid] = b;
    h = `<b>${META.buildings[bid].name}</b> ${S.buildings[bid] ? `Lv.${S.buildings[bid]}` : '(미건설)'}<br><span class="muted">${esc(META.buildings[bid].desc)}</span>`;
  } else if (RES_TILES[t] && depleted(tx, ty)) {
    h = `<b>다 캔 자리</b><br><span class="muted">약 ${fmtDur(depleted(tx, ty) - now())} 뒤 다시 자라요</span>`;
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
    const mon = allMonsters().find((q) => q.id === chase.id);
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
    if (RES_TILES[tileAt(x, y)] && !depleted(x, y)) return send({ t: 'gather', x, y });
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
  else if (e.code === 'KeyI') { e.preventDefault(); toggleGear(); }
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
  if (x - r.x < -0.03) r.flip = true;        // 왼쪽으로 가면 왼쪽을 본다
  else if (x - r.x > 0.03) r.flip = false;
  r.x += (x - r.x) * k;
  r.y += (y - r.y) * k;
  return r;
}

function draw(t, dt) {
  ctx.imageSmoothingEnabled = false;
  const prevX = L ? L.x : 0;
  updateMe(dt, t);
  if (L) {
    if (L.x < prevX - 1e-4) meFlip = true;
    else if (L.x > prevX + 1e-4) meFlip = false;
    rpos[me] = { x: L.x - 0.5, y: L.y - 0.5, moving: meMoving, flip: meFlip };
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

  updateAnimals(dt);

  // 건물 + 오브젝트 + 사람 + 몬스터를 y 순서로
  const ents = [];
  const ty0 = Math.max(0, Math.floor(cy / TS) - 1), ty1 = Math.min(objRows.length - 1, Math.ceil((cy + H) / TS) + 2);
  const tx0 = Math.floor(cx / TS) - 1, tx1 = Math.ceil((cx + W) / TS) + 1;
  for (let y = ty0; y <= ty1; y++) {
    for (const o of objRows[y]) if (o.x >= tx0 && o.x <= tx1) ents.push({ y: o.y + 0.85, f: () => drawObj(o, sx, sy, t) });
  }
  for (const bid of Object.keys(META.building_pos)) ents.push({ y: META.building_pos[bid][1] + 0.9, f: () => drawBuilding(bid, t) });
  for (const [pid, m] of Object.entries(S.members)) {
    const r = pid === me && L ? rpos[me] : lerp(pid, m.x - 0.5, m.y - 0.5, dt);
    ents.push({ y: r.y, f: () => drawVillager(pid, m, r, sx, sy, t) });
  }
  for (const mo of allMonsters()) {
    const r = lerp(mo.id, mo.x, mo.y, dt);
    if (sx(r.x) > -40 && sx(r.x) < W + 40 && sy(r.y) > -40 && sy(r.y) < H + 40) ents.push({ y: r.y, f: () => drawMonster(mo, r, sx, sy, t) });
  }
  for (const a of animals) ents.push({ y: a.y - 0.5, f: () => drawAnimal(a, sx, sy, t) });
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
  if (t - hurtAt < 350) {   // 맞으면 화면 가장자리가 붉게
    const k = 1 - (t - hurtAt) / 350;
    const g = ctx.createRadialGradient(W / 2, H / 2, H * 0.3, W / 2, H / 2, H * 0.8);
    g.addColorStop(0, 'rgba(255,0,0,0)');
    g.addColorStop(1, `rgba(220,30,30,${0.45 * k})`);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
  }
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
  const job = m.job && !r.moving ? m.job : null;
  let flip = r.flip, lean = 0, sqx = 1, sqy = 1, toolAng = null;
  let bob = r.moving ? -Math.abs(Math.sin(t / 70)) * 3 : 0;
  if (job) {
    const tcx = job.tx + 0.5, mcx = r.x + 0.5;
    if (Math.abs(tcx - mcx) > 0.2) flip = tcx < mcx;      // 일하는 대상을 바라본다
    if (job.res === 'fish') bob = Math.sin(t / 500) * 1;
    else {
      const period = m.online ? 760 : 1500;
      const seed = (parseInt(pid.slice(0, 4), 16) || 0) % period;
      const p = ((t + seed) % period) / period;
      // 각도 0 = 도구를 세운 자세, 음수 = 뒤로 젖힘, 양수 = 바라보는 쪽으로 내려침
      // 0~0.55 머리 뒤로 들어 올림 → 0.55~0.68 앞으로 내려침 → 회복
      if (p < 0.55) { const k = p / 0.55; toolAng = -0.2 - 1.5 * k; lean = -2 * k; }
      else if (p < 0.68) { const k = (p - 0.55) / 0.13; toolAng = -1.7 + 3.2 * k; lean = -2 + 6 * k; }
      else { const k = (p - 0.68) / 0.32; toolAng = 1.5 - 1.7 * k; lean = 4 - 4 * k; }
      if (p >= 0.66 && p < 0.8) { sqx = 1.08; sqy = 0.9; }
      const wa = workAnim[pid] || (workAnim[pid] = { p: 0 });
      if (wa.p < 0.66 && p >= 0.66) impact(job, m.online);
      wa.p = p;
    }
  }
  const since = attackAt[pid] ? t - attackAt[pid] : 9999;
  if (!job && since < 320) {   // 몬스터 공격
    const k = since / 320;
    toolAng = k < 0.4 ? -1.7 * (k / 0.4) : -1.7 + 3.2 * ((k - 0.4) / 0.6);
    lean = k < 0.4 ? -2 : 4 * (1 - k);
  }
  const dir = flip ? -1 : 1;
  ctx.fillStyle = 'rgba(0,0,0,0.3)';
  ctx.beginPath(); ctx.ellipse(px + 16, py + 29, 9 * sqx, 3, 0, 0, Math.PI * 2); ctx.fill();
  ctx.globalAlpha = m.online ? 1 : 0.6;
  const hurt = flashAt[pid] && t - flashAt[pid] < 120;
  if (hurt) ctx.filter = 'brightness(2.2) sepia(1) hue-rotate(-50deg) saturate(4)';
  // 발을 기준으로 기울이고 찌그러뜨리기
  ctx.save();
  ctx.translate(px + 16 + lean * dir, py + 32 + bob);
  ctx.scale(sqx * dir, sqy);
  drawTile(ctx, heroOf(pid), -16, -32);
  ctx.restore();
  ctx.filter = 'none';
  // 손에 든 것
  const hx = px + 16 + lean * dir + dir * 7, hy = py + 21 + bob;
  if (job && job.res === 'fish') drawFishing(job, hx, hy, dir, sx, sy, t);
  else if (toolAng !== null) {
    const tool = job ? WORK_TOOL[job.res] : GEAR_TILE[m.eq && m.eq.weapon];
    if (tool) {
      ctx.save();
      ctx.translate(hx, hy);
      ctx.scale(dir, 1);
      ctx.rotate(toolAng);
      // 손잡이 아래쪽을 손에 맞추고, 날이 왼쪽인 그림은 뒤집어서 날이 앞을 향하게
      const g = gripOf(tool), sc = 20 / 16;
      if (g.mirror) ctx.scale(-1, 1);
      drawTile(ctx, tool, -g.gx * sc, -13 * sc, 20);
      ctx.restore();
    }
  }
  ctx.globalAlpha = 1;
  // 이름 + 다쳤으면 체력
  ctx.font = FONT(11);
  ctx.textAlign = 'center';
  const name = m.name + (m.online ? '' : ' (zZ)');
  ctx.fillStyle = '#000b'; ctx.fillText(name, px + 17, py - 3);
  ctx.fillStyle = m.online ? m.color : '#c8c8c8'; ctx.fillText(name, px + 16, py - 4);
  if (m.max_hp && m.hp < m.max_hp) {
    ctx.fillStyle = '#000'; ctx.fillRect(px + 2, py - 1, 28, 4);
    ctx.fillStyle = '#5fbf4f'; ctx.fillRect(px + 2, py - 1, 28 * Math.max(0, m.hp / m.max_hp), 4);
  }
  if (pid === me) {
    ctx.fillStyle = '#f5c542';
    const ty = py - 24 + Math.sin(t / 200) * 2;
    ctx.beginPath(); ctx.moveTo(px + 12, ty); ctx.lineTo(px + 20, ty); ctx.lineTo(px + 16, ty + 5); ctx.fill();
  }
}

// 낚싯대 + 줄 + 찌
function drawFishing(job, hx, hy, dir, sx, sy, t) {
  const tipX = hx + dir * 16, tipY = hy - 18;
  ctx.strokeStyle = '#8b5a2b'; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(hx, hy); ctx.lineTo(tipX, tipY); ctx.stroke();
  const bx = sx(job.tx + 0.5), by = sy(job.ty + 0.5) + Math.sin(t / 350) * 2;
  ctx.strokeStyle = 'rgba(255,255,255,0.7)'; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(tipX, tipY); ctx.quadraticCurveTo((tipX + bx) / 2, Math.max(tipY, by) + 6, bx, by); ctx.stroke();
  ctx.fillStyle = '#e0524a'; ctx.fillRect(bx - 2, by - 3, 4, 3);
  ctx.fillStyle = '#ffffff'; ctx.fillRect(bx - 2, by, 4, 2);
  if (Math.sin(t / 900) > 0.97) {     // 가끔 물이 튐
    ctx.strokeStyle = 'rgba(255,255,255,0.6)';
    ctx.beginPath(); ctx.ellipse(bx, by + 3, 7, 2.5, 0, 0, Math.PI * 2); ctx.stroke();
  }
}

function drawMonster(mo, r, sx, sy, t) {
  const n = parseInt(mo.id.slice(1), 10) || 0;  // 같은 칸에 몰려도 구분되게
  const px = sx(r.x) + ((n % 3) - 1) * 9, py = sy(r.y) + ((Math.floor(n / 3) % 3) - 1) * 6;
  const flash = flashAt[mo.id] && t - flashAt[mo.id] < 100;
  ctx.fillStyle = 'rgba(0,0,0,0.3)';
  ctx.beginPath(); ctx.ellipse(px + 16, py + 29, 9, 3, 0, 0, Math.PI * 2); ctx.fill();
  if (flash) ctx.filter = 'brightness(3)';
  drawFlipped(MONSTER_TILE[mo.kind] || MONSTER_TILE.wolf, px, py + Math.sin(t / 200 + px) * 1.5, r.flip);
  ctx.filter = 'none';
  if (mo.hp < mo.max_hp || !String(mo.id).startsWith('w')) {
    ctx.fillStyle = '#000'; ctx.fillRect(px + 2, py - 4, 28, 4);
    ctx.fillStyle = '#e0524a'; ctx.fillRect(px + 2, py - 4, 28 * Math.max(0, mo.hp / mo.max_hp), 4);
  }
}

// 타일을 좌우 반전해서 그리기
function drawFlipped(tile, x, y, flip, size = TS) {
  if (!flip) return drawTile(ctx, tile, x, y, size);
  ctx.save();
  ctx.translate(x + size, 0);
  ctx.scale(-1, 1);
  drawTile(ctx, tile, 0, y, size);
  ctx.restore();
}

function drawAnimal(a, sx, sy, t) {
  const px = sx(a.x - 0.5), py = sy(a.y - 0.5);
  if (px < -40 || px > W + 40 || py < -40 || py > H + 40) return;
  const bob = a.wait > 0 ? 0 : -Math.abs(Math.sin(t / 120)) * 2;
  ctx.save();
  if (a.flip) { ctx.translate(px + TS, 0); ctx.scale(-1, 1); drawTile(ctx, a.t, 0, py + bob); }
  else drawTile(ctx, a.t, px, py + bob);
  ctx.restore();
}

function drawBoss(bx, by, sx, sy, t) {
  const px = sx(bx) - TS * 0.5, py = sy(by) - TS;
  const flash = flashAt.boss && t - flashAt.boss < 100;
  const size = TS * 2;
  if (flash) ctx.filter = 'brightness(3)';
  drawTile(ctx, MONSTER_TILE.troll, px, py + Math.sin(t / 400) * 2, size);
  ctx.filter = 'none';
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
    if (f.icon) drawResIcon(ctx, f.icon, x - ctx.measureText(f.text).width / 2 - 16, y - 12, 14);
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
  const s = 2, w = mapRows[0].length * s, h = mapRows.length * s;
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
  for (const mo of allMonsters()) { ctx.fillStyle = mo.id.startsWith('w') ? '#a02020' : '#ff3b2f'; ctx.fillRect(ox + mo.x * s, oy + mo.y * s, 2, 2); }
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
  // 체력바
  ctx.fillStyle = 'rgba(0,0,0,0.65)';
  ctx.fillRect(x, y - 18, w, 14);
  ctx.fillStyle = '#5a1a1a'; ctx.fillRect(x + 2, y - 16, w - 4, 10);
  ctx.fillStyle = m.hp < m.max_hp * 0.3 ? '#e0524a' : '#5fbf4f';
  ctx.fillRect(x + 2, y - 16, (w - 4) * Math.max(0, m.hp / m.max_hp), 10);
  ctx.font = FONT(10); ctx.textAlign = 'center'; ctx.fillStyle = '#fff';
  ctx.fillText(`체력 ${m.hp} / ${m.max_hp}`, x + w / 2, y - 7);
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
  drawResIcon(ctx, j.res, x + 8, y + 10, 40);
  ctx.font = FONT(13); ctx.fillStyle = '#ece8f2';
  ctx.fillText(`${VERB[j.res]} 중 · 분당 ${j.rate}개`, x + 56, y + 22);
  ctx.font = FONT(11); ctx.fillStyle = '#9c95ad';
  ctx.fillText(`이번 작업 +${j.total} · ${left > 0 ? fmtDur(left) + ' 동안 계속' : '곧 끝남'}`, x + 56, y + 40);
  ctx.fillStyle = '#f5c542';
  ctx.fillText('Space: 열심히 일하기', x + 56, y + 54);
}

init();
