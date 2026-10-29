import asyncio
import logging
import secrets
import time
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from village import db
from village.data import (BUILDING_POS, BUILDING_W, BUILDINGS, ENERGY_MAX, ENERGY_REGEN, GEAR, JOBS, MONSTER_NAMES,
                          REGROW, SAFE_RADIUS, WILD,
                          OFFLINE_CAP, RESOURCES, SPAWN, TOOL_MAX, TOOLS, tool_price)
from village.world import BASE_MAP, Village, VillageError, new_village

log = logging.getLogger("village")
STATIC = Path(__file__).parent / "static"
MOVE_TICK = 0.2
SAVE_EVERY = 600       # 접속 중 저장 주기. 길게 잡아야 Neon 같은 서버리스 DB가 그 사이에 쉰다
HOUSEKEEP_EVERY = 60
UNLOAD_AFTER = 180
CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"


class Room:
    def __init__(self, village):
        self.v = village
        self.lock = asyncio.Lock()
        self.sockets = {}            # pid -> WebSocket
        self.last_active = time.time()
        self.last_save = time.time()
        self.last_state = 0.0
        self.task = None

    async def send(self, ws, msg):
        try:
            await ws.send_json(msg)
        except Exception:
            pass

    async def broadcast(self, msg):
        await asyncio.gather(*(self.send(ws, msg) for ws in list(self.sockets.values())))

    async def flush(self, force=False):
        v = self.v
        now = time.time()
        if v.dirty and (force or now - self.last_state >= 0.5):
            v.dirty = False
            self.last_state = now
            await self.broadcast({"t": "state", "s": v.public(now), "ev": v.ev})
            v.ev, v.moved = [], False
        elif v.moved or v.ev:
            await self.broadcast({"t": "tk", **v.positions()})
            v.ev, v.moved = [], False
        fixes, v.corrections = v.corrections, []
        for pid, x, y in fixes:
            ws = self.sockets.get(pid)
            if ws:
                await self.send(ws, {"t": "you", "x": x, "y": y})
        msgs, v.messages = v.messages, []
        for pid, text in msgs:
            ws = self.sockets.get(pid)
            if ws:
                await self.send(ws, {"t": "error", "msg": text})

    async def run(self):
        loop = asyncio.get_running_loop()
        next_t, n = loop.time(), 0
        while True:
            next_t += MOVE_TICK
            await asyncio.sleep(max(0, next_t - loop.time()))
            if not self.sockets:
                next_t = loop.time()
                continue
            n += 1
            async with self.lock:
                now = time.time()
                self.v.move_tick(now)
                if n % 5 == 0:
                    self.v.step(now)
                await self.flush()


rooms: dict[str, Room] = {}
rooms_lock = asyncio.Lock()


async def get_room(code):
    code = code.upper()
    async with rooms_lock:
        room = rooms.get(code)
        if room:
            return room
        data = await asyncio.to_thread(db.load, code)
        if not data:
            return None
        v = Village(data)
        v.step(time.time())  # 잠들어 있던 시간 따라잡기
        room = rooms[code] = Room(v)
        room.task = asyncio.create_task(room.run())
        return room


async def save_room(room):
    room.v.save_dirty = False
    room.last_save = time.time()
    await asyncio.to_thread(db.save, room.v.d["code"], room.v.d)


async def housekeeping():
    """주기적 저장 + 빈 마을은 메모리에서 내린다."""
    while True:
        await asyncio.sleep(HOUSEKEEP_EVERY)
        now = time.time()
        for code, room in list(rooms.items()):
            try:
                async with room.lock:
                    room.v.step(now)
                    due = now - room.last_save >= SAVE_EVERY or not room.sockets
                    if room.v.save_dirty and due:
                        await save_room(room)
                if not room.sockets and now - room.last_active > UNLOAD_AFTER:
                    async with rooms_lock:
                        if not room.sockets:
                            rooms.pop(code, None)
                            room.task.cancel()
            except Exception:
                log.exception("저장 실패: %s", code)


@asynccontextmanager
async def lifespan(app):
    await asyncio.to_thread(db.init)
    task = asyncio.create_task(housekeeping())
    yield
    task.cancel()
    for room in list(rooms.values()):
        try:
            room.v.step(time.time())
            await save_room(room)
        except Exception:
            log.exception("종료 저장 실패")


app = FastAPI(lifespan=lifespan, docs_url=None, redoc_url=None)
app.mount("/static", StaticFiles(directory=STATIC), name="static")


@app.get("/")
async def index():
    return FileResponse(STATIC / "index.html")


@app.get("/healthz")
async def healthz():
    return {"ok": True, "loaded": len(rooms), "storage": db.storage_name()}


@app.get("/api/meta")
async def meta():
    return {"resources": RESOURCES, "buildings": BUILDINGS, "building_pos": BUILDING_POS, "jobs": JOBS,
            "building_w": BUILDING_W, "gear": GEAR, "wild": WILD, "regrow": REGROW, "safe_radius": SAFE_RADIUS,
            "map": BASE_MAP, "spawn": SPAWN, "tools": TOOLS, "tool_max": TOOL_MAX,
            "tool_prices": [tool_price(i) for i in range(TOOL_MAX)], "monsters": MONSTER_NAMES,
            "energy_max": ENERGY_MAX, "energy_regen": ENERGY_REGEN, "offline_cap": OFFLINE_CAP,
            "storage": db.storage_name()}


class NewVillage(BaseModel):
    name: str


@app.post("/api/villages")
async def create_village(body: NewVillage):
    for _ in range(20):
        code = "".join(secrets.choice(CODE_CHARS) for _ in range(5))
        if not await asyncio.to_thread(db.exists, code):
            break
    else:
        raise HTTPException(503, "잠시 후 다시 시도하세요.")
    await asyncio.to_thread(db.save, code, new_village(code, body.name.strip()))
    return {"code": code}


@app.get("/api/villages/{code}")
async def village_info(code: str):
    room = await get_room(code)
    if not room:
        raise HTTPException(404, "없는 마을입니다.")
    d = room.v.d
    return {"code": d["code"], "name": d["name"], "members": len(d["members"]), "level": room.v.level()}


@app.websocket("/ws/{code}")
async def ws_endpoint(ws: WebSocket, code: str):
    await ws.accept()
    room = await get_room(code)
    if not room:
        await ws.send_json({"t": "fatal", "msg": "없는 마을입니다."})
        await ws.close()
        return
    try:
        hello = await asyncio.wait_for(ws.receive_json(), timeout=10)
    except Exception:
        await ws.close()
        return

    v = room.v
    async with room.lock:
        is_new = hello.get("token") not in v.d["tokens"]
        pid, token = v.join(str(hello.get("name", "")).strip(), hello.get("token"))
        old = room.sockets.get(pid)
        if old:
            await room.send(old, {"t": "fatal", "msg": "다른 창에서 접속했습니다."})
            try:
                await old.close()
            except Exception:
                pass
        room.sockets[pid] = ws
        v.connect(pid, True)
        v.step(time.time())
        await ws.send_json({"t": "welcome", "you": pid, "token": token, "chat": v.d["chat"][-50:]})
        await room.flush(force=True)
        if is_new:  # 새 주민은 바로 저장
            await save_room(room)

    try:
        while True:
            msg = await ws.receive_json()
            room.last_active = time.time()
            async with room.lock:
                if room.sockets.get(pid) is not ws:
                    break
                try:
                    result = handle(v, pid, msg)
                except VillageError as e:
                    await room.send(ws, {"t": "error", "msg": str(e)})
                    continue
                except (KeyError, TypeError, ValueError):
                    await room.send(ws, {"t": "error", "msg": "잘못된 요청입니다."})
                    continue
                if msg.get("t") == "chat":
                    await room.broadcast({"t": "chat", "line": result})
                elif msg.get("t") == "pos":
                    continue  # 위치는 틱 루프가 모아서 방송
                else:
                    await room.flush(force=msg.get("t") in ("build", "buy", "craft", "equip"))
    except (WebSocketDisconnect, RuntimeError):
        pass
    finally:
        async with room.lock:
            if room.sockets.get(pid) is ws:
                del room.sockets[pid]
                v.connect(pid, False)
                room.last_active = time.time()
                await room.flush(force=True)
                if not room.sockets:  # 마지막 사람이 나가면 바로 저장
                    v.step(time.time())
                    await save_room(room)


def handle(v: Village, pid: str, msg: dict):
    t = msg.get("t")
    now = time.time()
    v.step(now)
    if t == "pos":
        return v.set_pos(pid, float(msg["x"]), float(msg["y"]), now)
    if t == "gather":
        return v.gather(pid, int(msg["x"]), int(msg["y"]), now)
    if t == "work":
        return v.work(pid, now)
    if t == "build":
        return v.build(pid, str(msg["id"]), now)
    if t == "attack":
        return v.attack(pid, str(msg["id"]), now)
    if t == "boss":
        return v.boss_attack(pid, now)
    if t == "buy":
        return v.buy_tool(pid, str(msg["kind"]))
    if t == "craft":
        return v.craft(pid, str(msg["id"]))
    if t == "equip":
        return v.equip(pid, str(msg["id"]))
    if t == "chat":
        text = str(msg.get("text", "")).strip()
        if not text:
            raise VillageError("빈 메시지")
        return v.chat(pid, text)
    raise VillageError("알 수 없는 요청")
