# 공유마을

친구들이 들어왔다 나갔다 하며 같이 키우는 마을. 일을 걸어두고 창을 닫아도 자원이 계속 쌓인다.
FastAPI + WebSocket, 그래픽은 브라우저 캔버스로 직접 그린다(이미지 파일 없음).

## 로컬 실행

```bash
pip install -r requirements.txt
uvicorn main:app --reload --port 8000
```

`DATABASE_URL`이 없으면 프로젝트 폴더의 `village.db`(SQLite)에 저장한다.

## Render 배포

1. 이 폴더를 GitHub 저장소로 push
2. **Neon 무료 Postgres 만들기** (Render 무료 서버는 디스크가 초기화되므로 필수)
   - https://neon.tech 가입 → 프로젝트 생성 → Connection string 복사
     (`postgresql://user:pass@ep-xxx.neon.tech/neondb?sslmode=require` 형태)
3. Render 대시보드 → New → Blueprint → 저장소 선택 (`render.yaml` 자동 인식)
   - `DATABASE_URL` 입력란에 2번 주소를 붙여넣기
4. 배포 후 `/healthz`에서 `"storage": "Postgres"`인지 확인

서버가 잠들어 있던 시간은 마을을 다시 불러올 때 한꺼번에 계산하므로, 15분 슬립과 상관없이 걸어둔 일은 계속 진행된다.

## 게임 규칙

- 나무/바위/물/밭(강 건너 광석)을 클릭하면 그 자리에서 일을 시작. 걸어두면 2시간(여관 레벨당 +1시간) 동안 계속
- 같은 자원을 캐는 사람이 동시에 접속해 있으면 1명당 +30%. Space: 열심히 일하기(즉시 채집)
- 자원은 공용 창고로. 건물은 아무나 지을 수 있고, 공사장 근처에 있는 사람 1명당 공사 속도 +100%
- 마을이 커지면 몇 시간마다 습격. 접속한 사람이 막거나 망루가 자동 공격. 30분 안에 못 막으면 자원 일부를 빼앗김
- 던전 입구를 지으면 동굴 트롤 등장. 행동력(3분마다 1)을 써서 며칠에 걸쳐 같이 잡는다
- 채집하면 숙련도와 동전. 동전으로 대장간에서 도구 강화

## 조작

- WASD / 방향키: 이동 (누르고 있으면 계속, 대각선 가능)
- 마우스: 자원 클릭 → 걸어가서 일 시작 / 건물 클릭 → 건물 정보 / 몬스터·트롤 클릭 → 공격
- Space: 일하는 중이면 열심히 일하기, 아니면 옆에 있는 자원으로 일 시작
- Enter: 채팅, Esc: 위장 화면(회의록)

## 구조

| 파일 | 역할 |
|---|---|
| `village/data.py` | 자원·건물·도구·습격·보스 수치, 지도 생성 (밸런스 조정은 여기) |
| `village/world.py` | 마을 규칙 (채집, 건설, 습격, 보스, 지난 시간 따라잡기) |
| `village/db.py` | 저장소 (Postgres 또는 SQLite) |
| `main.py` | 마을 불러오기/저장/내리기, WebSocket |
| `static/tiles.js` | Kenney 타일 시트 로딩, 지형·건물·캐릭터 타일 배치 |
| `static/sprites.js` | Kenney에 없는 아이콘(물고기, 수정 등) 도트 |
| `static/app.js` | 지도·건물 렌더링, 낮/밤, 입력, 사이드 패널 |

## 그래픽

`static/assets/`의 타일 이미지는 Kenney(www.kenney.nl)의 Tiny Town, Tiny Dungeon, Tiny Farm, Tiny Battle 에셋이다.
CC0 라이선스라 자유롭게 사용 가능 (`static/assets/LICENSE-kenney.txt`). 물고기·수정 아이콘과 다리 등 일부는 코드로 직접 그린다.
