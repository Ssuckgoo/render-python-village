"""마을 밸런스 데이터. 숫자 조정은 여기서만 하면 된다. 시간 단위는 초."""
import random

RESOURCES = {
    "wood": {"name": "나무", "skill": "벌목", "color": "#b07b45"},
    "stone": {"name": "돌", "skill": "채석", "color": "#a3adbb"},
    "fish": {"name": "물고기", "skill": "낚시", "color": "#6fb7e0"},
    "food": {"name": "식량", "skill": "농사", "color": "#9bd35a"},
    "ore": {"name": "광석", "skill": "채광", "color": "#c98e62"},
    "leather": {"name": "가죽", "skill": None, "color": "#b5714a"},
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
# 한 칸에서 캘 수 있는 양과 다시 자라는 시간. 물고기는 무한
RES_AMOUNT = {"wood": 20, "stone": 30, "ore": 18, "food": 10}
REGROW = {"wood": 20 * 60, "stone": 30 * 60, "ore": 40 * 60, "food": 6 * 60}
RETARGET_RADIUS = 6             # 자원이 떨어지면 이 거리 안의 같은 자원으로 옮겨 간다 (오프라인일 때)

OFFLINE_CAP = 2 * 3600          # 걸어둔 일이 계속되는 시간 (여관 레벨당 +1시간)
TOGETHER_BONUS = 0.3            # 같이 일하는 사람 1명당 +30% (최대 +100%)
PLAYER_SPEED = 6.5              # 초당 타일
ACTIVE_COOLDOWN = 1.5           # 열심히 일하기 재사용
ACTIVE_AMOUNT = 0.25            # x (1 + 분당 생산량)
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
                  "desc": "모든 채집 +10%/레벨, 도구·장비 제작"},
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
TOOLS = {"wood": "도끼", "stone": "곡괭이", "fish": "낚싯대", "food": "괭이", "ore": "광부 곡괭이"}
TOOL_BONUS = 0.15               # 도구 레벨당 개인 채집 +15%
TOOL_MAX = 5


def tool_price(level):
    return 40 * 2 ** level      # 현재 레벨 -> 다음 레벨 가격


def skill_level(xp):
    return int((xp / 10) ** 0.5) + 1


SKILL_BONUS = 0.02              # 숙련도 레벨당 +2%

ENERGY_MAX = 30
ENERGY_REGEN = 180              # 3분마다 1

# ---------- 전투 장비 ----------
# smithy: 필요한 대장간 레벨(0이면 대장간 없이도 제작). cost는 마을 창고에서, coins는 내 동전에서
GEAR = {
    "club":          {"slot": "weapon", "name": "나무 몽둥이", "atk": 3, "cost": {"wood": 30}, "coins": 0, "smithy": 0},
    "stone_axe":     {"slot": "weapon", "name": "돌도끼", "atk": 6, "cost": {"wood": 40, "stone": 60}, "coins": 20, "smithy": 1},
    "iron_sword":    {"slot": "weapon", "name": "철검", "atk": 11, "cost": {"ore": 60, "wood": 30}, "coins": 60, "smithy": 2},
    "crystal_sword": {"slot": "weapon", "name": "수정검", "atk": 18, "cost": {"crystal": 25, "ore": 60}, "coins": 150, "smithy": 4},
    "leather_armor": {"slot": "armor", "name": "가죽옷", "df": 2, "hp": 20, "cost": {"leather": 10}, "coins": 10, "smithy": 0},
    "iron_armor":    {"slot": "armor", "name": "철갑옷", "df": 5, "hp": 45, "cost": {"ore": 80, "leather": 15}, "coins": 60, "smithy": 2},
    "crystal_armor": {"slot": "armor", "name": "수정갑옷", "df": 9, "hp": 80, "cost": {"crystal": 30, "ore": 80, "leather": 20}, "coins": 150, "smithy": 4},
}
PLAYER_HP = 100
HP_PER_COMBAT_LV = 5
REGEN_DELAY = 5                 # 맞지 않고 이 시간이 지나면 회복 시작
REGEN_RATE = 4                  # 초당 체력 회복
ATTACK_COOLDOWN = 0.9

# ---------- 야생 몬스터 ----------
# zone: 사는 구역, speed: 초당 칸, drops: {자원: (최소, 최대)} -> 마을 창고로
WILD = {
    "bat":    {"name": "박쥐", "hp": 25, "atk": 5, "speed": 3.6, "zone": "forest",
               "drops": {"leather": (0, 1)}, "coins": 2, "xp": 3},
    "wolf":   {"name": "늑대", "hp": 45, "atk": 8, "speed": 3.0, "zone": "forest",
               "drops": {"leather": (2, 4)}, "coins": 4, "xp": 6},
    "spider": {"name": "거미", "hp": 60, "atk": 10, "speed": 2.4, "zone": "forest",
               "drops": {"leather": (1, 2)}, "coins": 5, "xp": 8},
    "rat":    {"name": "큰쥐", "hp": 35, "atk": 6, "speed": 3.2, "zone": "quarry",
               "drops": {"leather": (1, 2)}, "coins": 3, "xp": 4},
    "slime":  {"name": "슬라임", "hp": 90, "atk": 13, "speed": 2.0, "zone": "east",
               "drops": {"crystal": (0, 1)}, "coins": 8, "xp": 12},
    "ghost":  {"name": "유령", "hp": 120, "atk": 17, "speed": 2.6, "zone": "east",
               "drops": {"crystal": (1, 2), "gold": (1, 3)}, "coins": 12, "xp": 16},
}
# 구역: (x1, y1, x2, y2), 최대 마릿수
ZONES = {
    "forest": {"rect": (1, 1, 19, 17), "count": 8},     # 숲 안쪽 깊은 곳만 (가장자리는 안전)
    "quarry": {"rect": (1, 49, 16, 62), "count": 5},
    "east":   {"rect": (73, 2, 94, 62), "count": 9},
}
WILD_RESPAWN = 120              # 잡힌 뒤 같은 구역에 다시 나타나기까지
WILD_AGGRO = 4                  # 이 거리 안의 접속자에게 덤빈다
WILD_LEASH = 8                  # 집에서 이만큼 멀어지면 돌아간다
WILD_ATTACK_CD = 1.2
SAFE_RADIUS = 12                # 마을 중심에서 이 거리 안으로는 쫓아오지 않는다

# ---------- 습격 / 보스 ----------
RAID_INTERVAL = (2 * 3600, 5 * 3600)
RAID_DURATION = 30 * 60
RAID_STEAL = 0.2                # 못 막으면 남은 체력 비율 x 20% 자원 손실
RAID_MIN_LEVEL = 8              # 건물 레벨 합이 이 이상인 마을만 습격
RAID_MONSTERS = ["wolf", "goblin", "bandit"]
MONSTER_NAMES = {"wolf": "늑대", "goblin": "고블린", "bandit": "도적", "boss": "동굴 트롤",
                 **{k: v["name"] for k, v in WILD.items()}}
TOWER_DPS = 3
BOSS_HP = 3000
BOSS_GROWTH = 1.6

# ---------- 지도 ----------
MAP_W, MAP_H = 96, 64
RIVER_X = (68, 70)
BRIDGE_Y = 32
# 건물 위치 (타일). 맨 아랫줄 기준, BUILDING_W 칸 너비로 그린다.
BUILDING_POS = {
    "hall": (44, 28), "warehouse": (35, 29), "smithy": (51, 29), "inn": (35, 37),
    "tower": (55, 23), "fountain": (44, 35), "lumber": (32, 14), "quarry": (28, 44),
    "dock": (49, 43), "farm": (50, 19), "bridge": (69, BRIDGE_Y), "mine": (80, 24),
    "dungeon": (88, 8),
}
# 건물 그림 너비(칸). 아랫줄 칸들은 지나갈 수 없다. 0이면 길을 막지 않음(다리)
BUILDING_W = {"hall": 3, "warehouse": 3, "smithy": 3, "inn": 3, "lumber": 3, "quarry": 3, "farm": 3,
              "dungeon": 3, "mine": 2, "tower": 1, "fountain": 1, "dock": 1, "bridge": 0}
SPAWN = (40, 38)
RAID_SPAWNS = [(6, 31), (6, 32), (6, 33), (7, 32), (8, 31), (8, 33)]


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
    W, H = MAP_W, MAP_H
    g = [["." for _ in range(W)] for _ in range(H)]

    def ellipse(cx, cy, rx, ry, ch):
        for y in range(H):
            for x in range(W):
                if ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1:
                    g[y][x] = ch

    # 동쪽 광산 지대 + 강
    for y in range(H):
        for x in range(RIVER_X[1] + 1, W):
            g[y][x] = "m" if rng.random() < 0.16 else ":"
        for x in range(RIVER_X[0], RIVER_X[1] + 1):
            g[y][x] = "b" if y == BRIDGE_Y else "~"
    # 큰 숲 (북서), 작은 숲 (북동)
    for y in range(1, 26):
        for x in range(1, 32):
            p = 0.66 - max(0, x - 20) * 0.05 - max(0, y - 16) * 0.06
            if rng.random() < p:
                g[y][x] = "T"
    for y in range(2, 13):
        for x in range(57, 67):
            if rng.random() < 0.42:
                g[y][x] = "T"
    # 채석장 (남서)
    for y in range(40, H):
        for x in range(1, 27):
            p = 0.5 - max(0, x - 18) * 0.05 - max(0, 46 - y) * 0.06
            if rng.random() < p:
                g[y][x] = "R"
    # 들판 군데군데 나무와 바위
    for y in range(1, H - 1):
        for x in range(1, RIVER_X[0]):
            if g[y][x] == "." and rng.random() < 0.012:
                g[y][x] = "T" if rng.random() < 0.7 else "R"
    # 호수와 연못
    ellipse(52, 50, 11, 6.5, "~")
    ellipse(20, 28, 3.5, 2.2, "~")
    ellipse(62, 56, 3, 2, "~")
    # 밭
    for y in range(6, 17):
        for x in range(42, 59):
            if y % 3 != 0:
                g[y][x] = "F"
    # 길
    for x in range(4, RIVER_X[0]):
        g[BRIDGE_Y][x] = ","
    for x in range(RIVER_X[1] + 1, 89):
        g[BRIDGE_Y][x] = ","
    for y in range(4, 59):
        if g[y][40] != "~":
            g[y][40] = ","
    for y in range(9, BRIDGE_Y):
        g[y][88] = ","
    for x in range(27, 40):
        g[46][x] = ","
    for x in range(31, 40):
        g[16][x] = ","
    for x in range(41, 50):
        g[20][x] = ","
    # 테두리
    for y in range(H):
        for x in range(W):
            if x in (0, W - 1) or y in (0, H - 1):
                g[y][x] = "#"
    # 건물 자리
    for bid in BUILDING_POS:
        for bx, by in building_tiles(bid):
            g[by][bx] = "B"
            for dx in (-1, 0, 1):          # 건물 주변(지붕 쪽 포함)은 비워서 가리지 않게
                for dy in (-2, -1, 0, 1):
                    if g[by + dy][bx + dx] in "TRm":
                        g[by + dy][bx + dx] = ":" if bx > RIVER_X[1] else "."
    # 시작 지점과 습격 출발점 주변은 비워둔다
    for cx, cy in [SPAWN] + RAID_SPAWNS:
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                if g[cy + dy][cx + dx] in "TR":
                    g[cy + dy][cx + dx] = "."
    sx, sy = SPAWN
    g[sy][sx] = ","
    return ["".join(r) for r in g]


TILE_RES = {"T": "wood", "R": "stone", "~": "fish", "F": "food", "m": "ore"}
WALKABLE = set(".,F:=")
