// Kenney(CC0) 16x16 타일 시트를 불러와서 그리는 도우미. 시트 번호 = 행 * 열수 + 열.
const SHEETS = {
  town: { src: '/static/assets/town.png', cols: 12 },
  dungeon: { src: '/static/assets/dungeon.png', cols: 12 },
  farm: { src: '/static/assets/farm.png', cols: 12 },
  battle: { src: '/static/assets/battle.png', cols: 18 },
};
const SHEET_IMG = {};

function loadSheets() {
  return Promise.all(Object.entries(SHEETS).map(([k, s]) => new Promise((res, rej) => {
    const im = new Image();
    im.onload = () => { SHEET_IMG[k] = im; res(); };
    im.onerror = () => rej(new Error('타일 이미지를 불러오지 못했습니다: ' + s.src));
    im.src = s.src;
  })));
}

// [시트, 번호]를 (x, y)에 size 크기로
function drawTile(c, t, x, y, size = 32) {
  if (!t) return;
  const [sheet, idx] = t;
  const cols = SHEETS[sheet].cols;
  c.drawImage(SHEET_IMG[sheet], (idx % cols) * 16, Math.floor(idx / cols) * 16, 16, 16, x, y, size, size);
}

const tileUrlCache = {};
function tileURL(t) {
  const key = t.join(':');
  if (!tileUrlCache[key]) {
    const c = document.createElement('canvas');
    c.width = c.height = 16;
    drawTile(c.getContext('2d'), t, 0, 0, 16);
    tileUrlCache[key] = c.toDataURL();
  }
  return tileUrlCache[key];
}

const tw = (i) => ['town', i], dg = (i) => ['dungeon', i], fm = (i) => ['farm', i], bt = (i) => ['battle', i];

const TILES = {
  grass: [...Array(14).fill(tw(0)), tw(1), tw(1), tw(1), tw(2)],  // 꽃은 가끔만
  dirt: [tw(40), tw(39), tw(40), tw(41)],
  stoneFloor: [tw(109)],
  trees: [tw(16), tw(16), tw(16), tw(28), tw(15)],   // 아랫부분
  treeTop: { 16: tw(4), 15: tw(3) },                 // 큰 나무는 윗칸이 따로
  rocks: [fm(89), fm(89), fm(77)],
  // 물: 땅이 어느 쪽에 붙어 있는지에 따라
  water: {
    c: bt(37), t: bt(19), b: bt(55), l: bt(36), r: bt(38),
    tl: bt(18), tr: bt(20), bl: bt(54), br: bt(56),
    itl: bt(90), itr: bt(91), ibr: bt(92), ibl: bt(93),
  },
  field: { l: fm(48), m: [fm(49), fm(50)], r: fm(51) },
  crops: [fm(6), fm(30), fm(42), fm(54), fm(66)],
  sign: tw(83),
};

// 사람 캐릭터 (주민마다 하나씩)
const HEROES = [dg(85), dg(88), dg(99), dg(98), dg(86), dg(112), dg(100), dg(87), dg(84), dg(96), dg(97)];
const MONSTER_TILE = { wolf: dg(124), goblin: dg(110), bandit: dg(111), troll: dg(109) };
const ANIMALS = [fm(122), fm(122), fm(122), fm(120), fm(120), fm(121)];

// 자원 아이콘 (Kenney에 없는 건 직접 그린 도트 사용)
const RES_ICON = { wood: tw(106), stone: fm(77), food: fm(54), ore: fm(89), gold: tw(93) };

// 건물: rows는 위에서 아래로, 맨 아랫줄이 건물 좌표 줄. extra는 주변 소품 (dx, dy는 칸 단위, 건물 중심 기준)
const BUILD_ART = {
  hall: { rows: [[tw(52), tw(55), tw(54)], [tw(64), tw(65), tw(66)], [tw(88), tw(90), tw(88)]],
    extra: [{ t: bt(34), dx: 0, dy: -3 }] },
  warehouse: { rows: [[tw(48), tw(49), tw(50)], [tw(60), tw(61), tw(62)], [tw(72), tw(86), tw(75)]],
    extra: [{ t: tw(130), dx: 2, dy: 0 }, { t: tw(107), dx: -2, dy: 0 }] },
  smithy: { rows: [[tw(48), tw(51), tw(50)], [tw(60), tw(61), tw(62)], [tw(76), tw(89), tw(79)]],
    extra: [{ t: dg(74), dx: 2, dy: 0 }, { t: tw(128), dx: -2, dy: 0 }], smoke: true },
  inn: { rows: [[tw(52), tw(53), tw(54)], [tw(64), tw(65), tw(66)], [tw(84), tw(85), tw(84)]],
    extra: [{ t: tw(83), dx: -2, dy: 0 }, { t: tw(131), dx: 2, dy: 0 }] },
  lumber: { rows: [[tw(52), tw(53), tw(54)], [tw(64), tw(65), tw(66)], [tw(72), tw(74), tw(75)]],
    extra: [{ t: tw(106), dx: 2, dy: 0 }, { t: tw(106), dx: 2, dy: -0.4 }, { t: fm(87), dx: -2, dy: 0 }] },
  quarry: { rows: [[tw(48), tw(49), tw(50)], [tw(60), tw(61), tw(62)], [tw(73), tw(74), tw(73)]],
    extra: [{ t: fm(89), dx: 2, dy: 0 }, { t: tw(115), dx: -2, dy: 0 }] },
  farm: { rows: [[tw(52), tw(53), tw(54)], [fm(102), fm(103), fm(104)], [fm(126), fm(127), fm(128)]],
    extra: [{ t: fm(97), dx: 2, dy: 0 }, { t: fm(96), dx: -2, dy: 0 }] },
  tower: { rows: [[tw(102)], [tw(125)], [tw(78)]] },
  fountain: { rows: [[tw(104)]], extra: [{ t: tw(2), dx: -1, dy: 0 }, { t: tw(2), dx: 1, dy: 0 }] },
  dock: { rows: [[tw(130)]], pier: true },
  mine: { rows: [[tw(126), tw(126)], [tw(113), tw(114)]] },
  dungeon: { rows: [[dg(9), dg(10), dg(11)], [dg(21), dg(46), dg(23)]], extra: [{ t: dg(19), dx: 0, dy: -2 }], glow: true },
};
