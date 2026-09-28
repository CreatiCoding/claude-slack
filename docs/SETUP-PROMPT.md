너는 이 맥에서 claude-slack 프로젝트의 Slack 연동을 끝까지 셋업하는 중이다. Chrome 연동(Claude in Chrome)이 켜져 있고, Chrome은 이미 내 Slack에 로그인되어 있다. 아래 순서대로 진행하고, 각 단계가 끝날 때마다 한 줄로 결과를 보고해라. 로그인 페이지나 2단계 인증 화면이 나오면 멈추고 나에게 알려라.

**절대 규칙**: 토큰(xoxb-, xapp-) 값을 채팅 응답이나 터미널 출력에 그대로 쓰지 마라. 파일에만 기록한다.

## 0. 준비
- 작업 폴더는 `~/projects/claude-slack` 이다. 없으면 `gh repo clone CreatiCoding/claude-slack ~/projects/claude-slack` 로 받는다.
- `npm install` 을 실행한다.
- `slack-manifest.json` 파일을 읽어 둔다. 1단계에서 그대로 붙여 넣는다.

## 1. Slack 앱 생성 (Chrome)
1. https://api.slack.com/apps 를 연다. 로그인되어 있지 않으면 멈추고 알려라.
2. "Create New App" → "From a manifest" 를 누른다.
3. 워크스페이스를 고른다. 여러 개면 나에게 물어라.
4. JSON 탭에 `slack-manifest.json` 내용을 붙여 넣고 Next → Create 로 만든다. 이름이 겹친다는 오류가 나면 이름 뒤에 숫자를 붙인다.

## 2. 앱 레벨 토큰
1. 왼쪽 메뉴 "Basic Information" → 아래로 내려 "App-Level Tokens" → "Generate Token and Scopes".
2. 토큰 이름은 `socket`, Scope 는 `connections:write` 를 추가하고 Generate.
3. 표시된 `xapp-` 토큰을 읽어서 `~/projects/claude-slack/.env` 에 `SLACK_APP_TOKEN=...` 로 기록한다. (`.env` 가 없으면 `.env.example` 을 복사해서 만든다.)

## 3. 워크스페이스에 설치
1. 왼쪽 메뉴 "Install App" → "Install to Workspace" → 권한 허용.
2. "Bot User OAuth Token"(`xoxb-`)을 읽어 `.env` 의 `SLACK_BOT_TOKEN` 에 기록한다.

## 4. 채널 만들기와 봇 초대 (Chrome, app.slack.com)
1. 같은 워크스페이스의 Slack 웹(app.slack.com)을 연다.
2. 채널 `#claude-code` 를 새로 만든다. 이미 있으면 그대로 쓴다.
3. 그 채널에서 `/invite @Claude Code` 를 보내 봇을 초대한다. 앱 이름을 바꿨으면 그 이름으로.
4. 채널 이름을 클릭해 상세 창 맨 아래의 채널 ID(`C`로 시작)를 읽어 `.env` 의 `SLACK_CHANNEL_ID` 에 기록한다.
5. 내 프로필(왼쪽 아래 아바타 → 프로필) → "⋯" → "회원 ID 복사"에 해당하는 값(`U`로 시작)을 읽어 `.env` 의 `SLACK_ALLOWED_USERS` 에 기록한다.
6. `.env` 의 `CLAUDE_SLACK_DEFAULT_CWD` 는 `~/projects` 로 둔다.

## 5. 로컬 설치와 검증
1. `npm run typecheck && npm test` 가 통과하는지 확인한다.
2. `npm run install-hooks` 를 실행한다. `~/.claude/settings.json` 에 훅이 추가되고 `mcp.json` 이 생긴다.
3. 브로커를 tmux 에서 띄운다: `tmux new-session -d -s claude-slack-broker -c ~/projects/claude-slack 'npm start 2>&1 | tee /tmp/claude-slack-broker.log'`
4. 10초 기다린 뒤 `/tmp/claude-slack-broker.log` 에 `[broker] up` 이 찍혔는지 확인한다. 오류가 있으면 원인을 고치고 다시 띄운다.
5. Chrome 의 `#claude-code` 채널에 새 메시지로 `~/projects/claude-slack 이 폴더에 뭐가 있는지 한 줄로 알려줘` 를 보낸다.
6. 60초 안에 그 메시지의 스레드에 "🚀 세션 시작 중" → "🟢 세션 연결됨" → 스트리밍 답변이 오는지 Chrome 으로 확인한다. 로딩 표시와 중단 버튼이 보이는지, 작업 카드(Bash 명령)가 보이는지도 본다.
7. 안 오면 `/tmp/claude-slack-broker.log` 와 `tmux attach -t claude-slack` 화면을 확인해 원인을 찾고 고친다. Slack API 오류(`not_allowed_token_type`, `missing_scope` 등)는 어떤 호출에서 났는지 기록해 둔다.

## 6. 보고
마지막에 아래를 정리해서 알려라. 토큰 값은 쓰지 않는다.
- 만든 앱 이름과 워크스페이스, 채널 이름
- 실제 Slack 화면에서 스트리밍·작업 카드·로딩 표시·중단 버튼이 각각 보였는지 (안 보인 것은 API 오류 메시지와 함께)
- 고친 것이 있으면 무엇을 고쳤는지 (코드 변경은 커밋하지 말고 diff 만 남겨라)
