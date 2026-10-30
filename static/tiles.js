// Kenney(CC0) 16x16 타일 시트를 불러와서 그리는 도우미. 시트 번호 = 행 * 열수 + 열.
const SHEETS = {
  town: { src: '/static/assets/town.png', cols: 12, thin: true },
  dungeon: { src: '/static/assets/dungeon.png', cols: 12, thin: true },
  farm: { src: '/static/assets/farm.png', cols: 12, thin: true },
  battle: { src: '/static/assets/battle.png', cols: 18 },
};
const SHEET_IMG = {};
const SHEET_SCALE = {};

function loadSheets() {
  return Promise.all(Object.entries(SHEETS).map(([k, s]) => new Promise((res, rej) => {
    const im = new Image();
    im.onload = () => {
      if (s.thin) { SHEET_IMG[k] = thinOutline(im); SHEET_SCALE[k] = 2; }
      else { SHEET_IMG[k] = im; SHEET_SCALE[k] = 1; }
      res();
    };
    im.onerror = () => rej(new Error('타일 이미지를 불러오지 못했습니다: ' + s.src));
    im.src = s.src;
  })));
}

// Kenney 외곽선(#3f2631)이 32px로 키우면 너무 굵어서:
// 2배로 키운 뒤 투명한 바깥과 맞닿은 외곽선 픽셀은 지워 두께를 절반으로 만들고,
// 남은 외곽선은 옆 색을 어둡게 한 색으로 바꿔 부드럽게 한다.
function thinOutline(img) {
  const S = 2, T = 16 * S, w = img.width * S, h = img.height * S;
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const g = c.getContext('2d');
  g.imageSmoothingEnabled = false;
  g.drawImage(img, 0, 0, w, h);
  const data = g.getImageData(0, 0, w, h);
  const a = data.data, src = new Uint8ClampedArray(a);
  const idx = (x, y) => (y * w + x) * 4;
  const isLine = (i) => src[i + 3] > 0 && src[i] === 0x3f && src[i + 1] === 0x26 && src[i + 2] === 0x31;
  const sameTile = (x, y, nx, ny) => Math.floor(x / T) === Math.floor(nx / T) && Math.floor(y / T) === Math.floor(ny / T);
  const N4 = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = idx(x, y);
      if (!isLine(i)) continue;
      let outer = false, fill = null;
      for (const [dx, dy] of N4) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h || !sameTile(x, y, nx, ny)) continue;
        const j = idx(nx, ny);
        if (src[j + 3] === 0) outer = true;
        else if (!isLine(j) && !fill) fill = j;
      }
      if (outer) { a[i + 3] = 0; continue; }
      if (fill !== null) {   // 옆 색을 어둡게
        a[i] = src[fill] * 0.45; a[i + 1] = src[fill + 1] * 0.45; a[i + 2] = src[fill + 2] * 0.45;
      } else { a[i] = 0x4d; a[i + 1] = 0x37; a[i + 2] = 0x42; }
    }
  }
  g.putImageData(data, 0, 0);
  return c;
}

// [시트, 번호]를 (x, y)에 size 크기로
function drawTile(c, t, x, y, size = 32) {
  if (!t) return;
  const [sheet, i] = t;
  const cols = SHEETS[sheet].cols, s = 16 * SHEET_SCALE[sheet];
  c.drawImage(SHEET_IMG[sheet], (i % cols) * s, Math.floor(i / cols) * s, s, s, x, y, size, size);
}

const tileUrlCache = {};
function tileURL(t) {
  const key = t.join(':');
  if (!tileUrlCache[key]) {
    const c = document.createElement('canvas');
    c.width = c.height = 32;
    const g = c.getContext('2d');
    g.imageSmoothingEnabled = false;
    drawTile(g, t, 0, 0, 32);
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
  sapling: tw(17),
  rocks: [fm(89), fm(89), fm(77)],
  rubble: fm(77),
  sprout: fm(16),
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
const MONSTER_TILE = {
  wolf: dg(124), goblin: dg(110), bandit: dg(111), troll: dg(109),
  bat: dg(120), spider: dg(122), rat: dg(123), slime: dg(108), ghost: dg(121),
};
const ANIMALS = [fm(122), fm(122), fm(122), fm(120), fm(120), fm(121)];
// 일할 때 손에 드는 도구 (낚시는 낚싯줄을 직접 그림)
const WORK_TOOL = { wood: fm(87), stone: tw(115), ore: tw(115), food: fm(88) };
// 도구 그림에서 손잡이 x 위치(16px 기준)와 날이 왼쪽을 향하는지. 휘두를 때 손잡이를 축으로, 날이 앞을 향하게 한다
const GRIP = { 'farm:87': { gx: 11, mirror: true }, 'farm:88': { gx: 7.5, mirror: true }, 'town:129': { gx: 11, mirror: true } };
function gripOf(t) { return GRIP[t.join(':')] || { gx: 8, mirror: false }; }
const GEAR_TILE = {
  club: dg(117), stone_axe: dg(118), iron_sword: dg(104), crystal_sword: dg(106),
  leather_armor: dg(101), iron_armor: dg(102), crystal_armor: dg(102),
};

// 자원 아이콘 (Kenney에 없는 건 직접 그린 도트 사용)
const RES_ICON = { wood: tw(106), stone: fm(77), food: fm(54), ore: fm(89), gold: tw(93), leather: dg(66) };

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
