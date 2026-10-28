"""마을 밸런스 데이터. 숫자 조정은 여기서만 하면 된다. 시간 단위는 초."""
import random

RESOURCES = {
    "wood": {"name": "나무", "skill": "벌목", "color": "#b07b45"},
    "stone": {"name": "돌", "skill": "채석", "color": "#a3adbb"},
    "fish": {"name": "물고기", "skill": "낚시", "color": "#6fb7e0"},
    "food": {"name": "식량", "skill": "농사", "color": "#9bd35a"},
    "ore": {"name": "광석", "skill": "채광", "color": "#c98e62"},
    "crystal": {"name": "수정", "skill": None, "color": "#c9b8ff"},
    "gold": {"name": "금화", "skill": None, "color": "#ffd34d"},
}
GATHER = ["wood", "stone", "fish", "food", "ore"]

# 자원별: 기본 분당 생산량, 생산 건물
JOBS = {
    "wood": {"rate": 3.0, "building": "lumber"},
    "stone": {"rate": 2.4, "building": "quarry"},
    "fish": {"rate": 2.0, "building": "dock"},
    "food": {"rate": 3.0, "building": "farm"},
    "ore": {"rate": 1.5, "building": "mine"},
}
OFFLINE_CAP = 2 * 3600          # 걸어둔 일이 계속되는 시간 (여관 레벨당 +1시간)
TOGETHER_BONUS = 0.3            # 같이 일하는 사람 1명당 +30% (최대 +100%)
PLAYER_SPEED = 6.5              # 초당 타일
ACTIVE_COOLDOWN = 1.5           # 열심히 일하기 재사용
ACTIVE_AMOUNT = 0.25           # x (1 + 분당 생산량)
COIN_PER_UNIT = 0.1

# ---------- 건물 ----------
# cost: 레벨 1(또는 base_level+1)로 갈 때 비용. 이후 레벨마다 x1.8
# extra: 특정 레벨 이상부터 추가로 드는 자원 {레벨: {자원: 양}}
BUILDINGS = {
    "hall":      {"name": "마을회관", "max": 5, "start": 1, "minutes": 10,
                  "cost": {"wood": 300, "stone": 200}, "extra": {4: {"crystal": 20}, 5: {"crystal": 60, "gold": 100}},
                  "desc": "다른 건물의 최대 레벨 = 회관 레벨 + 1"},
    "warehouse": {"name": "창고", "max": 6, "start": 1, "minutes": 5,
                  "cost": {"wood": 240, "stone": 120}, "desc": "자원 보관 한도 증가"},
    "lumber":    {"name": "벌목장", "max": 6, "start": 1, "minutes": 5,
                  "cost": {"wood": 160, "stone": 80, "food": 40}, "desc": "나무 생산 +25%/레벨"},
    "quarry":    {"name": "채석장", "max": 6, "start": 1, "minutes": 5,
                  "cost": {"wood": 120, "stone": 120, "food": 40}, "desc": "돌 생산 +25%/레벨"},
    "dock":      {"name": "낚시터", "max": 6, "start": 1, "minutes": 5,
                  "cost": {"wood": 200, "stone": 40}, "desc": "물고기 생산 +25%/레벨"},
    "farm":      {"name": "농장", "max": 6, "start": 1, "minutes": 5,
                  "cost": {"wood": 160, "stone": 40, "fish": 40}, "desc": "식량 생산 +25%/레벨"},
    "smithy":    {"name": "대장간", "max": 5, "start": 0, "minutes": 8,
                  "cost": {"wood": 200, "stone": 300}, "extra": {3: {"ore": 80}},
                  "desc": "모든 채집 +10%/레벨, 도구 상점 이용"},
    "inn":       {"name": "여관", "max": 4, "start": 0, "minutes": 8,
                  "cost": {"wood": 400, "stone": 160, "food": 200, "fish": 100},
                  "desc": "걸어둔 일이 레벨당 1시간 더 지속"},
    "tower":     {"name": "망루", "max": 5, "start": 0, "minutes": 8,
                  "cost": {"wood": 300, "stone": 400}, "extra": {3: {"ore": 60}},
                  "desc": "습격 몬스터를 자동 공격 (레벨당 초당 3 피해)"},
    "fountain":  {"name": "분수", "max": 3, "start": 0, "minutes": 10,
                  "cost": {"stone": 600, "fish": 100}, "desc": "마을이 예뻐진다. 숙련도 경험치 +10%/레벨"},
    "bridge":    {"name": "다리", "max": 1, "start": 0, "minutes": 15,
                  "cost": {"wood": 800, "stone": 400}, "desc": "강 건너 광산 지역으로 갈 수 있다"},
    "mine":      {"name": "광산", "max": 5, "start": 0, "minutes": 10, "needs": "bridge",
                  "cost": {"wood": 400, "stone": 600, "food": 200}, "desc": "광석 채광 가능, 생산 +25%/레벨"},
    "dungeon":   {"name": "던전 입구", "max": 1, "start": 0, "minutes": 20, "needs": "mine",
                  "cost": {"stone": 1000, "ore": 400}, "desc": "던전 보스에 도전할 수 있다"},
}


def build_cost(bid, level):
    """bid 건물을 level로 올리는 비용."""
    b = BUILDINGS[bid]
    steps = level - max(1, b["start"] + 1)
    mult = 1.8 ** max(0, steps)
    cost = {k: int(v * mult) for k, v in b["cost"].items()}
    for lv, extra in b.get("extra", {}).items():
        if level >= lv:
            for k, v in extra.items():
                cost[k] = cost.get(k, 0) + int(v * 1.5 ** (level - lv))
    return cost


def build_seconds(bid, level):
    return BUILDINGS[bid]["minutes"] * 60 * level


def warehouse_cap(level):
    return 300 * level * (level + 1) // 2


# ---------- 개인 ----------
TOOLS = {
    "wood": "도끼", "stone": "곡괭이", "fish": "낚싯대", "food": "괭이", "ore": "광부 곡괭이",
    "weapon": "무기",
}
TOOL_BONUS = 0.15               # 도구 레벨당 개인 채집 +15%
TOOL_MAX = 5


def tool_price(level):
    return 40 * 2 ** level      # 현재 레벨 -> 다음 레벨 가격


def skill_level(xp):
    return int((xp / 10) ** 0.5) + 1


SKILL_BONUS = 0.02              # 숙련도 레벨당 +2%

ENERGY_MAX = 30
ENERGY_REGEN = 180              # 3분마다 1

# ---------- 습격 / 보스 ----------
RAID_INTERVAL = (2 * 3600, 5 * 3600)
RAID_DURATION = 30 * 60
RAID_STEAL = 0.2                # 못 막으면 남은 체력 비율 x 20% 자원 손실
RAID_MIN_LEVEL = 8              # 건물 레벨 합이 이 이상인 마을만 습격
RAID_MONSTERS = ["wolf", "goblin", "bandit"]
MONSTER_NAMES = {"wolf": "늑대", "goblin": "고블린", "bandit": "도적", "boss": "동굴 트롤"}
ATTACK_COOLDOWN = 0.9
TOWER_DPS = 3
BOSS_HP = 3000
BOSS_GROWTH = 1.6

# ---------- 지도 ----------
MAP_W, MAP_H = 46, 32
RIVER_X = (33, 35)
BRIDGE_Y = 15
# 건물 위치 (타일). 건물은 해당 타일 1칸을 차지하고 2x2 크기로 그린다.
BUILDING_POS = {
    "hall": (17, 12), "warehouse": (13, 14), "smithy": (21, 14), "inn": (13, 18),
    "tower": (22, 9), "fountain": (17, 16), "lumber": (12, 6), "quarry": (11, 22),
    "dock": (21, 23), "farm": (26, 12), "bridge": (34, BRIDGE_Y), "mine": (38, 11),
    "dungeon": (41, 5),
}
# 건물 그림 너비(칸). 아랫줄 칸들은 지나갈 수 없다. 0이면 길을 막지 않음(다리)
BUILDING_W = {"hall": 3, "warehouse": 3, "smithy": 3, "inn": 3, "lumber": 3, "quarry": 3, "farm": 3,
              "dungeon": 3, "mine": 2, "tower": 1, "fountain": 1, "dock": 1, "bridge": 0}
SPAWN = (17, 18)


def building_tiles(bid):
    """건물이 차지하는(막는) 칸 목록."""
    x, y = BUILDING_POS[bid]
    w = BUILDING_W[bid]
    left = x - (w // 2) if w % 2 else x
    return [(left + i, y) for i in range(w)]


def make_map():
    """지도 문자열 목록. 고정 시드라 모든 마을이 같은 지형.
    # 벽  . 풀밭  , 길  T 나무  R 바위  ~ 물  F 밭  : 광산 바닥  m 광석  b 다리 자리  = 다리  B 건물"""
    rng = random.Random(1717)
    g = [["." for _ in range(MAP_W)] for _ in range(MAP_H)]
    for y in range(MAP_H):
        for x in range(MAP_W):
            if x in (0, MAP_W - 1) or y in (0, MAP_H - 1):
                g[y][x] = "#"
    # 강과 광산 지역
    for y in range(1, MAP_H - 1):
        for x in range(RIVER_X[0], RIVER_X[1] + 1):
            g[y][x] = "b" if y == BRIDGE_Y else "~"
        for x in range(RIVER_X[1] + 1, MAP_W - 1):
            g[y][x] = "m" if rng.random() < 0.22 else ":"
    # 숲
    for y in range(1, 13):
        for x in range(1, 12):
            if rng.random() < 0.55 + (11 - x) * 0.03:
                g[y][x] = "T"
    # 채석장
    for y in range(20, MAP_H - 1):
        for x in range(1, 11):
            if rng.random() < 0.4 + (10 - x) * 0.03:
                g[y][x] = "R"
    # 호수
    for y in range(MAP_H):
        for x in range(MAP_W):
            if ((x - 25) / 5.5) ** 2 + ((y - 25) / 3.5) ** 2 <= 1:
                g[y][x] = "~"
    # 밭
    for y in range(4, 11):
        for x in range(24, 31):
            if y % 3 != 0:
                g[y][x] = "F"
    # 길
    for x in range(8, RIVER_X[0]):
        g[BRIDGE_Y][x] = ","
    for y in range(4, 28):
        if g[y][17] in ".":
            g[y][17] = ","
    for x in range(RIVER_X[1] + 1, 42):
        g[BRIDGE_Y][x] = ","
    for y in range(5, BRIDGE_Y):
        g[y][40] = ","
    # 건물 자리는 비워둔다
    for bid in BUILDING_POS:
        for bx, by in building_tiles(bid):
            g[by][bx] = "B"
            for dx in (-1, 0, 1):          # 건물 주변(지붕 쪽 포함)은 비워서 가리지 않게
                for dy in (-2, -1, 0, 1):
                    if g[by + dy][bx + dx] in "TRm":
                        g[by + dy][bx + dx] = ":" if bx > RIVER_X[1] else "."
    sx, sy = SPAWN
    g[sy][sx] = ","
    return ["".join(r) for r in g]


TILE_RES = {"T": "wood", "R": "stone", "~": "fish", "F": "food", "m": "ore"}
WALKABLE = set(".,F:=")
