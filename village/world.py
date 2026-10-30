"""마을 규칙. 네트워크와 무관한 순수 로직.

d(dict)가 DB에 저장되는 전부다. 접속 중인 사람의 공격 대상 같은 일시 정보는 self에 둔다.
시간은 time.time() 기준 초. step(now)는 마지막 계산 이후 흐른 시간을 한 번에 처리하므로
서버가 잠들어 있던 시간도 깨어날 때 따라잡는다.
"""
import math
import random
import secrets
import time
from collections import deque

from .data import (ACTIVE_AMOUNT, ACTIVE_COOLDOWN, ATTACK_COOLDOWN, BOSS_GROWTH, BOSS_HP, BUILDING_POS,
                   BUILDINGS, COIN_PER_UNIT, ENERGY_MAX, ENERGY_REGEN, GATHER, GEAR, HP_PER_COMBAT_LV,
                   JOBS, MAP_H, MAP_W, OFFLINE_CAP, PLAYER_HP, PLAYER_SPEED, RAID_DURATION, RAID_INTERVAL,
                   RAID_MIN_LEVEL, RAID_MONSTERS, RAID_SPAWNS, RAID_STEAL, REGEN_DELAY, REGEN_RATE, REGROW,
                   RES_AMOUNT, RESOURCES, RETARGET_RADIUS, SAFE_RADIUS, SKILL_BONUS, SPAWN, TILE_RES,
                   TOGETHER_BONUS, TOOL_BONUS, TOOL_MAX, TOOLS, TOWER_DPS, WALKABLE, WILD, WILD_AGGRO,
                   WILD_ATTACK_CD, WILD_LEASH, WILD_RESPAWN, ZONES, build_cost, build_seconds, make_map,
                   skill_level, tool_price, warehouse_cap)

COLORS = ["#e0524a", "#5b8cff", "#5fbf4f", "#f5c542", "#c06bff", "#ff9f1c", "#4fd1c5", "#ff6fae",
          "#9a6532", "#e6e6e6"]
LOG_SIZE = 80
CHAT_SIZE = 100
BASE_MAP = make_map()
RADIUS = 0.3
DIRS8 = [(1, 0), (-1, 0), (0, 1), (0, -1), (1, 1), (1, -1), (-1, 1), (-1, -1)]
TICK = 0.2


def _reachable():
    """시작 지점에서 걸어갈 수 있는 칸 (다리는 지었다고 보고). 몬스터는 여기에만 생긴다."""
    ok = lambda x, y: 0 <= x < MAP_W and 0 <= y < MAP_H and (BASE_MAP[y][x] in WALKABLE or BASE_MAP[y][x] == "b")
    seen = {SPAWN}
    stack = [SPAWN]
    while stack:
        x, y = stack.pop()
        for dx, dy in DIRS8:
            n = (x + dx, y + dy)
            if n not in seen and ok(*n) and (not (dx and dy) or (ok(x + dx, y) and ok(x, y + dy))):
                seen.add(n)
                stack.append(n)
    return seen


REACH = _reachable()


class VillageError(Exception):
    pass


def key(x, y):
    return f"{x},{y}"


def cheb(ax, ay, bx, by):
    return max(abs(ax - bx), abs(ay - by))


def new_village(code, name, now=None):
    now = now or time.time()
    d = {
        "code": code, "name": name[:16] or "이름 없는 마을", "created": now, "last": now,
        "res": {k: 0 for k in RESOURCES},
        "buildings": {k: b["start"] for k, b in BUILDINGS.items()},
        "construction": None, "members": {}, "tokens": {}, "log": [], "chat": [],
        "raid": None, "next_raid": now + random.uniform(*RAID_INTERVAL) / 2,
        "boss": None, "stats": {"raids_won": 0, "raids_lost": 0, "bosses": 0, "kills": 0},
        "dep": {}, "amt": {}, "wild": [], "wild_next": {},
    }
    d["res"].update({"wood": 60, "stone": 40, "food": 30})
    return d


class Village:
    def __init__(self, d):
        self.d = d
        self.online = set()
        self.last_pos = {}       # pid -> (x, y, 시각) 위치 검증용
        self.corrections = []    # (pid, x, y) 위치를 되돌려야 하는 사람
        self.target = {}         # pid -> 몬스터 id
        self.cd = {}             # (id, 종류) -> 다음 가능 시각
        self.ev = []             # 화면 연출용 이벤트
        self.moved = False
        self.dirty = True        # 전체 상태를 다시 보내야 함
        self.save_dirty = True   # DB에 저장해야 함
        self.messages = []       # (pid, text) 개인 알림
        self.rng = random.Random()
        self.uid = 0
        self.mpaths = {}         # 몬스터 id -> {"goal", "p", "t"} 길찾기 캐시
        self.migrate()
        self.rebuild_map()
        self.fix_positions()

    # ---------- 예전 저장본 정리 ----------
    def migrate(self):
        d = self.d
        for k in ("dep", "amt", "wild_next"):
            d.setdefault(k, {})
        d.setdefault("wild", [])
        d["stats"].setdefault("kills", 0)
        for k in RESOURCES:
            d["res"].setdefault(k, 0)
        for m in d["members"].values():
            if isinstance(m["x"], int):
                m["x"], m["y"] = m["x"] + 0.5, m["y"] + 0.5
            m["tools"].pop("weapon", None)
            for k in TOOLS:
                m["tools"].setdefault(k, 0)
            m.setdefault("gear", [])
            m.setdefault("eq", {"weapon": None, "armor": None})
            m.setdefault("hp", self.max_hp(m))
            m.setdefault("hurt_t", 0)

    def fix_positions(self):
        """맵이 바뀌어서 벽 안에 갇힌 주민은 시작 지점으로, 사라진 자원에 걸린 일은 정리."""
        for m in self.d["members"].values():
            if not self.free(m["x"], m["y"]):
                m["x"], m["y"] = SPAWN[0] + 0.5, SPAWN[1] + 0.5
                m["job"] = None
            job = m["job"]
            if job and (TILE_RES.get(self.tile(job["tx"], job["ty"])) != job["res"]
                        or key(job["tx"], job["ty"]) in self.d["dep"]):
                m["job"] = None
        self.d["wild"] = [w for w in self.d["wild"] if (w["x"], w["y"]) in REACH and self.walkable(w["x"], w["y"])]

    # ---------- 지도 ----------
    def rebuild_map(self):
        rows = [list(r) for r in BASE_MAP]
        if self.d["buildings"]["bridge"] >= 1:
            for y, row in enumerate(rows):
                for x, ch in enumerate(row):
                    if ch == "b":
                        rows[y][x] = "="
        self.map = ["".join(r) for r in rows]

    def tile(self, x, y):
        if 0 <= x < MAP_W and 0 <= y < MAP_H:
            return self.map[y][x]
        return "#"

    def walkable(self, x, y):
        return self.tile(x, y) in WALKABLE

    def free(self, x, y, r=RADIUS):
        """중심 (x, y), 반경 r인 캐릭터가 벽과 겹치지 않는지."""
        w = self.walkable
        return (w(int(x - r), int(y - r)) and w(int(x + r), int(y - r))
                and w(int(x - r), int(y + r)) and w(int(x + r), int(y + r)))

    def path(self, src, dst, limit=6000):
        """src에서 dst까지 칸 경로(src 제외). limit칸 넘게 찾아봐도 없으면 None."""
        if src == dst:
            return []
        if not self.walkable(*dst):
            return None
        prev = {src: None}
        q = deque([src])
        while q and len(prev) < limit:
            cur = q.popleft()
            if cur == dst:
                break
            x, y = cur
            for dx, dy in DIRS8:
                n = (x + dx, y + dy)
                if n in prev or not self.walkable(*n):
                    continue
                if dx and dy and not (self.walkable(x + dx, y) and self.walkable(x, y + dy)):
                    continue
                prev[n] = cur
                q.append(n)
        if dst not in prev:
            return None
        out, cur = [], dst
        while cur != src:
            out.append(cur)
            cur = prev[cur]
        return out[::-1]

    def stands(self, tx, ty):
        """자원 (tx, ty)를 캘 때 설 수 있는 칸들. 밭은 그 위도 된다."""
        out = [(tx + dx, ty + dy) for dx, dy in DIRS8 if self.walkable(tx + dx, ty + dy)]
        if self.tile(tx, ty) == "F":
            out.insert(0, (tx, ty))
        return out

    # ---------- 공통 ----------
    def new_id(self, prefix):
        self.uid += 1
        return f"{prefix}{int(time.time()) % 100000}_{self.uid}"

    def log(self, text, now=None):
        self.d["log"].append({"t": now or time.time(), "text": text})
        del self.d["log"][:-LOG_SIZE]
        self.dirty = self.save_dirty = True

    def tell(self, pid, text):
        self.messages.append((pid, text))

    def member(self, pid):
        return self.d["members"][pid]

    def level(self):
        return sum(self.d["buildings"].values())

    def cap(self, res):
        cap = warehouse_cap(self.d["buildings"]["warehouse"])
        return cap // 5 if res in ("crystal", "gold") else cap

    def add_res(self, res, n):
        """창고에 넣고 실제로 들어간 양을 반환."""
        room = max(0, self.cap(res) - self.d["res"][res])
        n = min(n, room)
        self.d["res"][res] += n
        return n

    def near_tile(self, m, x, y, reach=1):
        return cheb(int(m["x"]), int(m["y"]), x, y) <= reach

    # ---------- 입장 ----------
    def join(self, name, token):
        d = self.d
        pid = d["tokens"].get(token or "")
        if pid and pid in d["members"]:
            return pid, token
        pid = secrets.token_hex(3)
        token = secrets.token_urlsafe(16)
        now = time.time()
        m = {
            "name": name[:10] or "주민", "color": COLORS[len(d["members"]) % len(COLORS)],
            "skills": {k: 0 for k in GATHER + ["combat"]}, "contrib": 0, "coins": 0.0,
            "tools": {k: 0 for k in TOOLS}, "job": None, "x": SPAWN[0] + 0.5, "y": SPAWN[1] + 0.5,
            "energy": ENERGY_MAX, "energy_t": now, "boss_dmg": 0, "joined": now, "last_seen": now,
            "gear": [], "eq": {"weapon": None, "armor": None}, "hurt_t": 0,
        }
        m["hp"] = self.max_hp(m)
        d["members"][pid] = m
        d["tokens"][token] = pid
        self.log(f"{m['name']}님이 마을에 이사 왔습니다!")
        return pid, token

    def connect(self, pid, on):
        m = self.member(pid)
        if on:
            self.online.add(pid)
        else:
            self.online.discard(pid)
            self.last_pos.pop(pid, None)
            self.target.pop(pid, None)
        m["last_seen"] = time.time()
        self.dirty = self.save_dirty = True

    # ---------- 생산 ----------
    def job_rate(self, m, res):
        """초당 생산량 (같이 일하기 보너스 제외)."""
        b = self.d["buildings"]
        lvl = b[JOBS[res]["building"]]
        if lvl <= 0:
            return 0
        rate = JOBS[res]["rate"] / 60
        rate *= 1 + 0.25 * (lvl - 1)
        rate *= 1 + 0.1 * b["smithy"]
        rate *= 1 + SKILL_BONUS * (skill_level(m["skills"][res]) - 1)
        rate *= 1 + TOOL_BONUS * m["tools"].get(res, 0)
        return rate

    def together(self, pid, res):
        """접속 중일 때 같은 자원을 캐는 다른 접속자 수에 따른 보너스."""
        if pid not in self.online:
            return 1.0
        k = sum(1 for o in self.online if o != pid and (self.member(o)["job"] or {}).get("res") == res)
        return 1 + min(1.0, TOGETHER_BONUS * k)

    def deposit(self, pid, res, amount):
        """amount만큼 쌓고 이번에 실제로 캔(정수) 개수를 반환. 창고가 차면 넘치는 건 버려진다."""
        m = self.member(pid)
        job = m["job"]
        job["acc"] += amount
        whole = int(job["acc"] + 1e-9)
        if whole <= 0:
            return 0
        job["acc"] = max(0.0, job["acc"] - whole)
        got = self.add_res(res, whole)
        if got < whole and pid in self.online and self.rng.random() < 0.2:
            self.tell(pid, f"창고에 {RESOURCES[res]['name']}이(가) 가득 찼습니다. 창고를 늘려주세요!")
        if got:
            m["contrib"] += got
            m["skills"][res] += got * (1 + 0.1 * self.d["buildings"]["fountain"])
            m["coins"] += got * COIN_PER_UNIT
            job["total"] += got
            if pid in self.online:
                self.ev.append({"k": "gain", "pid": pid, "res": res, "n": got})
            self.dirty = self.save_dirty = True
        return whole

    def remaining(self, res, tx, ty):
        return self.d["amt"].get(key(tx, ty), RES_AMOUNT[res])

    def deplete(self, tx, ty, res, at):
        k = key(tx, ty)
        self.d["amt"].pop(k, None)
        self.d["dep"][k] = at + REGROW[res]
        self.ev.append({"k": "fell", "x": tx, "y": ty, "res": res})
        self.dirty = self.save_dirty = True

    def take(self, pid, n, at):
        """현재 일하는 칸에서 n개를 캤다. 다 떨어지면 칸을 비우고 다음 칸으로. 계속할 수 있으면 True."""
        job = self.member(pid)["job"]
        res = job["res"]
        if res not in RES_AMOUNT or n <= 0:
            return True
        k = key(job["tx"], job["ty"])
        left = self.remaining(res, job["tx"], job["ty"]) - n
        if left > 0:
            self.d["amt"][k] = left
            return True
        self.deplete(job["tx"], job["ty"], res, at)
        return self.retarget(pid, at)

    def available(self, res, x, y):
        return TILE_RES.get(self.tile(x, y)) == res and key(x, y) not in self.d["dep"]

    def retarget(self, pid, at):
        """다 캔 칸 대신 옆 칸(오프라인이면 근처)의 같은 자원으로 옮겨 간다."""
        m = self.member(pid)
        job = m["job"]
        res = job["res"]
        px, py = int(m["x"]), int(m["y"])
        near = [(px + dx, py + dy) for dx, dy in DIRS8 + [(0, 0)] if self.available(res, px + dx, py + dy)]
        if near:
            job["tx"], job["ty"] = near[0]
            return True
        if pid in self.online:
            self.tell(pid, f"주변 {RESOURCES[res]['name']}을(를) 다 캤어요. 다른 곳으로 가서 다시 시작하세요.")
            self.end_job(pid, at)
            return False
        best = None
        for dy in range(-RETARGET_RADIUS, RETARGET_RADIUS + 1):
            for dx in range(-RETARGET_RADIUS, RETARGET_RADIUS + 1):
                tx, ty = px + dx, py + dy
                if not self.available(res, tx, ty):
                    continue
                for sx, sy in self.stands(tx, ty):
                    d2 = (sx - px) ** 2 + (sy - py) ** 2
                    if self.free(sx + 0.5, sy + 0.5) and (best is None or d2 < best[0]):
                        best = (d2, tx, ty, sx, sy)
        if not best:
            self.end_job(pid, at)
            return False
        _, tx, ty, sx, sy = best
        job.update({"tx": tx, "ty": ty, "sx": sx, "sy": sy})
        m["x"], m["y"] = sx + 0.5, sy + 0.5
        self.moved = True
        return True

    def start_job(self, pid, res, tx, ty, now):
        m = self.member(pid)
        if res == "ore" and self.d["buildings"]["mine"] <= 0:
            raise VillageError("광산을 먼저 지어야 합니다.")
        cap = OFFLINE_CAP + 3600 * self.d["buildings"]["inn"]
        m["job"] = {"res": res, "tx": tx, "ty": ty, "t": now, "end": now + cap, "acc": 0.0, "total": 0,
                    "sx": int(m["x"]), "sy": int(m["y"])}
        self.dirty = self.save_dirty = True

    def end_job(self, pid, at):
        m = self.member(pid)
        job = m["job"]
        if not job:
            return
        if job["total"]:
            self.log(f"{m['name']}: {RESOURCES[job['res']]['name']} {job['total']}개 채집 완료", at)
        m["job"] = None
        self.dirty = self.save_dirty = True

    def stop_job(self, pid, now):
        if self.member(pid)["job"]:
            self.accrue(pid, now)
            self.end_job(pid, now)

    def accrue(self, pid, now):
        """마지막 계산 이후 흐른 시간만큼 채집. 칸이 다 떨어지면 다음 칸으로 넘어가며 계속."""
        m = self.member(pid)
        for _ in range(500):
            job = m["job"]
            if not job:
                return
            t_end = min(now, job["end"])
            dt = t_end - job["t"]
            if dt <= 0:
                break
            res = job["res"]
            rate = self.job_rate(m, res) * self.together(pid, res)
            if rate <= 0:
                job["t"] = t_end
                break
            if res in RES_AMOUNT:
                need = (self.remaining(res, job["tx"], job["ty"]) - job["acc"]) / rate
                if need <= dt:  # 이번 계산 안에 이 칸이 다 떨어진다
                    at = job["t"] + max(0.0, need)
                    n = self.deposit(pid, res, max(0.0, need) * rate + 1e-6)
                    job["t"] = at
                    if not self.take(pid, max(n, self.remaining(res, job["tx"], job["ty"])), at):
                        return
                    continue
            n = self.deposit(pid, res, rate * dt)
            job["t"] = t_end
            self.take(pid, n, t_end)
            break
        job = m["job"]
        if job and now >= job["end"]:
            self.end_job(pid, job["end"])

    def work(self, pid, now):
        """열심히 일하기: 접속 중 즉시 채집."""
        m = self.member(pid)
        job = m["job"]
        if not job:
            raise VillageError("먼저 나무, 바위, 물, 밭을 클릭해 일을 시작하세요.")
        if self.cd.get((pid, "work"), 0) > now:
            return
        self.cd[(pid, "work")] = now + ACTIVE_COOLDOWN
        self.accrue(pid, now)
        if not m["job"]:
            return
        amount = ACTIVE_AMOUNT * (1 + self.job_rate(m, job["res"]) * 60) * self.together(pid, job["res"])
        n = self.deposit(pid, job["res"], amount)
        m["skills"][job["res"]] += 0.5
        self.take(pid, n, now)

    # ---------- 입력 ----------
    def set_pos(self, pid, x, y, now):
        """클라이언트가 직접 움직이고 위치를 알려준다. 속도와 벽만 검사해서 이상하면 되돌린다."""
        m = self.member(pid)
        if not (math.isfinite(x) and math.isfinite(y)):
            return
        lx, ly, lt = self.last_pos.get(pid, (m["x"], m["y"], now - 1))
        allowed = PLAYER_SPEED * max(0.05, now - lt) * 1.5 + 0.6
        if math.hypot(x - lx, y - ly) > allowed or not self.free(x, y):
            self.corrections.append((pid, m["x"], m["y"]))
            return
        m["x"], m["y"] = x, y
        self.last_pos[pid] = (x, y, now)
        self.moved = True
        job = m["job"]
        if job and (int(x), int(y)) != (job["sx"], job["sy"]):
            self.stop_job(pid, now)

    def gather(self, pid, x, y, now):
        res = TILE_RES.get(self.tile(x, y))
        if not res:
            raise VillageError("채집할 수 없는 곳입니다.")
        if self.d["buildings"][JOBS[res]["building"]] <= 0:
            raise VillageError(f"{BUILDINGS[JOBS[res]['building']]['name']}을(를) 먼저 지어야 합니다.")
        k = key(x, y)
        if k in self.d["dep"]:
            left = max(1, int((self.d["dep"][k] - now) / 60) + 1)
            raise VillageError(f"이미 다 캔 곳이에요. 약 {left}분 뒤 다시 자라요.")
        m = self.member(pid)
        if not self.near_tile(m, x, y):
            raise VillageError("자원 바로 옆에서 시작할 수 있어요.")
        self.stop_job(pid, now)
        self.target.pop(pid, None)
        self.start_job(pid, res, x, y, now)

    def build(self, pid, bid, now):
        d = self.d
        if bid not in BUILDINGS:
            raise VillageError("없는 건물입니다.")
        if d["construction"]:
            raise VillageError("이미 다른 건물을 짓고 있습니다.")
        b = BUILDINGS[bid]
        lvl = d["buildings"][bid] + 1
        if lvl > b["max"]:
            raise VillageError("최대 레벨입니다.")
        if bid != "hall" and lvl > d["buildings"]["hall"] + 1:
            raise VillageError("마을회관 레벨을 먼저 올려야 합니다.")
        if b.get("needs") and d["buildings"][b["needs"]] <= 0:
            raise VillageError(f"{BUILDINGS[b['needs']]['name']}이(가) 먼저 필요합니다.")
        self.pay(build_cost(bid, lvl))
        total = build_seconds(bid, lvl)
        d["construction"] = {"id": bid, "level": lvl, "left": total, "total": total, "by": pid}
        self.log(f"{self.member(pid)['name']}님이 {b['name']} {lvl}레벨 공사를 시작했습니다.")

    def pay(self, cost):
        d = self.d
        short = [f"{RESOURCES[k]['name']} {v - d['res'][k]}" for k, v in cost.items() if d["res"][k] < v]
        if short:
            raise VillageError("창고 자원 부족: " + ", ".join(short))
        for k, v in cost.items():
            d["res"][k] -= v

    def helpers(self):
        c = self.d["construction"]
        if not c:
            return 0
        bx, by = BUILDING_POS[c["id"]]
        return sum(1 for pid in self.online if self.near_tile(self.member(pid), bx, by, 3))

    def finish_building(self, now):
        c = self.d["construction"]
        self.d["construction"] = None
        bid, lvl = c["id"], c["level"]
        self.d["buildings"][bid] = lvl
        self.log(f"🎉 {BUILDINGS[bid]['name']} {lvl}레벨 완공!", now)
        self.ev.append({"k": "built", "id": bid})
        if bid == "bridge":
            self.rebuild_map()
        if bid == "dungeon" and not self.d["boss"]:
            self.d["boss"] = {"level": 1, "hp": BOSS_HP, "max_hp": BOSS_HP}
            self.log("던전 깊은 곳에서 동굴 트롤이 깨어났습니다...", now)

    def buy_tool(self, pid, kind):
        if kind not in TOOLS:
            raise VillageError("없는 도구입니다.")
        smithy = self.d["buildings"]["smithy"]
        if smithy <= 0:
            raise VillageError("대장간을 먼저 지어야 합니다.")
        m = self.member(pid)
        lvl = m["tools"][kind]
        if lvl >= min(TOOL_MAX, smithy):
            raise VillageError(f"대장간 레벨 {lvl + 1} 이상이 필요합니다." if lvl < TOOL_MAX else "최대 레벨입니다.")
        price = tool_price(lvl)
        if m["coins"] < price:
            raise VillageError(f"동전이 부족합니다. ({int(m['coins'])}/{price})")
        m["coins"] -= price
        m["tools"][kind] = lvl + 1
        self.dirty = self.save_dirty = True

    # ---------- 장비 ----------
    def max_hp(self, m):
        armor = GEAR.get((m.get("eq") or {}).get("armor") or "", {})
        return PLAYER_HP + HP_PER_COMBAT_LV * (skill_level(m["skills"]["combat"]) - 1) + armor.get("hp", 0)

    def defense(self, m):
        return GEAR.get(m["eq"].get("armor") or "", {}).get("df", 0)

    def craft(self, pid, gid):
        g = GEAR.get(gid)
        if not g:
            raise VillageError("없는 장비입니다.")
        m = self.member(pid)
        if gid in m["gear"]:
            raise VillageError("이미 가지고 있어요.")
        if g["smithy"] and self.d["buildings"]["smithy"] < g["smithy"]:
            raise VillageError(f"대장간 {g['smithy']}레벨이 필요합니다.")
        if m["coins"] < g["coins"]:
            raise VillageError(f"동전이 부족합니다. ({int(m['coins'])}/{g['coins']})")
        self.pay(g["cost"])
        m["coins"] -= g["coins"]
        m["gear"].append(gid)
        cur = GEAR.get(m["eq"].get(g["slot"]) or "")
        stat = "atk" if g["slot"] == "weapon" else "df"
        if not cur or cur.get(stat, 0) < g.get(stat, 0):
            self.equip(pid, gid)
        self.log(f"{m['name']}님이 {g['name']}을(를) 만들었습니다.")

    def equip(self, pid, gid):
        m = self.member(pid)
        if gid not in m["gear"]:
            raise VillageError("가지고 있지 않은 장비입니다.")
        m["eq"][GEAR[gid]["slot"]] = gid
        m["hp"] = min(m["hp"], self.max_hp(m))
        self.dirty = self.save_dirty = True

    def chat(self, pid, text):
        line = {"t": time.time(), "name": self.member(pid)["name"], "text": text[:200]}
        self.d["chat"].append(line)
        del self.d["chat"][:-CHAT_SIZE]
        self.save_dirty = True
        return line

    # ---------- 전투 ----------
    def damage_of(self, m):
        weapon = GEAR.get(m["eq"].get("weapon") or "", {})
        base = 6 + weapon.get("atk", 0) + skill_level(m["skills"]["combat"])
        return round(base * self.rng.uniform(0.85, 1.15))

    def find_monster(self, mid):
        raid = self.d["raid"]
        if raid:
            for x in raid["monsters"]:
                if x["id"] == mid:
                    return x
        for x in self.d["wild"]:
            if x["id"] == mid:
                return x
        return None

    def attack(self, pid, mid, now):
        if not self.find_monster(mid):
            return
        self.stop_job(pid, now)
        self.target[pid] = mid

    def hit_monster(self, pid, mon, now):
        m = self.member(pid)
        dmg = self.damage_of(m)
        mon["hp"] -= dmg
        m["skills"]["combat"] += 2
        mon.setdefault("hitters", [])
        if pid not in mon["hitters"]:
            mon["hitters"].append(pid)
        self.ev.append({"k": "hit", "tgt": mon["id"], "v": dmg, "src": pid})
        if mon.get("wild"):
            mon["angry"] = pid  # 맞으면 반격
        if mon["hp"] <= 0:
            if mon.get("wild"):
                self.kill_wild(mon, now)
            else:
                self.kill_monster(mon, now)

    def kill_monster(self, mon, now):
        raid = self.d["raid"]
        raid["monsters"].remove(mon)
        for pid in mon.get("hitters", []):
            if pid in self.d["members"]:
                self.member(pid)["coins"] += 3
                self.member(pid)["skills"]["combat"] += 5
        self.ev.append({"k": "die", "tgt": mon["id"]})
        self.dirty = self.save_dirty = True
        if not raid["monsters"]:
            self.d["raid"] = None
            self.d["stats"]["raids_won"] += 1
            for pid in raid.get("fighters", []):
                if pid in self.d["members"]:
                    self.member(pid)["coins"] += 15
            gold = self.add_res("gold", 5 * self.d["buildings"]["hall"])
            self.log(f"⚔ 습격을 막아냈습니다! (금화 +{gold})", now)
            self.d["next_raid"] = now + self.rng.uniform(*RAID_INTERVAL)

    def kill_wild(self, mon, now):
        d = self.d
        if mon in d["wild"]:
            d["wild"].remove(mon)
        w = WILD[mon["kind"]]
        drops = []
        for res, (a, b) in w["drops"].items():
            n = self.add_res(res, self.rng.randint(a, b))
            if n:
                drops.append(f"{RESOURCES[res]['name']} +{n}")
        hitters = [p for p in mon.get("hitters", []) if p in d["members"]]
        for pid in hitters:
            self.member(pid)["coins"] += w["coins"]
            self.member(pid)["skills"]["combat"] += w["xp"]
        d["stats"]["kills"] += 1
        d["wild_next"][mon["zone"]] = max(d["wild_next"].get(mon["zone"], 0), now + WILD_RESPAWN)
        self.ev.append({"k": "die", "tgt": mon["id"], "drops": drops})
        if hitters and drops:
            names = ", ".join(self.member(p)["name"] for p in hitters)
            self.log(f"{names}: {w['name']} 처치 ({', '.join(drops)})", now)
        self.dirty = self.save_dirty = True

    def hurt(self, pid, dmg, src, now):
        m = self.member(pid)
        dmg = max(1, dmg - self.defense(m))
        m["hp"] -= dmg
        m["hurt_t"] = now
        self.ev.append({"k": "hit", "tgt": pid, "v": dmg, "src": src})
        if m["hp"] <= 0:
            m["hp"] = self.max_hp(m) // 2
            self.stop_job(pid, now)
            self.target.pop(pid, None)
            m["x"], m["y"] = SPAWN[0] + 0.5, SPAWN[1] + 0.5
            self.last_pos[pid] = (m["x"], m["y"], now)
            self.corrections.append((pid, m["x"], m["y"]))
            self.ev.append({"k": "down", "pid": pid})
            self.tell(pid, "쓰러졌어요... 마을 분수 앞에서 정신을 차렸습니다.")
            self.log(f"{m['name']}님이 몬스터에게 쓰러졌습니다.", now)
        self.dirty = True

    def boss_attack(self, pid, now):
        d = self.d
        boss = d["boss"]
        if not boss:
            raise VillageError("던전 입구를 지어야 보스에 도전할 수 있습니다.")
        m = self.member(pid)
        bx, by = BUILDING_POS["dungeon"]
        if not self.near_tile(m, bx, by, 2):
            raise VillageError("던전 입구 가까이 가야 공격할 수 있어요.")
        if self.cd.get((pid, "boss"), 0) > now:
            return
        energy = self.energy(m, now)
        if energy < 1:
            raise VillageError(f"행동력이 없습니다. ({ENERGY_REGEN // 60}분마다 1 회복)")
        self.cd[(pid, "boss")] = now + ATTACK_COOLDOWN
        m["energy"], m["energy_t"] = energy - 1, now
        dmg = self.damage_of(m) * 2
        boss["hp"] -= dmg
        m["boss_dmg"] += dmg
        m["skills"]["combat"] += 3
        boss.setdefault("hitters", {})
        boss["hitters"][pid] = boss["hitters"].get(pid, 0) + dmg
        self.ev.append({"k": "hit", "tgt": "boss", "v": dmg, "src": pid})
        self.dirty = self.save_dirty = True
        if boss["hp"] <= 0:
            lvl = boss["level"]
            crystal = self.add_res("crystal", 15 * lvl)
            gold = self.add_res("gold", 40 * lvl)
            total = sum(boss["hitters"].values()) or 1
            for hid, dd in boss["hitters"].items():
                if hid in d["members"]:
                    self.member(hid)["coins"] += 100 * lvl * dd / total
            d["stats"]["bosses"] += 1
            self.log(f"🏆 동굴 트롤 {lvl}단계 처치! 수정 +{crystal}, 금화 +{gold}", now)
            hp = round(BOSS_HP * BOSS_GROWTH ** lvl)
            d["boss"] = {"level": lvl + 1, "hp": hp, "max_hp": hp}

    def energy(self, m, now):
        return min(ENERGY_MAX, m["energy"] + (now - m["energy_t"]) / ENERGY_REGEN)

    # ---------- 야생 몬스터 ----------
    def spawn_wild(self, zone, now):
        x1, y1, x2, y2 = ZONES[zone]["rect"]
        kinds = [k for k, w in WILD.items() if w["zone"] == zone]
        for _ in range(40):
            x, y = self.rng.randint(x1, x2), self.rng.randint(y1, y2)
            if not self.walkable(x, y) or (x, y) not in REACH or cheb(x, y, *SPAWN) <= SAFE_RADIUS:
                continue
            if any(cheb(x, y, int(self.member(p)["x"]), int(self.member(p)["y"])) < 8 for p in self.online):
                continue
            kind = self.rng.choice(kinds)
            hp = WILD[kind]["hp"]
            self.d["wild"].append({"id": self.new_id("w"), "kind": kind, "zone": zone, "x": x, "y": y,
                                   "home": [x, y], "hp": hp, "max_hp": hp, "wild": True})
            self.dirty = self.save_dirty = True
            return

    def wild_tick(self, now):
        d = self.d
        for zone, z in ZONES.items():
            alive = sum(1 for w in d["wild"] if w["zone"] == zone)
            if alive < z["count"] and d["wild_next"].get(zone, 0) <= now:
                self.spawn_wild(zone, now)
                d["wild_next"][zone] = now + 8  # 한 번에 몰려 나오지 않게

    def move_toward(self, mon, tx, ty, now, adjacent=False):
        """길을 찾아 한 칸 다가가기. 나무·바위를 돌아서 간다. adjacent면 바로 옆 칸에서 멈춘다."""
        goal = (tx, ty)
        st = self.mpaths.get(mon["id"])
        if not st or st["goal"] != goal or not st["p"] or now >= st["t"]:
            p = self.path((mon["x"], mon["y"]), goal, limit=900)
            if p is None:
                return self.step_toward(mon, tx, ty)
            if adjacent:
                p = p[:-1]
            st = self.mpaths[mon["id"]] = {"goal": goal, "p": p, "t": now + 1.0}
        if not st["p"]:
            return False
        nx, ny = st["p"][0]
        if not self.walkable(nx, ny) or cheb(nx, ny, mon["x"], mon["y"]) > 1:
            st["p"] = []
            return False
        st["p"].pop(0)
        mon["x"], mon["y"] = nx, ny
        self.moved = True
        return True

    def step_toward(self, mon, tx, ty):
        """한 칸 다가가기 (대각선 먼저, 막히면 가로/세로)."""
        dx = (tx > mon["x"]) - (tx < mon["x"])
        dy = (ty > mon["y"]) - (ty < mon["y"])
        for sx, sy in ((dx, dy), (dx, 0), (0, dy)):
            if not (sx or sy):
                continue
            nx, ny = mon["x"] + sx, mon["y"] + sy
            if self.walkable(nx, ny) and not (sx and sy and not (
                    self.walkable(mon["x"] + sx, mon["y"]) and self.walkable(mon["x"], mon["y"] + sy))):
                mon["x"], mon["y"] = nx, ny
                self.moved = True
                return True
        return False

    def wild_move(self, now):
        for mon in list(self.d["wild"]):
            w = WILD[mon["kind"]]
            if self.cd.get((mon["id"], "move"), 0) > now:
                continue
            self.cd[(mon["id"], "move")] = now + 1 / w["speed"]
            hx, hy = mon["home"]
            # 덤빌 상대: 맞은 상대 또는 가까운 접속자 (마을 안은 안전)
            prey = None
            for pid in self.online:
                m = self.member(pid)
                px, py = int(m["x"]), int(m["y"])
                if cheb(px, py, *SPAWN) <= SAFE_RADIUS:
                    continue
                dist = cheb(px, py, mon["x"], mon["y"])
                if (dist <= WILD_AGGRO or mon.get("angry") == pid) and (not prey or dist < prey[0]):
                    prey = (dist, pid, px, py)
            # 너무 멀리 쫓아왔으면 집에 도착할 때까지 돌아간다 (경계에서 왔다 갔다 하며 멈추지 않게)
            if cheb(mon["x"], mon["y"], hx, hy) > WILD_LEASH:
                mon["returning"] = True
                mon.pop("angry", None)
            if mon.get("returning"):
                if cheb(mon["x"], mon["y"], hx, hy) <= 1 or not self.move_toward(mon, hx, hy, now):
                    mon.pop("returning", None)
                    mon["hp"] = mon["max_hp"]
                continue
            if prey:
                dist, pid, px, py = prey
                if dist <= 1:
                    if self.cd.get((mon["id"], "atk"), 0) <= now:
                        self.cd[(mon["id"], "atk")] = now + WILD_ATTACK_CD
                        self.hurt(pid, round(w["atk"] * self.rng.uniform(0.8, 1.2)), mon["id"], now)
                else:
                    self.move_toward(mon, px, py, now, adjacent=True)
                continue
            mon.pop("angry", None)
            if cheb(mon["x"], mon["y"], hx, hy) > 2:
                self.move_toward(mon, hx, hy, now)  # 집으로
            elif self.rng.random() < 0.12:
                dx, dy = self.rng.choice(DIRS8)
                if self.walkable(mon["x"] + dx, mon["y"] + dy) and cheb(mon["x"] + dx, mon["y"] + dy, hx, hy) <= 3:
                    mon["x"] += dx
                    mon["y"] += dy
                    self.moved = True

    # ---------- 습격 ----------
    def start_raid(self, at):
        d = self.d
        n = 3 + 2 * d["buildings"]["hall"]
        hp = round(25 * (1 + 0.3 * self.level()))
        mons = []
        for i in range(n):
            x, y = self.rng.choice(RAID_SPAWNS)
            mons.append({"id": f"r{i}", "kind": self.rng.choice(RAID_MONSTERS), "x": x, "y": y, "hp": hp, "max_hp": hp})
        d["raid"] = {"monsters": mons, "total": n * hp, "start": at, "deadline": at + RAID_DURATION,
                     "t": at, "fighters": []}
        self.log("🚨 몬스터들이 마을을 습격했습니다! 30분 안에 물리치세요!", at)
        self.ev.append({"k": "raid"})

    def raid_tick(self, now):
        d = self.d
        raid = d["raid"]
        if not raid:
            if now >= d["next_raid"] and self.level() < RAID_MIN_LEVEL:
                d["next_raid"] = now + self.rng.uniform(*RAID_INTERVAL)  # 작은 마을은 습격 안 함
                return
            if now >= d["next_raid"] and d["members"]:
                self.start_raid(d["next_raid"])
                raid = d["raid"]
            else:
                return
        t1 = min(now, raid["deadline"])
        dt = t1 - raid["t"]
        raid["t"] = t1
        tower = d["buildings"]["tower"]
        if tower and dt > 0:
            pool = tower * TOWER_DPS * dt
            for mon in list(raid["monsters"]):
                if pool <= 0:
                    break
                use = min(pool, mon["hp"])
                mon["hp"] -= use
                pool -= use
                if dt < 2 and use >= 1:
                    self.ev.append({"k": "tower", "tgt": mon["id"]})
                if mon["hp"] <= 0:
                    self.kill_monster(mon, t1)
                    if not d["raid"]:
                        return
            self.dirty = True
        if now >= raid["deadline"] and d["raid"]:
            left = sum(max(0, m["hp"]) for m in raid["monsters"]) / max(1, raid["total"])
            lost = []
            for k in d["res"]:
                n = int(d["res"][k] * RAID_STEAL * left)
                if n:
                    d["res"][k] -= n
                    lost.append(f"{RESOURCES[k]['name']} {n}")
            d["raid"] = None
            d["stats"]["raids_lost"] += 1
            d["next_raid"] = raid["deadline"] + self.rng.uniform(*RAID_INTERVAL)
            self.log("💸 습격을 막지 못했습니다... 빼앗긴 자원: " + (", ".join(lost) or "없음"), raid["deadline"])

    # ---------- 틱 ----------
    def step(self, now):
        """경제 진행. 1초마다(그리고 마을을 불러올 때 한 번) 호출."""
        d = self.d
        dt = now - d["last"]
        if dt <= 0:
            return
        for k in [k for k, at in d["dep"].items() if at <= now]:   # 다시 자람
            del d["dep"][k]
            x, y = map(int, k.split(","))
            self.ev.append({"k": "regrow", "x": x, "y": y})
            self.dirty = self.save_dirty = True
        for pid in list(d["members"]):
            self.accrue(pid, now)
        c = d["construction"]
        if c:
            c["left"] -= dt * (1 + self.helpers())
            if c["left"] <= 0:
                self.finish_building(now)
            self.dirty = True
        self.raid_tick(now)
        self.wild_tick(now)
        d["last"] = now

    def move_tick(self, now):
        """0.2초마다: 플레이어 근접 공격, 체력 회복, 몬스터 이동. (플레이어 이동은 클라이언트가 한다)"""
        raid = self.d["raid"]
        for pid in list(self.online):
            m = self.member(pid)
            mx = self.max_hp(m)
            if m["hp"] < mx and now - m["hurt_t"] > REGEN_DELAY:
                m["hp"] = min(mx, m["hp"] + REGEN_RATE * TICK)
                self.moved = True
            tgt = self.target.get(pid)
            if not tgt:
                continue
            mon = self.find_monster(tgt)
            if not mon:
                self.target.pop(pid, None)
            elif self.near_tile(m, mon["x"], mon["y"]) and self.cd.get((pid, "atk"), 0) <= now:
                self.cd[(pid, "atk")] = now + ATTACK_COOLDOWN
                if raid and mon in raid["monsters"] and pid not in raid["fighters"]:
                    raid["fighters"].append(pid)
                self.hit_monster(pid, mon, now)
                raid = self.d["raid"]
        if raid and self.online:
            wx, wy = BUILDING_POS["warehouse"]
            for mon in raid["monsters"]:
                if self.rng.random() < 0.15 and cheb(mon["x"], mon["y"], wx, wy) > 1:
                    self.move_toward(mon, wx, wy + 1, now)
        if self.online:
            self.wild_move(now)

    # ---------- 직렬화 ----------
    def public(self, now):
        d = self.d
        members = {}
        for pid, m in d["members"].items():
            job = m["job"]
            members[pid] = {
                "name": m["name"], "color": m["color"], "x": round(m["x"], 2), "y": round(m["y"], 2),
                "online": pid in self.online, "contrib": m["contrib"], "coins": int(m["coins"]),
                "tools": m["tools"], "gear": m["gear"], "eq": m["eq"],
                "hp": round(m["hp"]), "max_hp": self.max_hp(m),
                "skills": {k: skill_level(v) for k, v in m["skills"].items()},
                "xp": {k: round(v) for k, v in m["skills"].items()},
                "energy": round(self.energy(m, now), 1), "boss_dmg": m["boss_dmg"], "last_seen": m["last_seen"],
                "job": job and {"res": job["res"], "tx": job["tx"], "ty": job["ty"], "end": job["end"],
                                "total": job["total"],
                                "rate": round(self.job_rate(m, job["res"]) * 60 * self.together(pid, job["res"]), 2)},
            }
        c = d["construction"]
        return {
            "code": d["code"], "name": d["name"], "now": now, "level": self.level(),
            "res": d["res"], "caps": {k: self.cap(k) for k in RESOURCES}, "buildings": d["buildings"],
            "construction": c and dict(c, helpers=self.helpers()),
            "costs": {bid: build_cost(bid, lvl + 1) for bid, lvl in d["buildings"].items()
                      if lvl < BUILDINGS[bid]["max"]},
            "times": {bid: build_seconds(bid, lvl + 1) for bid, lvl in d["buildings"].items()
                      if lvl < BUILDINGS[bid]["max"]},
            "members": members, "log": d["log"][-40:], "raid": d["raid"] and {
                "monsters": [{k: x[k] for k in ("id", "kind", "x", "y", "hp", "max_hp")} for x in d["raid"]["monsters"]],
                "deadline": d["raid"]["deadline"]},
            "wild": [{k: x[k] for k in ("id", "kind", "x", "y", "hp", "max_hp")} for x in d["wild"]],
            "dep": d["dep"],
            "next_raid": d["next_raid"], "boss": d["boss"] and {k: d["boss"][k] for k in ("level", "hp", "max_hp")},
            "stats": d["stats"], "map_bridge": d["buildings"]["bridge"] >= 1,
        }

    def positions(self):
        raid = self.d["raid"]
        return {"p": [[pid, round(self.member(pid)["x"], 2), round(self.member(pid)["y"], 2),
                       round(self.member(pid)["hp"])] for pid in self.online],
                "m": [[x["id"], x["x"], x["y"], x["hp"]] for x in raid["monsters"]] if raid else [],
                "w": [[x["id"], x["x"], x["y"], x["hp"]] for x in self.d["wild"]],
                "ev": self.ev}
