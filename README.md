# claude-slack

Slack에서 내 맥에 떠 있는 **진짜 Claude Code 터미널 세션**을 조종한다. 스레드 하나가 세션 하나.

- 터미널에서 `claude-slack`으로 세션을 켜면 Slack 채널에 스레드가 생긴다.
- Slack 채널에 새 메시지를 쓰면 tmux 안에 새 세션이 뜨고 그 메시지가 스레드 루트가 된다.
- 브로커를 재시작해도 그 사이 Claude Code가 쓴 답변을 건너뛰지 않는다. 읽은 위치를 기억했다가 이어서 읽는다.
- 스레드 답글 = 프롬프트. 답변은 스트리밍으로, 도구 호출은 작업 카드로, 권한 요청은 버튼(허용 · 항상 허용 · 거부)으로.
- ⚠️ Slack은 `/`로 시작하는 메시지를 슬래시 명령으로 가로채 **전송하지 않는다** (확인됨: "유효한 명령어가 아닙니다" 에러). 스레드에서 `/compact` 같은 Claude Code 명령을 보내려면 `:/compact`처럼 `:`를 앞에 붙인다.
- 스레드에 올린 이미지는 Claude가 읽고, Claude가 만든 이미지·파일은 `reply` 도구의 `files`(절대 경로)로 스레드에 올라온다(앱에 `files:write` 필요).
- 모든 세션은 `--chrome`(Claude in Chrome)을 켠 채로 시작한다. 그 기계의 Chrome에 확장 프로그램이 연결돼 있으면 Slack에서 브라우저 작업을 바로 시킬 수 있다. 끄려면 `CLAUDE_SLACK_NO_CHROME=1`.
- Slack의 네이티브 중단 버튼이 터미널의 Esc가 된다.
- 스레드 루트 메시지가 상태줄이다. 채널 목록에서 열어보지 않아도 모델·effort·권한 모드·컨텍스트 사용량이 보인다.
- 스레드마다 **컨트롤 패널**: 중단 · /clear · /compact · 화면 캡처 · 세션 종료 버튼, 모델·effort 드롭다운, 권한 모드 전환, /context /usage /cost /status 메뉴. 칼럼으로 출력되는 것은 표로 렌더링한다. 상태줄에 현재 모델·effort·권한 모드.
- 할 일 목록(TodoWrite)은 Slack의 `plan` 블록으로 뜨고, 진척에 따라 그 메시지가 갱신된다. 긴 작업에서 어디까지 왔는지 한눈에 보인다. 클라이언트가 블록을 못 그리면 같은 내용을 글자로 보여준다.
- AskUserQuestion 선택지와 플랜 승인이 버튼으로 온다. 터미널 다이얼로그의 번호를 대신 눌러 준다. 프롬프트가 키 입력을 쥐고 있어 당장 못 누르면(메인 턴 중 백그라운드 에이전트의 권한 창) 다시 누르라 하지 않고, 풀리는 순간 브로커가 대신 누른다(최대 60초).
- **도구가 도는 중에 보낸 메시지는 붙잡았다가 도구가 끝나면 전달한다.** Claude Code 터미널이 작업 중 Enter 로 친 메시지를 큐에 두는 것과 같은 규칙이다(바로 넣으면 실행 중인 명령이 `Interrupted` 로 끊긴다). 붙잡는 동안 🕓 반응과 안내 하나가 뜨고, 안내의 **⚡ 지금 보내기**(`:now`)는 터미널의 Ctrl+Enter 처럼 턴을 끊고 즉시 전달, **취소**는 버린다. 주입한 메시지가 5초 안에 턴을 시작하지 않으면 화면을 봐서 입력칸에 남아 있으면 Enter 를, 아니면 한 번 더 보내고, 그래도 안 되면 알린다.
- 터미널이 `Interrupted · What should Claude do instead?` 로 멈춰 있으면 "작업 중" 대신 **지시 대기** 라고 말하고 **▶️ 계속해** 버튼을 준다. 자동 모드 분류기가 도구를 거부하면 누를 창이 없다고 알린다(그 상황에 권한 승인을 요구하던 오진이 있었다).
- **결정이 필요한 순간에는 사람을 `@멘션`** 한다(권한·질문·플랜·정지). 5분 넘게 답이 없으면 스레드에서 한 번 더 부르고, 그래도 없으면 DM. `:notify decisions|on|off` 로 스레드마다 조절. Claude 가 `reply` 도구에 `notify: true` 를 주면 그 메시지도 멘션한다.
- 권한 카드는 Edit 의 diff, Write 의 앞 20줄, Bash 의 전체 명령을 보여 주고, "항상 허용" 을 누르면 어떤 규칙이 기록될지 미리 적는다.
- 작업 중인데 15초 넘게 새 출력이 없으면 터미널 화면을 들여다본다. 아는 확인 창(폴더 신뢰, 모델 전환 등)은 자동으로 넘기고, 모르는 번호 다이얼로그는 그대로 버튼으로 올린다. 90초 넘게 조용하면 무엇이 실행 중인지 한 줄로 알려 주고, 그 메시지 하나를 계속 갱신한다. 도구가 도는 중이 아니면 터미널 화면에서 내용이 있는 줄만 추려 보여 준다.
- 세션을 끝낸 뒤 **🗑 Slack에서 지우기**를 누르면 스레드 전체를 `~/.claude-slack/sessions/<시각>_<id>.json|.md`에 보관하고 봇 메시지를 지운다. `.env`에 사용자 토큰(`SLACK_USER_TOKEN`, 사용자 스코프 `chat:write`)을 넣으면 내가 쓴 메시지도 지운다. `/cchistory`로 보관 목록. 지우기 전에 캔버스로도 남기므로 브로커가 도는 기계에 가지 않아도 Slack에서 읽을 수 있다(앱에 `canvases:write` 필요). 자동 삭제는 없다.
- **앱 홈 탭**: 실행 중인 세션(상태·폴더·모델·스레드 바로가기), 이어서 하기 드롭다운, 새 세션 버튼. 세션이 뜨거나 끝나면 자동으로 갱신된다. 응답이 필요한 세션은 이유와 경과(🟡 권한 대기 3분)와 함께 맨 위에 오고, **관심 필요만** 필터로 그것만 볼 수 있다. 스레드 루트 줄도 같은 이유를 🟠 로 보여 준다.
- 서브에이전트 보고서는 하네스 프레임(`[Subagent hand-back] …`)을 걷어내고 본문만, 잘리지 않게 올린다. "Agent … finished", "Background command … completed (exit code 0)" 같은 정상 완료 알림과 `reply` 뒤의 "sent" 한 마디는 올리지 않는다(실패는 올린다).
- `:view summary|normal|verbose` 로 도구 카드 없이 답변만 보거나 도구 출력을 더 길게 볼 수 있다. `:rename 이름` 으로 세션 제목, `:btw 질문` 으로 대화에 남지 않는 옆길 질문(작업 중에도 가능), `:tell <세션> 메시지` 로 다른 세션에 전달, `:retract` 로 방금 보낸 메시지 철회(원 메시지에 ✖, 턴이 돌고 있으면 끊고 정정 글을 보낸다; `✖ 철회했습니다.` 로 답한다). 이미지가 아닌 첨부(PDF, 로그)도 경로로 넘어간다.
- `:context` 는 그 세션이 지금까지 쓴 비용·모델·200k 토큰 근접 여부를 보여준다. 브로커가 세션마다 띄울 때 넘기는 `--settings` 로 Claude Code의 statusLine을 등록해 두고(사람의 전역 `~/.claude/settings.json`은 건드리지 않는다), 그 명령(`scripts/statusline.ts`)이 매 렌더마다 읽은 값을 `~/.claude-slack/status/`에 남긴다.
- 대화가 커지면(30초마다 확인) 트랜스크립트 50MB에서 한 번 경고하고, 100MB가 넘으면 Slack·웹 입력을 막는다(`:` 명령은 그대로 된다; 터미널 입력은 막을 수 없다). `:lightfork` 는 그 세션에 `SESSION.md`를 써 달라고 요청한 뒤, 그 내용과 원래 대화를 가리키는 `read_session` 포인터로 가벼운 새 세션을 띄운다. 원래 세션은 계속 떠 있지만(터미널은 그대로) Slack·웹은 새 스레드로 안내한다.
- 브로커가 재시작해도 붙잡아 둔 메시지와 열려 있던 권한 카드, 스레드별 설정(알림·보기·이름)은 `live.json` 에 있다가 세션이 다시 붙으면 돌아온다. Slack 호출은 네트워크가 잠깐 끊겨도 세 번까지(최대 13초) 다시 시도한다. 큐가 아니므로 더 오래 끊기면 그 호출은 실패로 남는다.
- **누가 세션을 몰 수 있나**: `SLACK_ALLOWED_USERS` 의 사용자가 쓴 메시지만 받는다. 작성자 기준이라 그 사용자의 토큰으로 API 에서 올린 메시지(자동화, QA)도 같은 권한이다. 사용자 토큰을 다른 도구에 주면 그 도구가 세션을 몰 수 있다는 뜻이다. 어드민 페이지의 세션 시작·종료는 JSON 본문과 같은 출처만 받아 로컬 웹페이지의 CSRF 로는 쓸 수 없다.
- 채널 상단 "🆕 새 세션" 버튼 → 폴더·프롬프트·모델·effort를 고르는 폼. 슬래시 명령은 `/ccnew [경로] [프롬프트]`, `/ccresume [id]`, `/cclist`, `/cchistory`, `/cchelp`. 풀네임 `/claude-code-new` 등도 같은 동작.

## 메시지 체계

브로커가 올리는 메시지의 유형(상태·흐름·결정 카드·진행 안내·확인·시스템·오류)과 아이콘 사전, 각 유형의 멘션·버튼·수명 규칙은 `docs/MESSAGES.md` 에 있다. 문구를 추가하거나 고칠 때 거기에 맞춘다.

## 웹 앱

브로커의 HTTP 서버(`/`)가 Slack 스레드에서 하던 일을 폰·PC 브라우저에서 그대로 한다. 같은 세션을 Slack 과 동시에 보고,
카드의 버튼은 Slack 블록을 그대로 그려 Slack 클릭과 같은 `handleAction` 을 부른다(웹에서 보낸 글은 스레드에 `🌐 웹:` 으로 남는다).

- 연결: SSE(`/api/stream`) 하나로 세션 목록(바뀐 것만)과 보고 있는 스레드의 이벤트만 받는다. 명령은 JSON POST.
  이벤트는 스레드마다 번호(seq)를 붙여 `~/.claude-slack/events/<스레드>.jsonl` 에 쌓고, 끊겼다 붙으면 `after=seq` 로 빠진 것만 받는다.
- 그림: `~/.claude-slack/web-images/` 에 옮겨 둔 것만 내보낸다. 150KB 넘으면 폭 1280 이하 WebP(cwebp, 없으면 sips JPEG).
- 브라우저 저장: IndexedDB `claude-slack-web`(timeline·images), localStorage(쓰던 글·목록 캐시·테마 등).
- 브로커 파일: `~/.claude-slack/groups.json`(그룹·순서), `~/.claude-slack/default-prompt.txt`(모든 세션에 `--append-system-prompt`).
- 측정: 브로커 로그에 1분마다 `web sent 1m …`(보낸 양)과 `page …`(페이지가 받은 양·반영 시간·멈춤·DOM 수).
  `node scripts/measure-web.ts [분]` 이 실제 브로커에 읽기 전용 페이지를 붙여 그 줄들을 모은다.
- 확인: `node scripts/qa-web.ts` 가 가짜 API 로 PC(1440×820)·폰(390×844)에서 눌러 본다.

이전 관리 화면은 `/admin` 에 남아 있다(잔재 스레드 정리 등).

## 어드민 페이지 (`/admin`)

브로커가 도는 기계에서 `http://127.0.0.1:4180` 을 열면 실행 중인 세션, 이어서 할 세션,
보관된 기록을 한 화면에서 본다. 세션 종료와 스레드 정리도 여기서 된다. 4초마다 갱신된다.

탭은 전체 / 실행 중 / 이어서 / 보관 / 잔재(세션과 끊긴 Slack 스레드)이고, 이름·폴더·첫 메시지로 검색한다.
행마다 주고받은 대화 수(💬)와 첫 메시지가 보이고, 앞에 대표 버튼 하나, 나머지는 ⋯ 메뉴에 있다
(스레드 열기 · 화면 · 기록 보기 · 이어서 하기 · 이름 변경 · 상단에 고정 · 세션 종료 · 삭제). 못 하는 동작은 이유와 함께 흐리게 보인다.
"스레드 열기"는 그 스레드의 마지막 메시지로 곧바로 간다 — 메시지가 오갈 때마다 `~/.claude-slack/thread-links.json` 에 기록해 두기 때문이다.
"기록 보기"는 Slack 처럼 대화를 옆 패널로 연다(폰에서는 전체 화면, 뒤로가기로 닫힘). 고정은 `~/.claude-slack/pins.json` 에 저장되어 기기끼리 같다.

화면을 고친 뒤에는 `node scripts/qa-admin.ts` 로 확인한다. 가짜 API 로 모든 버튼을 데스크톱·폰 크기의 Chromium 에서 눌러 보며
실제 브로커 상태는 건드리지 않는다.

기본은 그 기계에서만 열린다. 휴대폰 등 다른 기기에서 보려면 `.env` 에
`CLAUDE_SLACK_WEB_HOST=0.0.0.0` 과 `CLAUDE_SLACK_WEB_TOKEN=<임의 문자열>` 을 넣고
`http://<브로커 주소>:4180/?t=<토큰>` 으로 연다. 토큰 없이 루프백·Tailscale 대역(`100.64.0.0/10`) 밖으로 열려고 하면
브로커가 거부한다 — 세션 종료와 스레드 삭제가 되는 화면이라 그렇다. `CLAUDE_SLACK_WEB=0` 이면 끈다.

PC 화면의 QR 로 들어오는 폰은 토큰을 주소에 받지 않는다 — 5분짜리 일회용 코드로 `/login` 을 연 뒤, 토큰 대신 무작위 id 를 담은 `HttpOnly` 쿠키(30일) 를 받고 `/` 로 간다(스크린샷·브라우저 기록에 토큰이 남지 않는다). 스크립트(`doctor.ts`, curl)는 그대로 헤더나 `?t=` 로 토큰을 쓴다. 틀린 토큰은 같은 발신 주소에서 1분에 10번을 넘으면 그 뒤 1분간 토큰을 보지도 않고 거절한다(429).

`CLAUDE_SLACK_*` env 는 기동할 때 한곳(`src/config.ts`)에서 검증한다 — 모르는 키(오타)나 숫자가 아닌 포트값이 있으면 무슨 키가 문제인지 알려주며 뜨지 않는다.

## 스레드 명령

스레드 밖 슬래시 명령은 세션과 무관한 일(새 세션, 재개, 목록)만 한다. 스레드 안은 그 세션에 대한 것만.

- Claude Code 문법은 그대로: `/compact`, `/model opus`, `/review` 같은 `/` 명령과 `!npm test` 같은 `!` bash 모드는 터미널에 그대로 들어간다. 내장 명령과 사용자 스킬을 구분하지 않는다. 단, Slack이 `/`로 시작하는 메시지를 가로채 전송을 막으므로 `:/compact`처럼 `:/명령`으로 보낸다.
- 세션 제어는 `:` 접두어: `:esc` 중단(멈췄는지 확인해서 답한다) · `:now` 붙잡은 메시지 지금 보내기 · `:screen` 화면(장식을 걷어낸 요약, `:screen raw` 는 그대로) · `:status` 모델·effort·권한 모드 한 줄 · `:answer 2` 번호 다이얼로그 응답 · `:key Down Enter` 키 입력 · `:type 텍스트` 타이핑 · `:canvas` 스레드 기록을 캔버스로 · `:refresh` 세션 다시 열기(대화 유지, 새로 설치한 스킬·플러그인·MCP 반영) · `:kill` Slack에서 띄운 세션 종료 · `:notify` · `:view` · `:rename` · `:btw` · `:tell` · `:retract` · `:context` · `:help`
- 권한 응답: `yes abcde` / `no abcde`
- 없어진 것: `!mode` `!model` `!effort` `!clear` `!compact` `!exit`. 같은 이름의 Claude Code 명령을 그대로 보낸다. 스레드 삭제는 종료된 패널의 🗑 버튼.

## 구조

```
Slack ⇄ src/index.ts (브로커, 1개, Socket Mode)
           ⇅ unix socket (~/.claude-slack.sock)
   ┌───────┴────────┐
   │ src/channel.ts │  세션마다 하나. Claude Code가 MCP 채널 서버로 띄움.
   │ hooks/notify.ts│  Claude Code 훅 → 브로커에 이벤트 전달.
   └────────────────┘
   tmux (Slack에서 띄운 세션, 키 입력·화면 캡처)
```

- **입력·권한**: Claude Code 공식 Channels (`--dangerously-load-development-channels server:slack`)
- **출력·진행**: 훅 + 대화 기록 파일 실시간 읽기 → Slack 스트리밍 API / task_update
- **터미널 조작**: tmux `send-keys` / `capture-pane`

## 설치

```sh
npm install
cp .env.example .env        # Slack 토큰, 채널 ID, 허용 유저 ID
npm run install-hooks       # ~/.claude/settings.json 에 훅 등록 + mcp.json 생성
npm start                   # 브로커 (계속 켜 둠)
bin/claude-slack            # Slack에 연결된 터미널 세션
```

Slack 앱은 `slack-manifest.json`을 https://api.slack.com/apps 에서 "From a manifest"로 붙여 넣어 만든다. 매니페스트가 바뀌면(예: `/cc` 슬래시 명령 추가) 앱 설정 → App Manifest에 다시 붙여 넣고, 스코프가 늘었으면 Install App → Reinstall.

### 계속 켜 두기 (재부팅·크래시 복구)

`npm start`를 손으로 띄우면 재부팅과 함께 사라진다. launchd에 맡기면 로그인 시 자동으로 뜨고 죽어도 다시 뜬다. `scripts/broker-daemon.sh`가 브로커를 tmux 세션 안에서 돌리므로 `tmux attach -t claude-slack-broker`로 화면을 보는 건 그대로 된다. 상태가 이상하면(응답이 없다, 세션이 중복된다) `node scripts/doctor.ts` 로 먼저 진단한다 — 브로커 pid·소켓 응답·tmux 창 수·같은 실행 키의 중복 Claude 프로세스·최근 WARN/ERROR 를 한 번에 보여주고, 다음에 칠 명령을 알려준다. `node scripts/doctor.ts restart` 가 launchd 경로로 재시작하고(`npm start`를 손으로 치는 대신), `dedupe`가 중복 프로세스를 정리한다.

launchd가 띄운 실행(`CLAUDE_SLACK_DAEMON=1`)에서는 관리자 페이지의 "⏳ 쉬면 재시작" 버튼으로 당장 끊지 않고 안전하게 재시작을 예약할 수 있다 — 모든 세션이 연속 두 번 쉬고 있는 것으로 확인되면 상태를 저장하고 꺼지며, launchd의 `KeepAlive`가 바로 다시 띄운다. 바쁜 세션이 있으면 어느 세션(폴더 이름)을 기다리는지 보여준다. `CLAUDE_SLACK_DAEMON` 없이 손으로 띈 실행에서는 "데몬이 관리하는 실행이 아니라서 예약할 수 없습니다"로 거절한다(꺼진 채로 남기 때문).

`~/Library/LaunchAgents/com.claude-slack.plist`에 `Label`·`ProgramArguments`(이 저장소의 `scripts/broker-daemon.sh` 절대 경로)·`WorkingDirectory`·`RunAtLoad`·`KeepAlive`를 넣고, `PATH`에 `tmux`와 `node`가 있는 디렉터리(homebrew면 `/opt/homebrew/bin`)를 준다. 그다음:

```sh
launchctl load -w ~/Library/LaunchAgents/com.claude-slack.plist   # 등록 + 시작
launchctl list | grep claude-slack                                # 떠 있는지
tmux attach -t claude-slack-broker                                # 화면 보기
launchctl unload -w ~/Library/LaunchAgents/com.claude-slack.plist # 내리기
```

LaunchAgent는 로그인해야 뜨므로, 사람이 없는 기계라면 자동 로그인을 켜 둬야 재부팅만으로 복귀한다.

### 로그: 무슨 일이 있었는지 되짚기

`~/.claude-slack/logs/` 에 두 파일이 남는다. 둘 다 로컬 시각, 5MB 넘으면 `.1` 로 돌린다(실행 중에도).

- `broker.log` — 브로커가 한 일 전부. 한 줄 형식 `날짜 시각 [레벨] [영역] 메시지 key=value …`. 세션이 관련된 줄에는 항상 `t=<스레드 ts> s=<세션 id 앞 8자> p=<프로젝트>` 가 붙어 `grep t=1790052852` 로 한 스레드의 이야기를 뽑을 수 있다. 영역: `slack`(수신 메시지·버튼) `inject`(전달·보류·지금 보내기·확인) `hook` `perm`(권한 요청·응답·리마인더) `dialog`(판정·누른 키·재시도) `stall`(정지 상태) `esc` `stream` `session` `revive` `slack-sdk`. `PostToolUse` 는 DEBUG 라 기본에서 빠진다(`CLAUDE_SLACK_LOG_LEVEL=DEBUG`).
- `hook.log` — 훅이 브로커에 닿았는지. 못 닿았으면 왜(브로커 없음·타임아웃·잘못된 페이로드). `CLAUDE_SLACK_HOOK_LOG=0` 으로 끌 수 있다.

```sh
npm run logs                                  # broker.log 끝 50줄
npm run logs -- -n 200 --thread 1790052852.118929   # 한 스레드만
npm run logs -- --level WARN                  # 경고 이상
npm run logs -- --hook --follow               # hook.log 를 tail -F
```

어드민 페이지의 세션 카드마다 **로그** 버튼이 그 스레드의 최근 80줄을 연다. 원인을 좁히는 순서: `hook.log` 에 그 시각 줄이 있나(훅이 돌았나) → `broker.log` 에 `[slack] thread reply` 가 있나(메시지가 왔나) → `[inject] delivered` 인가 `held` 인가(전달됐나, 붙잡혔나) → `[hook] UserPromptSubmit` 이 따라오나(세션이 받았나).

돌던 Claude Code 세션은 재부팅을 넘지 못하지만 대화는 디스크에 남는다. 브로커는 살아 있는 세션을 `~/.claude-slack/live.json`에 적어 두었다가, 다음에 뜰 때 **원래 스레드에 `--resume`으로 다시 연다.** 새 스레드를 파지 않으므로 하던 자리에서 이어진다.

- 브로커만 재시작한 경우에는 세션들이 스스로 다시 붙으므로 아무것도 되살리지 않는다. 15초 기다린 뒤 그때까지도 비어 있는 스레드만 되살린다.
- 정상 종료한 세션은 기록에서 지우므로 되살아나지 않는다.
- 12시간보다 오래된 기록은 건너뛰고, 한 번에 최대 5개까지만 되살린다(최근 것부터).

`/model`·`/effort` 변경은 터미널과 똑같이 새 세션 기본값으로도 저장된다.

## Slack 앱 셋업을 Claude에게 맡기기

Chrome이 Slack에 로그인된 컴퓨터에서, [Claude in Chrome](https://chromewebstore.google.com/detail/claude/fcoeoabgfenejglbffodgkkbkcdhcgfn) 확장을 설치한 뒤:

```sh
scripts/setup-with-chrome.sh
```

`docs/SETUP-PROMPT.md`의 프롬프트로 앱 생성 → 토큰 발급 → 채널 초대 → `.env` 기록 → 훅 설치 → 브로커 기동 → 실제 메시지로 검증까지 진행한다.

## 상태

설계 단계의 초안. 자세한 계획은 `docs/PLAN.md`.
