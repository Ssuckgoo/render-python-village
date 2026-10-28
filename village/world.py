"""마을 규칙. 네트워크와 무관한 순수 로직.

d(dict)가 DB에 저장되는 전부다. 접속 중인 사람의 이동 경로 같은 일시 정보는 self에 둔다.
시간은 time.time() 기준 초. step(now)는 마지막 계산 이후 흐른 시간을 한 번에 처리하므로
서버가 잠들어 있던 시간도 깨어날 때 따라잡는다.
"""
import random
import secrets
import time
from collections import deque

from .data import (ACTIVE_AMOUNT, ACTIVE_COOLDOWN, ATTACK_COOLDOWN, BOSS_GROWTH, BOSS_HP, BUILDING_POS,
                   BUILDINGS, COIN_PER_UNIT, ENERGY_MAX, ENERGY_REGEN, GATHER, JOBS, MAP_H, MAP_W,
                   OFFLINE_CAP, RAID_DURATION, RAID_INTERVAL, RAID_MIN_LEVEL, RAID_MONSTERS, RAID_STEAL,
                   RESOURCES, SKILL_BONUS, SPAWN, TILE_RES, TOGETHER_BONUS, TOOL_BONUS, TOOL_MAX,
                   TOOLS, TOWER_DPS, WALKABLE, build_cost, build_seconds, make_map, skill_level,
                   tool_price, warehouse_cap)

COLORS = ["#e0524a", "#5b8cff", "#5fbf4f", "#f5c542", "#c06bff", "#ff9f1c", "#4fd1c5", "#ff6fae",
          "#9a6532", "#e6e6e6"]
LOG_SIZE = 80
CHAT_SIZE = 100
BASE_MAP = make_map()
DIRS8 = [(1, 0), (-1, 0), (0, 1), (0, -1), (1, 1), (1, -1), (-1, 1), (-1, -1)]


class VillageError(Exception):
    pass


def new_village(code, name, now=None):
    now = now or time.time()
    d = {
        "code": code, "name": name[:16] or "이름 없는 마을", "created": now, "last": now,
        "res": {k: 0 for k in RESOURCES},
        "buildings": {k: b["start"] for k, b in BUILDINGS.items()},
        "construction": None, "members": {}, "tokens": {}, "log": [], "chat": [],
        "raid": None, "next_raid": now + random.uniform(*RAID_INTERVAL) / 2,
        "boss": None, "stats": {"raids_won": 0, "raids_lost": 0, "bosses": 0},
    }
    d["res"].update({"wood": 60, "stone": 40, "food": 30})
    return d


class Village:
    def __init__(self, d):
        self.d = d
        self.online = set()
        self.paths = {}          # pid -> [(x, y), ...]
        self.pending = {}        # pid -> {"res", "x", "y"} 도착하면 시작할 일
        self.target = {}         # pid -> 몬스터 id 또는 "boss"
        self.dirs = {}           # pid -> (dx, dy) 키보드로 누르고 있는 방향
        self.cd = {}             # (pid, 종류) -> 다음 가능 시각
        self.ev = []             # 화면 연출용 이벤트
        self.moved = False
        self.dirty = True        # 전체 상태를 다시 보내야 함
        self.save_dirty = True   # DB에 저장해야 함
        self.messages = []       # (pid, text) 개인 알림
        self.rng = random.Random()
        self.rebuild_map()

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

    def path(self, src, dst, limit=6000):
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

    def stand_path(self, frm, tx, ty):
        """자원 타일 (tx, ty) 옆(밭은 그 위)의 갈 수 있는 칸까지 경로. 없으면 None."""
        if self.tile(tx, ty) == "F":
            return self.path(frm, (tx, ty))
        cands = [(tx + dx, ty + dy) for dx, dy in DIRS8 if self.walkable(tx + dx, ty + dy)]
        cands.sort(key=lambda c: (c[0] - frm[0]) ** 2 + (c[1] - frm[1]) ** 2)
        for c in cands:
            p = self.path(frm, c)
            if p is not None:
                return p
        return None

    # ---------- 공통 ----------
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

    # ---------- 입장 ----------
    def join(self, name, token):
        d = self.d
        pid = d["tokens"].get(token or "")
        if pid and pid in d["members"]:
            return pid, token
        pid = secrets.token_hex(3)
        token = secrets.token_urlsafe(16)
        now = time.time()
        d["members"][pid] = {
            "name": name[:10] or "주민", "color": COLORS[len(d["members"]) % len(COLORS)],
            "skills": {k: 0 for k in GATHER + ["combat"]}, "contrib": 0, "coins": 0.0,
            "tools": {k: 0 for k in TOOLS}, "job": None, "x": SPAWN[0], "y": SPAWN[1],
            "energy": ENERGY_MAX, "energy_t": now, "boss_dmg": 0, "joined": now, "last_seen": now,
        }
        d["tokens"][token] = pid
        self.log(f"{d['members'][pid]['name']}님이 마을에 이사 왔습니다!")
        return pid, token

    def connect(self, pid, on):
        m = self.member(pid)
        if on:
            self.online.add(pid)
        else:
            self.online.discard(pid)
            self.paths.pop(pid, None)
            self.pending.pop(pid, None)
            self.target.pop(pid, None)
            self.dirs.pop(pid, None)
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
        m = self.member(pid)
        job = m["job"]
        job["acc"] += amount
        whole = int(job["acc"])
        if whole <= 0:
            return 0
        job["acc"] -= whole
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
        return got

    def start_job(self, pid, res, tx, ty, now):
        m = self.member(pid)
        if res == "ore" and self.d["buildings"]["mine"] <= 0:
            raise VillageError("광산을 먼저 지어야 합니다.")
        cap = OFFLINE_CAP + 3600 * self.d["buildings"]["inn"]
        m["job"] = {"res": res, "tx": tx, "ty": ty, "t": now, "end": now + cap, "acc": 0.0, "total": 0}
        self.dirty = self.save_dirty = True

    def stop_job(self, pid, now):
        m = self.member(pid)
        job = m["job"]
        if not job:
            return
        self.accrue(pid, now)
        if job["total"]:
            self.log(f"{m['name']}: {RESOURCES[job['res']]['name']} {job['total']}개 채집 완료")
        m["job"] = None
        self.dirty = self.save_dirty = True

    def accrue(self, pid, now):
        m = self.member(pid)
        job = m["job"]
        if not job:
            return
        t1 = min(now, job["end"])
        dt = t1 - job["t"]
        if dt > 0:
            self.deposit(pid, job["res"], self.job_rate(m, job["res"]) * self.together(pid, job["res"]) * dt)
            job["t"] = t1
        if now >= job["end"]:
            if job["total"]:
                self.log(f"{m['name']}의 {RESOURCES[job['res']]['name']} 채집이 끝났습니다 (+{job['total']})", job["end"])
            m["job"] = None
            self.dirty = self.save_dirty = True

    def work(self, pid, now):
        """열심히 일하기: 접속 중 즉시 채집."""
        m = self.member(pid)
        job = m["job"]
        if not job:
            raise VillageError("먼저 나무, 바위, 물, 밭을 클릭해 일을 시작하세요.")
        if self.cd.get((pid, "work"), 0) > now:
            return
        self.cd[(pid, "work")] = now + ACTIVE_COOLDOWN
        amount = ACTIVE_AMOUNT * (1 + self.job_rate(m, job["res"]) * 60) * self.together(pid, job["res"])
        self.deposit(pid, job["res"], amount)
        m["skills"][job["res"]] += 0.5

    # ---------- 입력 ----------
    def move(self, pid, x, y, now):
        m = self.member(pid)
        p = self.path((m["x"], m["y"]), (int(x), int(y)))
        if p is None:
            return
        self.stop_job(pid, now)
        self.pending.pop(pid, None)
        self.target.pop(pid, None)
        self.paths[pid] = p

    def set_dir(self, pid, dx, dy, now):
        """키보드 이동: 방향을 누르고 있는 동안 틱마다 한 칸씩."""
        dx, dy = max(-1, min(1, int(dx))), max(-1, min(1, int(dy)))
        if not dx and not dy:
            self.dirs.pop(pid, None)
            return
        self.stop_job(pid, now)
        self.pending.pop(pid, None)
        self.target.pop(pid, None)
        self.paths.pop(pid, None)
        self.dirs[pid] = (dx, dy)

    def step_dir(self, pid):
        m = self.member(pid)
        dx, dy = self.dirs[pid]
        x, y = m["x"], m["y"]
        tries = [(dx, dy)]
        if dx and dy:  # 대각선이 막히면 벽을 따라 미끄러지기
            tries += [(dx, 0), (0, dy)]
        for ddx, ddy in tries:
            nx, ny = x + ddx, y + ddy
            if not self.walkable(nx, ny):
                continue
            if ddx and ddy and not (self.walkable(x + ddx, y) and self.walkable(x, y + ddy)):
                continue
            m["x"], m["y"] = nx, ny
            self.moved = True
            return

    def gather(self, pid, x, y, now):
        res = TILE_RES.get(self.tile(x, y))
        if not res:
            raise VillageError("채집할 수 없는 곳입니다.")
        if self.d["buildings"][JOBS[res]["building"]] <= 0:
            raise VillageError(f"{BUILDINGS[JOBS[res]['building']]['name']}을(를) 먼저 지어야 합니다.")
        m = self.member(pid)
        p = self.stand_path((m["x"], m["y"]), x, y)
        if p is None:
            raise VillageError("갈 수 없는 곳입니다. 가장자리부터 채집해보세요.")
        self.stop_job(pid, now)
        self.target.pop(pid, None)
        self.paths[pid] = p
        self.pending[pid] = {"res": res, "x": x, "y": y}
        if not p:
            self.arrive(pid, now)

    def arrive(self, pid, now):
        job = self.pending.pop(pid, None)
        if job:
            try:
                self.start_job(pid, job["res"], job["x"], job["y"], now)
            except VillageError as e:
                self.tell(pid, str(e))

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
        cost = build_cost(bid, lvl)
        short = [f"{RESOURCES[k]['name']} {v - d['res'][k]}" for k, v in cost.items() if d["res"][k] < v]
        if short:
            raise VillageError("자원 부족: " + ", ".join(short))
        for k, v in cost.items():
            d["res"][k] -= v
        total = build_seconds(bid, lvl)
        d["construction"] = {"id": bid, "level": lvl, "left": total, "total": total, "by": pid}
        self.log(f"{self.member(pid)['name']}님이 {b['name']} {lvl}레벨 공사를 시작했습니다.")

    def helpers(self):
        c = self.d["construction"]
        if not c:
            return 0
        bx, by = BUILDING_POS[c["id"]]
        return sum(1 for pid in self.online
                   if max(abs(self.member(pid)["x"] - bx), abs(self.member(pid)["y"] - by)) <= 3)

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

    def chat(self, pid, text):
        line = {"t": time.time(), "name": self.member(pid)["name"], "text": text[:200]}
        self.d["chat"].append(line)
        del self.d["chat"][:-CHAT_SIZE]
        self.save_dirty = True
        return line

    # ---------- 전투 ----------
    def damage_of(self, m):
        return round((6 + 4 * m["tools"]["weapon"] + skill_level(m["skills"]["combat"])) * self.rng.uniform(0.85, 1.15))

    def attack(self, pid, mid, now):
        raid = self.d["raid"]
        mon = raid and next((x for x in raid["monsters"] if x["id"] == mid), None)
        if not mon:
            return
        self.stop_job(pid, now)
        self.pending.pop(pid, None)
        self.target[pid] = mid
        self.paths.pop(pid, None)

    def hit_monster(self, pid, mon, now):
        m = self.member(pid)
        dmg = self.damage_of(m)
        mon["hp"] -= dmg
        m["skills"]["combat"] += 2
        mon.setdefault("hitters", [])
        if pid not in mon["hitters"]:
            mon["hitters"].append(pid)
        self.ev.append({"k": "hit", "tgt": mon["id"], "v": dmg, "src": pid})
        if mon["hp"] <= 0:
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

    def boss_attack(self, pid, now):
        d = self.d
        boss = d["boss"]
        if not boss:
            raise VillageError("던전 입구를 지어야 보스에 도전할 수 있습니다.")
        m = self.member(pid)
        bx, by = BUILDING_POS["dungeon"]
        if max(abs(m["x"] - bx), abs(m["y"] - by)) > 2:
            self.stop_job(pid, now)
            p = self.path((m["x"], m["y"]), (bx, by + 1))
            if p is not None:
                self.paths[pid] = p
            raise VillageError("던전 입구로 이동합니다. 도착하면 다시 공격하세요.")
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

    # ---------- 습격 ----------
    def start_raid(self, at):
        d = self.d
        n = 3 + 2 * d["buildings"]["hall"]
        hp = round(25 * (1 + 0.3 * self.level()))
        mons = []
        for i in range(n):
            x, y = self.rng.choice([(9, 14), (9, 15), (9, 16), (10, 15), (8, 15)])
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
        for pid in list(d["members"]):
            self.accrue(pid, now)
        c = d["construction"]
        if c:
            c["left"] -= dt * (1 + self.helpers())
            if c["left"] <= 0:
                self.finish_building(now)
            self.dirty = True
        self.raid_tick(now)
        d["last"] = now

    def move_tick(self, now):
        """0.2초마다: 접속자 이동, 습격 몬스터 이동, 근접 공격."""
        raid = self.d["raid"]
        for pid in list(self.online):
            m = self.member(pid)
            tgt = self.target.get(pid)
            if tgt:
                mon = raid and next((x for x in raid["monsters"] if x["id"] == tgt), None)
                if not mon:
                    self.target.pop(pid, None)
                elif max(abs(m["x"] - mon["x"]), abs(m["y"] - mon["y"])) <= 1:
                    self.paths.pop(pid, None)
                    if self.cd.get((pid, "atk"), 0) <= now:
                        self.cd[(pid, "atk")] = now + ATTACK_COOLDOWN
                        if pid not in raid["fighters"]:
                            raid["fighters"].append(pid)
                        self.hit_monster(pid, mon, now)
                elif not self.paths.get(pid) or self.cd.get((pid, "repath"), 0) <= now:
                    self.cd[(pid, "repath")] = now + 0.6
                    p = self.path((m["x"], m["y"]), (mon["x"], mon["y"]))
                    self.paths[pid] = p[:-1] if p else []
            if pid in self.dirs and not self.paths.get(pid):
                self.step_dir(pid)
                continue
            p = self.paths.get(pid)
            if p:
                m["x"], m["y"] = p.pop(0)
                self.moved = True
                if not p:
                    self.paths.pop(pid, None)
                    self.arrive(pid, now)
        if raid and self.online:
            wx, wy = BUILDING_POS["warehouse"]
            for mon in raid["monsters"]:
                if self.rng.random() < 0.15 and max(abs(mon["x"] - wx), abs(mon["y"] - wy)) > 1:
                    nx = mon["x"] + (1 if wx > mon["x"] else -1 if wx < mon["x"] else 0)
                    ny = mon["y"] + (1 if wy > mon["y"] else -1 if wy < mon["y"] else 0)
                    if self.walkable(nx, ny):
                        mon["x"], mon["y"] = nx, ny
                        self.moved = True

    # ---------- 직렬화 ----------
    def public(self, now):
        d = self.d
        members = {}
        for pid, m in d["members"].items():
            job = m["job"]
            members[pid] = {
                "name": m["name"], "color": m["color"], "x": m["x"], "y": m["y"], "online": pid in self.online,
                "contrib": m["contrib"], "coins": int(m["coins"]), "tools": m["tools"],
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
            "next_raid": d["next_raid"], "boss": d["boss"] and {k: d["boss"][k] for k in ("level", "hp", "max_hp")},
            "stats": d["stats"], "map_bridge": d["buildings"]["bridge"] >= 1,
        }

    def positions(self):
        raid = self.d["raid"]
        return {"p": [[pid, self.member(pid)["x"], self.member(pid)["y"]] for pid in self.online],
                "m": [[x["id"], x["x"], x["y"], x["hp"]] for x in raid["monsters"]] if raid else [],
                "ev": self.ev}
