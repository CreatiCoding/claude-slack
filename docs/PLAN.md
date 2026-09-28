# 계획

## 목표
Slack 스레드 하나 = Claude Code 세션 하나. 터미널에서 볼 수 있는 경험을 Slack UI로 최대한 재현한다.

## 터미널 경험 → Slack UI
| 터미널 | Slack |
|---|---|
| 답변 스트리밍 | `chat.startStream` / `appendStream` / `stopStream` (markdown) |
| 도구 호출 진행 | 같은 스트림의 `task_update` (in_progress → complete/error, output 접힘) |
| 작업 중 + Esc | `agents.sessions.setStatus processing` + 네이티브 중단 버튼 → tmux Esc |
| 권한 프롬프트 | 버튼 허용/거부, ⋯ 메뉴 "항상 허용"(tmux) |
| AskUserQuestion / 플랜 승인 | 라디오·체크박스·모달, 답은 tmux 키 입력 |
| Todo | `plan` 블록 |
| diff, 긴 출력, 사고 과정 | `container` 접힘 |
| 상태줄 | 루트 메시지 `context` 줄 |
| /context /usage | `table` 블록 |
| 세션 목록 | 앱 홈 `card` / `data_table` |
| 터미널 화면 그대로 | 코드 블록 + 키 버튼 (안전망) |

## 단계
1. 브로커 + 채널 셤 + 훅 + tmux 런처 (초안 완료)
2. 대화 기록 파일 실시간 읽기 → 스트리밍 + task_update, 세션 상태/중단 버튼
3. 다이얼로그 계층: 항상 허용, AskUserQuestion, 플랜 승인 (tmux 화면 읽기 + 키 입력)
4. 앱 홈 대시보드, 슬래시 명령, 세션 캔버스

## 제약
- Channels는 리서치 프리뷰 (claude.ai 로그인 필요, 시작 시 확인 다이얼로그)
- Slack 스트리밍 append는 분당 20회 급 → 2~3초 배칭
- 새 Block Kit 블록은 Bolt 타입에 없을 수 있음 → raw JSON
