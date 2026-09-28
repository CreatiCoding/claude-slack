# TODO

기준: 2026-09-23. 위쪽 "사용성 개선" 절이 이번에 새로 정리한 것이고, 그 아래는 2026-09-12 기준 목록을 그대로 두었다.

근거 두 가지:
1. claude-controller 스레드(2026-09-22 13:54 ~ 23 08:33)에서 사용자가 실제로 겪은 일. 오후 3시~5시 사이 두 시간을
   브릿지 문제로 잃었다.
2. Claude Code 데스크톱 앱 · Remote Control · Channels 공식 문서와 비교해 우리에게 없는 것.
   - [Desktop](https://code.claude.com/docs/en/desktop) · [Remote Control](https://code.claude.com/docs/en/remote-control)
   - [Interactive mode: Queue messages while Claude works](https://code.claude.com/docs/en/interactive-mode)
   - [Channels reference](https://code.claude.com/docs/en/channels-reference)

---

## 사용성 개선 (2026-09-23) — 구현 완료, 실사용 검증 대기

아래 항목은 2026-09-23 에 코드·테스트(`test/usability.test.ts` 40개)까지 넣고 브로커를 재시작했다. 아래 2026-09-12 목록의 코드 항목도 같은 날 정리했다(각 항목에 결과 표기).
남은 것은 **실제 스레드에서 하루 써 보고** `npm run logs -- --thread <ts>` 로 되짚어 보는 일이다. 특히 확인할 것:
- 도구 실행 중 보낸 메시지가 정말 끊지 않고 붙잡히는지, 지금 보내기가 끊고 들어가는지.
- Claude Code 가 채널 메시지를 자체 큐에 두는 경우 주입 확인(5초)이 헛경고를 내지 않는지.
- `hourglass_flowing_sand` 반응 이름이 이 워크스페이스에 있는지(없으면 `invalid_name` 으로 조용히 넘어간다).
- 리마인더 DM 이 봇 DM 으로 오는지(`chat.postMessage` 에 user id).


우선순위 순. P0 는 사용자가 직접 겪고 화를 낸 것, P1 은 데스크톱/Remote Control 이 이미 해결한 것 중 우리에게 없는 것,
P2 는 있으면 좋은 것.

### P0-1. 작업 중 보낸 메시지가 실행 중인 명령을 끊는다

**겪은 일**: 도구가 도는 중에 "결과 나오면 바로 공유해" 를 보내자 그 명령이 `Interrupted · What should Claude do instead?`
로 끊겼다. 세 번 반복됐고, Claude 는 이걸 권한 거부로 오진해 허용 스크립트까지 실행시켰다.
Claude Code 자체는 터미널에서 Enter 로 친 메시지를 **큐에 넣고 도구 호출이 끝나는 시점에 같은 턴 안에서 전달**한다
(interactive-mode 문서). 채널 알림도 문서상으로는 "다음 턴에 묶어서 전달" 이지만 실제(2.1.276)로는 끊긴다.

**할 것**:
- [x] `inject()` 에서 `session.turn?.inFlight.length > 0` 이면 채널로 보내지 않고 `session.held` 에 담는다.
      세션 준비 중 `pending.queued` 와 같은 구조. 메시지에 🕓 반응을 달아 "대기 중" 임을 보인다.
- [x] `PostToolUse` 훅(도구가 끝난 시점)과 `Stop` 훅에서 `held` 를 순서대로 흘려보낸다. Claude Code 의 큐 규칙과 동일.
      전달되면 🕓 → 👀 로 반응을 바꾼다.
- [x] `:` `/` `!` 명령은 붙잡지 않는다. `:esc` 는 지금처럼 즉시.

### P0-2. "지금 보내기": 붙잡힌 메시지를 즉시 밀어 넣기

Claude Code 는 `Ctrl+Enter`(어느 터미널이든 `Ctrl+X Ctrl+S`, `chat:sendNow`) 로 "턴을 끊고 큐를 지금 보낸다" 를 지원한다.
사용자가 원한 것도 이것이다: 메시지를 바로 못 읽었을 때 사용자가 고를 수 있어야 한다.

**할 것**:
- [x] 메시지를 붙잡을 때 스레드에 짧은 안내를 하나 올린다: `🕓 도구 실행이 끝나면 전달합니다 · [지금 보내기] [취소]`.
      메시지가 더 쌓이면 같은 안내를 갱신한다(새 메시지 X).
- [x] **지금 보내기** = tmux 로 `Escape` 를 보내 턴을 끊은 뒤 `held` 를 즉시 채널로 전달. Claude Code 의 `Esc` 규칙
      ("큐는 유지하고 바로 보낸다") 과 같은 결과.
- [x] **취소** = 그 메시지를 버리고 반응을 ❌ 로. Claude Code 의 `Up`(take back) 에 해당.
- [x] 안내 메시지는 전달이 끝나면 지운다(또는 "전달됨" 한 줄로 갱신).

### P0-3. 주입한 메시지가 실제로 시작됐는지 확인한다

**겪은 일**: 화면 캡처마다 입력칸에 `❯ 결과 나오면 바로 공유해` 가 그대로 있었다. 몇 시간 동안 전송되지 않았는데
브로커는 모르고 있었다.

**할 것**:
- [x] `inject()` 후 N초(5초) 안에 transcript 에 그 텍스트의 user 턴이 생기는지 본다(`UserPromptSubmit` 훅으로 충분).
- [x] 안 생겼으면 화면을 캡처해 입력칸에 그 텍스트가 남아 있으면 `Enter` 를 한 번 보낸다. 그래도 안 되면
      "전달 실패, 다시 보냅니다" 를 올리고 재주입한다. 그래도 안 되면 사용자에게 알린다.

### P0-4. 멈춤 알림이 원인을 말하게 한다

**겪은 일**: "37분째 새 출력이 없습니다" + 터미널 화면 원문. 화면에는 `Interrupted · What should Claude do instead?` 가
떠 있었다. 브로커가 이 문구를 알았으면 두 시간이 1분이었다.

**할 것**:
- [x] `parseDialog` 옆에 "알려진 정지 상태" 표를 둔다. 문구 → 상태 → 사용자 문장 → 버튼:
      - `Interrupted · What should Claude do instead?` → **대기: 지시를 기다림** → `[계속해] [화면]`. 계속해 = "계속해" 주입.
      - `Permission for this action was denied by the Claude Code auto mode classifier` (transcript 에 남음) →
        **자동 모드가 거부** → 이유(`[Self-Modification]` 등) 와 함께 "수동으로 하려면 터미널에서 권한 모드를 바꾸세요".
      - `new task? /clear to save …` 만 있고 입력칸이 비어 있음 → **유휴** (상태를 idle 로 되돌린다).
      - 권한 다이얼로그 → 이미 버튼으로 처리 중.
- [x] 멈춤 알림에 화면 원문 대신 그 상태 문장을 먼저 쓰고, 화면은 `:screen` 으로 미룬다. 모바일에서 diff 원문은 못 읽는다.
- [x] 상태줄(루트 메시지)도 같은 상태로 갱신해 채널 목록에서 🟠 "지시 대기" 가 보이게 한다.

### P0-5. 허용 버튼이 안 눌렸을 때 브로커가 대신 기다린다

**겪은 일**: 스크린샷을 보내고 허용을 누르니 "터미널 확인 창은 아직 그대로입니다. 응답이 끝난 뒤 다시 눌러 주세요" 만 왔다.
사용자는 "왜이러는거야 괴로워" 로 답했다. 기존 TODO 의 `promptHoldsFocus` 항목.

**할 것**:
- [x] `promptHoldsFocus` 면 사용자에게 다시 누르라고 하지 말고 브로커가 `pendingDialogAnswers` 에 담아 두고,
      500ms 간격으로 최대 60초 화면을 다시 봐서 입력칸이 사라지는 순간 자동으로 누른다.
- [x] 안내 문구는 "⏳ 응답이 끝나면 자동으로 누릅니다" 로. 60초 안에 못 누르면 그때 "다시 눌러 주세요".
- [x] 입력칸 포커스를 다이얼로그로 옮기는 키는 찾지 않기로 했다. Claude Code 가 그런 키를 문서화하지 않고, 풀릴 때까지 기다렸다 누르는 방식이 60초 안에 같은 결과를 내므로 굳이 키를 추측해 프롬프트에 흘릴 위험을 지지 않는다.

### P0-6. 잡음 줄이기

**겪은 일**: 모바일 스레드에 `sent` 한 단어 메시지, `[Subagent hand-back] … The harness indents every line …` 하네스
프레임 원문, `Agent "…" finished`, `Background command "…" completed` 가 섞여 읽기 어렵다. 서브에이전트 보고서는
`…` 로 잘린다. 로그를 보니 `msg_too_long` 으로 스트림이 끊긴 게 424회, `invalid_blocks` 폴백이 1,274회다.

**할 것**:
- [x] `sent`: reply 도구가 `'sent'` 를 돌려주니 Claude 가 그대로 말한다. 도구 결과를 빈 문자열 또는
      `(delivered; do not repeat this)` 로 바꾸고 instructions 에 "reply 결과를 말로 옮기지 말라" 를 넣는다.
- [x] transcript 미러링에서 `<agent-message …>` / `[Subagent hand-back]` / `[harness: …]` 프레임을 걷어내고
      본문만 "🤖 서브에이전트 보고" 접힌 블록으로 올린다. 서브에이전트 구분은 이미 있으니 그 옆에 붙인다.
- [x] `Agent … finished`, `Background command … completed (exit code 0)` 는 올리지 않는다(카드 갱신이 아니라 억제. 완료는 Claude 의 다음 행동으로 보이고, 실패는 그대로 올린다).
- [x] `msg_too_long`: 한 메시지가 한도를 넘으면 자르지 말고 다음 메시지로 이어 쓴다. 지금은 `STREAM_TEXT_MAX=11000`
      로 스트림을 재시작하지만 최종 답변 미러링(`finishTurn`)이 긴 경우가 걸린다. 4,000자 단위로 나눠 올린다.
- [x] `invalid_blocks` 1,274회: `Block type is not supported in this container [/blocks/0]`. 어느 표면에서 어떤 블록
      (`plan`? `task_card`? `table`?)이 거부되는지 로그에 블록 타입과 표면을 남겨 원인을 잡고, 안 되는 표면에서는
      처음부터 폴백 블록을 쓴다. 지금은 매번 API 호출 두 번(거부 → 폴백)이 나가 append 예산을 먹는다.

### P0-7. `:esc` 에 결과를 알려 준다

**겪은 일**: `:esc` 세 번, 답은 "Esc 전송" 세 번. 실제로 멈췄는지 알 수 없었다.

**할 것**:
- [x] Esc 를 보낸 뒤 1초 안에 화면을 캡처해 `Interrupted` 가 떴는지, 도구가 끝났는지 확인하고
      "⏹ 멈췄습니다 · 지시를 기다립니다" 또는 "⏹ 이미 유휴 상태였습니다" 로 답한다.
- [x] Slack 네이티브 중단 버튼(`handleStop`)도 같은 확인 경로를 탄다.

### P1-1. 로그를 분석 가능한 형태로 (사용자 요청)

**현재 상태** (`~/.claude-slack/broker.log`, 12,742줄 · 1MB):
- **타임스탬프가 한 줄도 없다.** Slack 메시지 ts 와 대조가 불가능하다. 어제 사건을 로그로 재구성할 수 없었다.
- 7,125줄(56%)이 `hook PostToolUse for session <uuid>`. 도구 이름도, 스레드도 없다. 정보량 0.
- 레벨이 없다. Slack SDK 의 `[ERROR] web-api:WebClient` 줄만 레벨이 있다.
- 세션은 36자 uuid 로만 나오고 스레드 ts 나 프로젝트 이름이 없어 "이 스레드에 무슨 일이 있었나" 를 grep 할 수 없다.
- **사건 경로가 안 남는다**: Slack 메시지 수신 → 주입, 멈춤 알림 게시, Esc 전송, 버튼 클릭, 다이얼로그 판정 결과,
  transcript 미러링 실패. 어제 오후의 "메시지가 명령을 끊었다" 는 로그에 흔적이 없다.
- 로테이션은 `broker-daemon.sh` 가 **시작할 때만** 10MB 를 검사한다. launchd 로 계속 떠 있으면 무한히 자란다.
- 훅 로그는 `CLAUDE_SLACK_HOOK_LOG` 를 설정해야만 남고 기본은 꺼져 있다. README 에도 없다.
- `launchd.log` / `launchd.err` 는 tee 때문에 항상 0바이트라 헷갈린다.

**할 것**:
- [x] `src/log.ts`: `HH:MM:SS.mmm [LEVEL] [영역] 메시지 key=value …` 한 줄 형식. 영역은 `slack` `hook` `inject` `dialog`
      `stream` `tmux` `stall` `perm` `revive`. 로컬 시각(claude-controller 와 같은 규칙).
- [x] 세션 식별은 `t=<threadTs> s=<uuid앞8> p=<basename cwd>` 세 값을 항상 붙인다. `grep t=1790052852` 로 한 스레드를 뽑을 수 있게.
- [x] 훅 수신 줄은 `PostToolUse` 를 DEBUG 로 내리고, 남길 때는 도구 이름과 소요 시간을 함께.
      `PreToolUse` 는 `tool=Bash cmd="…80자"` 로.
- [x] 반드시 남길 사건: Slack 메시지 수신(ts, 길이, 분류: 명령/권한응답/주입/보류), 주입 결과(즉시/보류/지금 보내기/전달 확인
      여부와 지연), 멈춤 알림(경과, 판정한 상태), Esc 와 그 결과, 버튼 클릭(action_id, requestId, 결과), 다이얼로그 판정
      (문구 → 어떤 규칙에 걸렸나 → 누른 키), 자동 확인, transcript tail 시작/끝/오류, Slack API 실패(메서드, 오류, 재시도).
- [x] 로테이션을 브로커 안에서: 5MB 넘으면 `.1` 로, 실행 중에도. `broker-daemon.sh` 의 시작 시 검사는 남겨도 된다.
- [x] 훅 로그를 기본으로 켠다: `~/.claude-slack/hook.log`. 훅이 브로커에 못 붙었을 때(소켓 없음, 타임아웃)의 사유를 남긴다.
      지금은 그 경우가 조용히 사라진다.
- [x] `claude-slack logs [-n 200] [--follow] [--thread <ts>]` 명령. 어드민 페이지에 세션별 최근 로그 20줄.
- [x] `launchd.log/.err` 를 없애거나 실제로 쓰게 한다.
- [x] Slack SDK 로그(`[WARN] bolt-app`, `[ERROR] web-api`) 를 같은 형식으로 감싸거나 레벨을 WARN 이상으로 제한한다.
      지금 `blocks rejected` 한 건당 두 줄이 나간다.

### P1-2. 알림: 결정이 필요할 때 사람을 부른다

Desktop 은 "보고 있지 않은 세션이 끝나거나 승인이 필요하면 OS 알림", Remote Control 은 "Claude 가 판단해 긴 작업이
끝나거나 결정이 필요할 때 푸시". 우리는 스레드 답글만 올린다. 스레드를 열어 두지 않으면 모바일에선 조용하다.

**할 것**:
- [x] 권한 요청, AskUserQuestion, 플랜 승인, 정지 상태(P0-4) 처럼 **사람이 필요한 순간**에는 메시지에 `<@user>` 를 넣어
      모바일 푸시가 오게 한다. 지금 권한 카드에는 멘션이 없다.
- [x] 5분 넘게 응답이 없으면 한 번 더 부른다(같은 메시지 갱신, 새 메시지 X). 그래도 없으면 DM.
- [x] reply 도구에 `notify: true` 옵션. Remote Control 의 "notify me when the tests finish" 에 해당.
- [x] 스레드마다 `:notify off|on|decisions-only` 로 조절.

### P1-3. 권한 카드에 diff 를 보여 준다

Desktop 의 Manual 모드는 "diff 를 보고 승인", Remote Control 도 파일 변경을 보여 준다. 우리 권한 카드는 `input_preview`
한 줄이다. Edit/Write 는 무엇을 바꾸는지 모른 채 누른다.

**할 것**:
- [x] `PreToolUse` 훅의 `tool_input` 으로 Edit 는 `old_string → new_string` 을 ```diff``` 로, Write 는 처음 20줄을,
      Bash 는 전체 명령을 코드 블록으로 카드에 넣는다. 길면 접힌 블록.
- [x] "항상 허용" 을 누를 때 어떤 규칙이 기록되는지(`Bash(git push *)`) 카드에 미리 보여 준다.

### P1-4. 세션 상태를 한눈에: 상태줄과 홈 탭에 "관심 필요" 표시

Desktop 사이드바는 상태 배지·상태별 필터·프로젝트별 그룹이 있고, Dispatch 세션은 배지가 붙는다.

**할 것**:
- [x] 상태를 `idle / busy / waiting(사람 필요) / ended` 에 더해 `waiting` 의 이유(권한 · 질문 · 플랜 · 지시 대기 · 다이얼로그)
      를 루트 메시지 상태줄에 쓴다. 🟠 옆에 "권한 대기 3분".
- [x] 홈 탭에서 `waiting` 세션을 맨 위로, 경과 시간과 함께. "모두 보기 / 관심 필요만" 필터.
- [x] 세션 이름: Desktop 의 `/rename` 처럼 `:rename 이름` 으로 루트 메시지 제목을 바꿀 수 있게. 지금은 폴더 basename.

### P1-5. 재연결·재시작 때 잃지 않기

Remote Control 은 연결이 끊긴 동안 "메시지, 권한 프롬프트, 서브에이전트 상태" 를 큐에 두었다가 복구 후 전달한다.
우리는 브로커 재시작 뒤 세션은 되살리지만(`revive.ts`), 재시작 순간 열려 있던 권한 요청과 붙잡힌 메시지는 사라진다.

**할 것**:
- [x] `held`(P0-1) 와 미해결 `permission_request` 를 `~/.claude-slack/live.json` 에 함께 저장하고 revive 때 다시 올린다.
- [x] Slack 게시가 네트워크 오류로 실패하면 1·3·9초 뒤 세 번 다시 시도한다(큐가 아니라 재시도. 13초 넘게 끊기면 그 호출은 실패).
- [x] 비정상 종료 시 5초분 offsets 유실(기존 TODO) 도 여기 묶어 처리: 읽은 직후 저장.

### P2-1. `:btw` 옆길 질문

Desktop 의 side chat(`Cmd+;` / `/btw`): 메인 대화에 안 남기고 지금까지의 맥락으로 질문에 답한다. Claude Code CLI 에도
`/btw` 가 있다. Slack 에서 `:/btw 그 설정 파일 이름이 뭐였지` 로 보내면 되지만, 답이 어디로 오는지(transcript 에 안
남으므로 미러링이 안 될 수 있음) 확인이 필요하다.

- [x] `:btw` 를 화면 캡처로 답을 읽어 올리는 명령으로 만들었다. (`:/btw` 가 transcript 에 남는지는 실기기에서 미확인)

### P2-2. 보기 모드

Desktop 은 Normal / Thinking / Verbose. 모바일에서는 도구 카드가 답변을 가린다.

- [x] `:view summary|normal|verbose`. summary 는 도구 카드 없이 답변과 결정 요청만, verbose 는 지금처럼 전부.
      스레드별로 기억(`live.json`).

### P2-3. 세션 간 메시지

Desktop 은 "payments 세션에 스키마 바뀌었다고 알려 줘" 를 지원한다. 우리는 스레드 밖 세션 제어를 의도적으로 뺐다.

- [x] `:tell <스레드 링크|세션 id 앞 8자> 메시지` 정도만. 보내는 쪽 세션 이름을 인용해 붙인다. 낮은 우선순위.

### P2-4. 첨부 파일 이름

Remote Control 은 사진은 그대로, 다른 파일은 내려받아 `@` 참조로 넘긴다. 우리는 모든 파일을 `[Image attached: …]` 로
넘긴다. PDF/로그도 그렇게 표시된다.

- [x] mimetype 이 image/* 가 아니면 `[File attached: …]` 로. 텍스트 파일은 경로 대신 내용을 넣을지 판단.

### 2026-09-23 서브에이전트 리뷰 반영
- 항상 허용 재시도 성공 시 재귀 호출로 두 번 누르던 것 제거. 재시도 슬롯을 다이얼로그마다 하나로.
- 어드민 POST 는 JSON 본문 + 같은 출처만(CSRF). 주입 전 transcript drain, 도구 없이 생각 중인 구간도 붙잡기, 복원된 메시지도 보류 경로.
- 지금 보내기·`:esc` 뒤 늦게 오는 옛 턴의 Stop 무시. 세션별 권한 필터, 턴 시작 시 대기 해제, Stop 유실 시 유휴 복귀.
- 옛 `this.log` 30곳을 태그 형식으로. 질문·플랜·정지 대기에도 리마인더, DM 지연 설정화(테스트 가능).
- 남긴 것: `unsupportedBlocks` 는 메모리(재시작마다 한 번 거부당함. 비용 1회라 둔다), `:btw` 의 화면 스크래핑(Claude Code 가 /btw 답을 transcript 에 안 남긴다).

### 검증 방법

- P0-1/2/3 은 `test/broker.test.ts` 에 "도구 실행 중 메시지 → held → PostToolUse 후 전달", "지금 보내기 → Esc + 즉시 전달",
  "주입 후 UserPromptSubmit 없음 → Enter 재전송" 케이스로. `inFlight` 는 훅으로 만들 수 있다.
- P0-4/5/7 은 `test/dialog.test.ts` 에 화면 픽스처(Interrupted, classifier 거부, 포커스 잡힌 입력칸)를 추가.
- P1-1 은 로그 한 줄 형식과 로테이션만 단위 테스트. 나머지는 하루 돌린 뒤 `grep t=<ts>` 로 한 스레드를 재구성해 본다.
- 브로커를 재시작해야 적용되므로, 재시작은 세션이 없는 시각에 하고 revive 가 스레드를 되찾는지 확인한다.

---

## 내가 해야 할 것 (코드로 끝낼 수 없음)

### 1. ~~Slack 앱에 `canvases:write` · `files:write` 추가하고 재설치~~ (완료 2026-09-18)

Slack CLI 로 처리했다. 브라우저 로그인 없이 된다 (`slack app link` → `slack manifest` 로 스코프 갱신).
재설치해도 봇 토큰은 그대로였고, `canvases.create`/`filesUploadV2` 둘 다 실제 호출로 확인했다.

### 2. 실기기에서 슬래시 커맨드 실행 확인

자동완성 등록은 확인했지만 실제 실행은 아직 해보지 않았다. 슬래시 명령은 API 로 흉내 낼 수 없어 사람이 Slack 에서 쳐 봐야 한다(2026-09-23 에도 그대로 남김).

- [x] `/ccnew` 폼으로 세션이 뜨는지 — 2026-09-23 확인(인자 없이 치면 모달, 폴더·프롬프트 채워 시작까지)
- [x] `/ccresume` 목록이 뜨는지 — 2026-09-23 확인(드롭다운 렌더)
- [x] `/cclist`, `/cchistory`, `/cchelp` — 2026-09-23 전부 확인
      주의: Slack 에서 슬래시 명령은 Enter 두 번이다(첫 번째는 자동완성 선택).
- [x] 앱 홈 탭을 열어 실행 중 세션과 "이어서 하기" 가 보이는지 — 2026-09-23 확인
- [x] (2026-09-23 추가) manual 권한 모드에서 권한 카드 실물 확인 — 허용·거부·항상 허용(항목 없어 1회로 강등)·diff·규칙 미리보기·멘션·포커스 재시도 모두 확인. 여기서 diff 버그를 찾았다.

문제가 있으면 `/tmp/claude-slack-broker.log` 와 `tmux attach -t '=claude-slack'` 을 함께 본다.

### 3. 정기적으로 돌릴 것

- [ ] Claude Code 버전이 오르면 `node --env-file=.env scripts/qa-sweep.ts` 한 번.
      다이얼로그 문구가 바뀌어도 "멈춘 세션" 은 이 스윕이 잡는다. 자세한 건 `docs/QA.md`.
      2026-09-23 에 한 번 돌렸다. 격리해서 돌리려면
      `CLAUDE_SLACK_SOCKET=/tmp/cs-qa.sock CLAUDE_SLACK_TMUX_SESSION=cs-qa` 를 붙인다 — 안 붙이면 라이브 브로커의 소켓을 가로챈다.

---

## 나중에 할 것 (코드, 지금은 미룸)

각 항목에 왜 지금 안 했는지 적었다. 급한 것은 없다.

### 동작

- [x] 백그라운드 서브에이전트의 권한 창이 메인 턴 도중에 뜨면 키 입력이 입력칸으로 가는 문제 —
      2026-09-23: 입력칸이 사라질 때까지(최대 60초, 0.5초 간격) 기다렸다가 자동으로 누른다(`retryWhenFocused`).
      허용·항상 허용·번호 응답 모두. 포커스를 옮기는 키는 찾지 않기로 했다(위 참조).
- [x] 스레드 밖 세션 제어 — 2026-09-23: 채널에 `:esc payments`, `:screen 8a01` 처럼 `:<명령> <세션>` 을 쓰면
      pid·세션 id 앞자리·폴더 이름·스레드 링크로 세션을 찾아 실행하고, 결과는 그 스레드에, 안내는 ephemeral 로.
      세션이 하나뿐이면 이름을 생략해도 된다. "세션과 무관한 일만" 원칙은 접었다: 멈춘 세션을 끄려고 스레드를 찾아 들어가는 게 더 불편했다.
- [x] 비정상 종료 시 읽기 위치 유실 — 2026-09-23: `OffsetStore` 가 변경 0.5초 뒤 저장한다(디바운스). 5초 타이머는 남겨 둔다.
- [x] 도구 카드 경과 시간 — 2026-09-23: 20초마다 스트림을 살리려고 어차피 재전송하던 `task_update` 에 `· 1분 20초` 를 붙인다.
      append 예산은 그대로(재전송 횟수가 늘지 않는다).
- [x] 긴 프롬프트 미러링 — 2026-09-23: 600자 넘으면 앞 600자 + `(+N자, 전체는 터미널에)`.

### 성능

- [x] `autoConfirmDialogs` 45초 폴링 — 2026-09-23: 세션의 shim 이 hello 를 보내(= `pendingLaunches` 에서 빠지면) 즉시 끝난다.
- [x] `:mode` 의 400ms 고정 간격 — 2026-09-23: shift+tab 뒤 상태줄이 바뀔 때까지 100ms 간격으로 최대 1.2초 본다.
- [x] `checkDialogSoon` 은 남긴다 — 결정: 모델 전환 확인("Switch model?")은 Notification 훅이 오지 않는 다이얼로그라
      훅만으로는 못 잡는다. 3초 × 300ms 캡처는 명령을 쳤을 때만이라 비용이 작다.

### 구조·테스트

- [ ] `broker.ts` 는 2026-09-23 작업으로 2,200줄이 됐다. 이번에 넣은 것(보류·전달 확인·정지 상태·리마인더·재시도)이
      `inject`/`perm`/`dialog` 영역으로 뭉쳐 있으니, 다음에 손댈 때 그 세 영역부터 모듈로 뺀다. 지금은 동작을 굳히는 게 먼저라 미룬다.
- [x] 테스트의 손으로 쓴 action_id — 2026-09-23: 렌더된 메시지가 있는 호출(설정·질문·플랜·항상 허용)은 `button()` /
      `buttonWithValue()` 로 바꿨다. 의도적으로 가짜 id 를 쓰는 것(중복 클릭, 비허용 사용자, 오래된 버튼)은 그대로.
- [x] QA 스윕의 채널 주입 경로 — 2026-09-23: 비공개 QA 채널을 만들고 봇을 초대했다.
      `.env` 의 `CLAUDE_SLACK_QA_CHANNEL` 이 있으면 스윕이 (1) 브로커가 그리는 카드를 그 채널에 실제로 올려
      Slack 이 블록을 받아주는지 검사하고 (2) 채널 주입 경로(broker → shim → MCP 알림 → 세션)를 마커로 확인한다.
      인바운드는 여전히 Slack 에서 오지 않는다 — 같은 앱의 Socket Mode 연결을 하나 더 열면 라이브 브로커가 받을
      이벤트를 가로채기 때문이다. 자세한 건 `docs/QA.md`.

### UI

- [x] 어드민 페이지에서 새 세션 시작 — 2026-09-23: 맨 위 폼(폴더·첫 프롬프트) → `POST /api/session/new`.
- [x] 어드민 페이지 화면 미리보기 — 2026-09-23: 세션 카드의 **화면** 버튼 → `GET /api/session/<pid>/screen`(`:screen` 과 같은 요약).
- [x] 앱 홈을 `card` / `data_table` 로 — 하지 않기로 했다. 이 워크스페이스는 `alert` 블록도 "not supported in this
      container" 로 거부했고(로그 1,274회), 정보량은 section 으로 충분하다. 대신 상태 이유·경과·필터를 section 에 넣었다.
- [x] 권한 요청을 `card` 로, 긴 출력을 접히는 블록으로 — 같은 이유로 보류. 권한 카드에는 diff·명령·규칙 미리보기를 넣었다.

---

## 완료 (2026-09-12)

<details>
<summary>펼치기</summary>

**슬래시 커맨드**: 스레드 밖은 `/ccnew` `/ccresume` `/cclist` `/cchistory` `/cchelp`
(풀네임 `/claude-code-*` 동시 등록), 스레드 안은 Claude Code 문법(`/`, `!`)을 그대로
통과시키고 세션 제어만 `:` 접두어. 매니페스트 재적용과 재설치까지 완료.
스레드 안 `/명령` 은 Slack 이 가로채므로 `:/compact` 로 보낸다.

**멈추지 않게**: Notification 훅으로 어떤 터미널 다이얼로그든 버튼으로 띄우기, 멈춤 감시,
권한 응답이 터미널 다이얼로그까지 처리, 재연결 시 화면 확인. `scripts/qa-sweep.ts` 로 자동 검증.

**버그**: 렌더된 action_id 를 매칭하지 않아 권한 버튼이 전혀 동작하지 않던 것, 낡은 버튼이
숫자를 프롬프트에 타이핑하던 것, 거부가 "Don't ask again"(영구 허용)을 고를 수 있던 것,
훅 중복 판정이 정당한 반복을 삼키던 것, 재시작 때마다 패널이 쌓이던 것.

**읽을 수 있게**: TUI 화면 대신 내용만(`screenDigest`), 시스템 주입 메시지를 사용자 입력으로
미러링하지 않기, 서브에이전트 구분, 할 일 체크리스트, 루트 메시지 상태줄, `/context` 표,
실행 가능한 오류 메시지, 세션 캔버스, 앱 홈 대시보드.

**구조·성능**: `actions.ts`(Slack 계약) / `dialog.ts`(다이얼로그) / `registry.ts` / `dedupe.ts` /
`purge.ts` / `session.ts` 분리, 명령 표, 동기 fs 제거, tmux 캡처 합치기, 타이밍 상수 명명,
스트리밍 배치를 append 예산에 맞춤. 테스트 89개.

**정리**: SESSION.md 는 로컬 전용(.gitignore). `findClaudePid` 폴백 주석 보강.

</details>
