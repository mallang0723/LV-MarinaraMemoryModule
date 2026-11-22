# 기억 서재 ↔ 세계관 설정집 접점 (원작 `bfafb3f` 기준)

나중에 Lumiverse판 설정집을 만들 때 **무엇을 내주면 기억 서재가 켜지는지**를 적은 목록입니다. 근거는 전부 원작 파일 줄 번호입니다(바이트 고정이라 줄이 바뀌지 않음): `runtime.orig.js`(`src/memory/ui/`, 화면), `world-panel.orig.js`(설정집 화면, 설정집 v0.7.6), `service.cjs`·`worldlink.cjs`(`src/memory/core/`, 서버쪽). 현재 이식판에는 설정집이 없어 아래 접점이 전부 「없음」으로 응답하고, 칸은 숨고 지시문은 연동 없을 때와 같습니다.

요약: 서버쪽 JS 접점 **1개 객체(`globalThis.__marinaraWorldArchive.api`) · 필드 1 + 함수 3**, 기억 서재 화면이 부르는 HTTP 경로 **6개(메서드 포함 7쌍)**, 칸 화면(설정집 화면 원본)이 부르는 HTTP 경로 **55쌍**, 화면↔칸 접점 **전역 1개 + 인스턴스 함수 2 + DOM 표시 1**.

## 1. 서버쪽: `globalThis.__marinaraWorldArchive.api` (같은 프로세스, 동기 호출)

설정집 서버 모듈이 기억 서재 서버(`service.cjs`)와 같은 프로세스에 `globalThis.__marinaraWorldArchive = { api }`를 심는 구조입니다. 기억 서재는 **읽기만** 하고 쓰지 않습니다(`worldlink.cjs:2-4`). 방 id(`chatId`)만 넘기며 전부 **동기**(await 없음)입니다.

| 항목 | 모양 | 쓰는 곳 | 없을 때 |
|---|---|---|---|
| `api.contract` | 숫자. **2 이상**이어야 연동 | `service.cjs:1258-1260` `worldLinked()` | 연동 꺼짐 |
| `api.roomEntities(chatId)` | `{ worldId, entities: [{ entityId, type, name, aliases: string[], fields: { species? } }] }`. 세계관에 연결된 방이 아니면 `worldId` 없음/falsy | 연동 판정 `service.cjs:1261`(`?.worldId`), 관계 끝 이름 보강 `1287-1288`, 종 `1300`, 인물 목록(시뮬레이터 방) `1316-1322`, 관계 줄 `1288` | `worldId` 없으면 연동 없음 |
| `api.roomRelations(chatId)` | `{ relations: [{ from, to, fromName, toName, type, note?, previous?: string[] }] }`. `from`/`to`는 `entityId`. `type`은 `가족·친구·연인·스승·제자(`'스승·제자'`)·적대` 중 하나가 현재 관계, `previous`는 과거 관계 문구 | 존재 확인 `service.cjs:1258-1260`(함수여야 함), 읽기 `1286`, 줄 만들기 `worldlink.cjs:63-81` | 함수가 없으면 연동 없음 |
| `api.names(chatId)` | `{ names: [{ original: 영문 로마자, translation: 한글 }] }`. **선택**(`?.` 호출, 없어도 됨) | `service.cjs:3394`, 합치기 `worldlink.cjs:95-102` | 이름 쌍 없음 |

- 연동 조건 = `contract >= 2` ∧ `roomRelations`가 함수 ∧ `roomEntities(chatId).worldId` 있음(`service.cjs:1256-1264`). 거기에 방마다 「설정집 연동」 스위치(`worldLink !== 'off'`, `1266-1270`)가 켜져 있어야 관계·종·이름 쌍을 씁니다. **인물 목록만은 스위치와 무관**하게 `roomEntities`를 직접 읽습니다(`1316`, 시뮬레이터 방, `type==='person'`, 이름 설명형(`isDescribedName`)은 제외).
- 호출 결과는 1분(관계·인물)까지 캐시됩니다(`service.cjs:1280-1283`, `1313`). 예외는 모두 삼켜 연동 없음처럼 동작합니다.
- 파생: 관계는 두 사람이 모두 그 정리 묶음에 나올 때만 줄이 됩니다(최대 20줄, `worldlink.cjs:13`). `fields.species`가 있는 `type:'person'`은 사람이 아닌 존재(반려동물 수첩 대상 제외, `worldlink.cjs:84-92`, `service.cjs:2138`). 종이 하나도 없는 세계관이면 종 정보 없음으로 봅니다(`service.cjs:1300`).

## 2. 기억 서재 서버가 화면에 내놓는 것 (설정집 쪽 요구 없음, 참고)

- `GET /chats/:id` 응답의 `worldLink: { linked, on }`(`service.cjs:4798`) → 화면의 「설정집 연동」 스위치(`runtime.orig.js:1890` 부근). `linked`가 참일 때만 스위치가 보임.
- `POST /chats/:id/world-link` `{ on: boolean }` → `{ worldLink: { linked, on } }`(`service.cjs:5856-5861`, 화면 호출 `runtime.orig.js:3875`).

## 3. 기억 서재 화면이 직접 부르는 HTTP (브라우저 → 설정집 서버, 같은 출처)

공통: `credentials: 'same-origin'`, `cache: 'no-store'`, 헤더 `x-marinara-csrf: 1`, POST/PUT은 `content-type: application/json`. 이식판은 이 `fetch` 3곳을 앵커 패치로 shim(`LV.fetch`)에 연결하고(`patch.mjs` `world status/get/send fetch`), shim이 설정집 경로를 404로 돌려줍니다.

| 메서드 · 경로 | 응답에서 읽는 것 | 근거 |
|---|---|---|
| `GET /api/world-archive/status` | `res.ok` ∧ `.version`(값 있음) → 칸 표시. **404·실패는 이 페이지를 다시 열기 전까지 다시 묻지 않음** | `runtime.orig.js:3553-3556`. 추가로 칸 화면 전역 `__memoryWorldPanel.start`가 있어야 함(`3559`) |
| `GET /api/world-archive/rooms/:chatId` | `.worldId`(연결 여부) | `3571-3573` |
| `GET /api/world-archive/worlds` | `.worlds: [{ worldId, name }]` (연결 안 된 방의 선택 목록) | `3574`, 선택 상자 `3582-3586` |
| `POST /api/world-archive/worlds` `{ name }` | `.worldId` (새 세계관 만들기) | `3593` |
| `PUT /api/world-archive/rooms/:chatId` `{ worldId }` | 성공 여부만 | `3594` |
| `GET /api/world-archive/rooms/:chatId/entities` | `.worldId`, `.entities`(`type==='person'`만 사용: `entityId, name, aliases`) — 「인물별」 카드의 「설정집에서」 구역 | `2276`, 사용 `2277-2285`(30초 캐시), 매칭 `waPersonOf` `runtime.orig.js:2288` |
| `GET /api/world-archive/rooms/:chatId/relations` | `.relations: [{ from, to, fromName, toName, type, note }]` (`worldId`가 있을 때만 호출, 실패하면 빈 목록) | `2277` |

## 4. 칸 화면(설정집 화면 원본)과의 접점

기억 서재는 설정집 화면 `world-panel.orig.js`(원작 `extension/vendor/world-panel.js`)를 원작 `build.py`와 같은 래퍼로 한 번 더 감싸 붙입니다(`patch.mjs` `world panel embed`: `__WORLD_ARCHIVE_EMBEDDED__ = true`, 래퍼 안 `fetch`는 shim 경유). 설정집이 연결되면 이 화면이 그대로 동작합니다.

- 화면이 심는 전역: `globalThis.__memoryWorldPanel = { version, contract: 2, start(target, opts) }`(`world-panel.orig.js:2297`, 판 번호 `PANEL_CONTRACT = 2` `:13`). 기억 서재가 부름: `start(#worldMount, { theme })`(`runtime.orig.js:3607`).
- `start()`가 돌려주는 인스턴스: `setTheme('dark'|'light')`(`world-panel.orig.js:2294`, 호출 `runtime.orig.js:3608`), `railHtml(): string`(`:2294`; 화면이 불러온 뒤에만 값, 오른쪽 칸에 이 세계관·이 방·`{{세계}}` 설명을 채움. 호출 `runtime.orig.js:1982-1985`, 1.5초 주기 갱신 `3610-3615`).
- DOM 표시: 칸이 보이면 `document.documentElement.dataset.memoryWorldTab = 'on'` (설정집 자체 떠다니는 버튼을 숨김. `runtime.orig.js:3560`, 읽는 곳 `world-panel.orig.js:2290` `tabShown`).
- 현재 방 id는 `localStorage['marinara-active-chat-id']`(`world-panel.orig.js:426`). 이식판은 기억 서재 쪽에서만 `LV.activeChatId()`로 바꿔 둠(`patch.mjs` `active chat id`)이지만 **칸 화면 쪽은 원본 그대로 `localStorage`를 읽으므로**, 설정집을 붙일 때는 이 키를 호스트의 현재 방 id로 채워 주거나(어댑터), 칸 화면 쪽 앵커를 하나 더 걸어야 합니다(미작업).
- 칸 화면은 `status.contract !== 2`이면 **읽기 전용**(`:531`)이라, 설정집 서버 `/status`의 `contract`는 2여야 합니다.

### 칸 화면이 설정집 서버(`/api/world-archive`, BASE `:15`)에 부르는 경로

호출 함수 `api(method, path, body)`(`world-panel.orig.js:429-445`)는 기억 서재 §3과 같은 헤더이며, `/api/`로 시작하는 경로는 BASE 없이 그대로 보냅니다. 아래는 서로 다른 (메서드 경로) **55쌍**(줄은 첫 호출 위치).

- 상태: `GET /status`(527; 응답 `version, contract, fields, topics, ...`), `GET /connections`(504)
- 방: `GET|PUT /rooms/:chat`(488, 2005), `GET /rooms/:chat/preview`(489), `GET|POST /rooms/:chat/auto`(492, 1840), `GET|POST /rooms/:chat/scores`(501, 2047), `POST /rooms/:chat/scores/:id/undo`(2052)
- 세계관: `GET|POST /worlds`(469, 2013), `POST /worlds/import`(2255), `PATCH|DELETE /worlds/:w`(1875, 2213), `GET /worlds/:w/export`(2203), `GET /worlds/:w/history`(496), `POST /worlds/:w/history/:id/undo`(1851), `POST /worlds/:w/merge`(1862), `GET /worlds/:w/duplicates`(480), `POST /worlds/:w/duplicates/dismiss`(1867), `GET|POST /worlds/:w/group-suggestions`(481, 1978), `GET /worlds/:w/search`(1770), `POST /worlds/:w/translate`(1730), `POST /worlds/:w/translate-back`(1940), `GET|POST /worlds/:w/tidy`(2164, 2156), `POST /worlds/:w/tidy/keep`(2173)
- 설정(entities): `GET|POST /worlds/:w/entities`(477, 1801), `PATCH|DELETE /worlds/:w/entities/:e`(1804, 1999), `GET|POST /worlds/:w/entities/:e/members`(787, 1984), `POST /worlds/:w/entities/:e/pending/:key`(2028), `PUT .../:e/applies-to`(2065), `PUT .../:e/base`(2151), `PUT .../:e/room`(2147), `POST .../:e/calendar/pending`(2076), `POST .../:e/timetable/pending`(2086)
- 관계: `GET|POST /worlds/:w/relations`(478, 2117), `PATCH|DELETE /worlds/:w/relations/:r`(2127, 2121)
- 일정·채움: `PUT /worlds/:w/timetable/cell`(2059), `PUT /worlds/:w/calendar/event`(2143), `POST /worlds/:w/calendar-gather`(2080), `POST /worlds/:w/timetable-gather`(2090), `POST /worlds/:w/applies-fill`(2099), `POST /worlds/:w/location-fill`(2105), `POST /worlds/:w/topic-fill`(2179), `POST /worlds/:w/hair-fill`(2191), `POST /worlds/:w/species-fill`(2197)
- 호스트 쪽 경로(설정집 서버가 아니라 **Marinara 호스트**): `GET /api/chats/:chat`(490; 응답 `.name`만 사용, 실패해도 됨). Lumiverse판에서는 이 한 줄이 호스트 채팅 이름 조회로 바뀌어야 함(shim에서 처리 가능).

## 5. 정리: Lumiverse판 설정집이 해야 할 일

1. 서버(백엔드)에서 `globalThis.__marinaraWorldArchive = { api: { contract: 2, roomEntities, roomRelations, names } }`를 기억 서재와 **같은 프로세스·같은 `globalThis`**에 심기(§1). Lumiverse 확장은 확장마다 프로세스/격리가 다를 수 있어 **미확인** — 안 되면 기억 서재 어댑터가 rpc/이벤트로 같은 모양을 내주는 대역이 필요.
2. 기억 서재 화면의 HTTP 7쌍(§3)을 shim에서 설정집 쪽으로 연결(지금은 404 응답). `status`에 `version`이 있어야 칸이 나타남.
3. `globalThis.__memoryWorldPanel`(§4)을 설정집 화면 번들이 제공(원작처럼 `extension/vendor/world-panel.js`를 그대로 두면 됨). 칸 화면의 55쌍 HTTP 경로와 현재 방 id 조회(`marinara-active-chat-id`)를 호스트에 맞춰 연결.
4. `contract`는 서버·화면 모두 **2**(다르면 칸 화면이 읽기 전용).

## 리비전 이력

| 날짜 | 변경 |
|------|------|
| 2026-11-22 | 최초 작성 — 원작 `bfafb3f`(설정집 칸 패널 v0.7.6) 기준 접점 목록 |
