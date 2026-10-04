// Hand-drawn icons: 16×16 grid, 1.5px strokes, round ends, currentColor. Emoji look different on every
// device and shake the line height; these do not.
const P = {
  link: '<path d="M6.5 9.5l3-3"/><path d="M7 4.5l1-1a2.8 2.8 0 014 4l-1 1"/><path d="M9 11.5l-1 1a2.8 2.8 0 01-4-4l1-1"/>',
  stop: '<rect x="4" y="4" width="8" height="8" rx="1.5"/>',
  clipboard: '<rect x="3.5" y="3" width="9" height="11" rx="1.5"/><path d="M6 3V2.5h4V3"/><path d="M6 7h4M6 10h3"/>',
  screen: '<rect x="2" y="3" width="12" height="8.5" rx="1.5"/><path d="M6 14h4M8 11.5V14"/>',
  dot: '<circle cx="8" cy="8" r="2.5" fill="currentColor" stroke="none"/>',
  refresh: '<path d="M13 8a5 5 0 11-1.5-3.6"/><path d="M13 2.5v3h-3"/>',
  bolt: '<path d="M9 1.5L3.5 9H8l-1 5.5L12.5 7H8z"/>',
  check: '<path d="M3 8.5l3 3 7-7"/>',
  box: '<rect x="3" y="3" width="10" height="10" rx="2"/>',
  boxChecked: '<rect x="3" y="3" width="10" height="10" rx="2"/><path d="M5.5 8.2l1.8 1.8 3.2-3.4"/>',
  alert: '<path d="M8 2l6.5 11.5h-13z"/><path d="M8 6.5v3M8 11.5v.01"/>',
  lock: '<rect x="3" y="7" width="10" height="7" rx="1.5"/><path d="M5.5 7V5a2.5 2.5 0 015 0v2"/>',
  keyboard: '<rect x="1.5" y="4" width="13" height="8" rx="1.5"/><path d="M4 7h.01M6.5 7h.01M9 7h.01M11.5 7h.01M5 9.5h6"/>',
  play: '<path d="M5 3.5v9l7.5-4.5z"/>',
  pause: '<path d="M5.5 3.5v9M10.5 3.5v9"/>',
  bot: '<rect x="3" y="5" width="10" height="8" rx="2"/><path d="M8 2.5V5M6 9h.01M10 9h.01"/>',
  image: '<rect x="2" y="3" width="12" height="10" rx="1.5"/><circle cx="5.5" cy="6.5" r="1"/><path d="M14 10.5l-3.5-3.5L4 13"/>',
  attach: '<path d="M13 7.5l-5.2 5.2a3 3 0 01-4.3-4.2L9 3a2 2 0 012.8 2.8L6.4 11.2a1 1 0 01-1.4-1.4L10 4.8"/>',
  chat: '<path d="M2.5 3.5h11v7.5H7l-3 2.5V11H2.5z"/>',
  question: '<circle cx="8" cy="8" r="6"/><path d="M6.2 6.3a1.9 1.9 0 113 1.5c-.8.5-1.2.9-1.2 1.7M8 11.5v.01"/>',
  deny: '<circle cx="8" cy="8" r="6"/><path d="M3.8 12.2l8.4-8.4"/>',
  spark: '<path d="M8 1.5v4M8 10.5v4M1.5 8h4M10.5 8h4M3.4 3.4l2.4 2.4M10.2 10.2l2.4 2.4M3.4 12.6l2.4-2.4M10.2 5.8l2.4-2.4"/>',
  folder: '<path d="M1.5 4.5a1 1 0 011-1H6l1.5 1.5h6a1 1 0 011 1v6.5a1 1 0 01-1 1h-11a1 1 0 01-1-1z"/>',
  up: '<path d="M8 13V3M3.5 7.5L8 3l4.5 4.5"/>',
  terminal: '<rect x="1.5" y="2.5" width="13" height="11" rx="1.5"/><path d="M4.5 6l2 2-2 2M8 10.5h3.5"/>',
  tool: '<path d="M10 2.5a3 3 0 00-2.8 4.1L2.5 11.3a1.3 1.3 0 001.8 1.8l4.7-4.7A3 3 0 0013 5.5l-1.8 1.8-1.8-.5-.5-1.8L10.7 3z"/>',
  file: '<path d="M4 1.5h5l3.5 3.5v9.5H4z"/><path d="M9 1.5V5h3.5"/>',
  search: '<circle cx="7" cy="7" r="4.5"/><path d="M10.5 10.5l3.5 3.5"/>',
  edit: '<path d="M10.5 2.5l3 3L6 13H3v-3z"/><path d="M9 4l3 3"/>',
  globe: '<circle cx="8" cy="8" r="6"/><path d="M2 8h12M8 2c1.8 1.7 2.6 3.7 2.6 6S9.8 12.3 8 14c-1.8-1.7-2.6-3.7-2.6-6S6.2 3.7 8 2z"/>',
  bell: '<path d="M4 11V7a4 4 0 018 0v4l1.5 1.5h-11z"/><path d="M6.5 14h3"/>',
  undo: '<path d="M4 6.5h6a3.5 3.5 0 010 7H6"/><path d="M6.5 4L4 6.5 6.5 9"/>',
  plan: '<path d="M3 3.5h10M3 8h10M3 12.5h6"/>',
  ended: '<circle cx="8" cy="8" r="6"/><circle cx="8" cy="8" r="2.5" fill="currentColor" stroke="none"/>',
  ring: '<circle cx="8" cy="8" r="6"/>',
  more: '<circle cx="3.5" cy="8" r=".9" fill="currentColor"/><circle cx="8" cy="8" r=".9" fill="currentColor"/><circle cx="12.5" cy="8" r=".9" fill="currentColor"/>',
  sidebar: '<rect x="1.5" y="2.5" width="13" height="11" rx="1.5"/><path d="M6 2.5v11"/>',
  back: '<path d="M10 3L5 8l5 5"/>',
  chevron: '<path d="M6 3.5L10.5 8 6 12.5"/>',
  plus: '<path d="M8 3v10M3 8h10"/>',
  close: '<path d="M4 4l8 8M12 4l-8 8"/>',
  copy: '<rect x="5" y="5" width="8.5" height="8.5" rx="1.5"/><path d="M11 5V3.5A1 1 0 0010 2.5H3.5a1 1 0 00-1 1V10a1 1 0 001 1H5"/>',
  sun: '<circle cx="8" cy="8" r="3"/><path d="M8 1.5v1.5M8 13v1.5M1.5 8H3M13 8h1.5M3.4 3.4l1 1M11.6 11.6l1 1M3.4 12.6l1-1M11.6 4.4l1-1"/>',
  moon: '<path d="M13 9.5A5.5 5.5 0 016.5 3 5.5 5.5 0 1013 9.5z"/>',
  pr: '<circle cx="4.5" cy="3.5" r="1.5"/><circle cx="4.5" cy="12.5" r="1.5"/><circle cx="11.5" cy="12.5" r="1.5"/><path d="M4.5 5v6M11.5 11V6.5a2 2 0 00-2-2H7M8.5 3L7 4.5 8.5 6"/>',
}

export function icon(name, cls = '') {
  const body = P[name] ?? P.dot
  return `<svg class="ic${cls ? ' ' + cls : ''}" viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`
}

/** A tool's icon from its name, not from the emoji the broker put in front of its title. */
export function toolIcon(name = '') {
  if (name === 'Bash' || name === 'BashOutput' || name === 'KillShell') return 'terminal'
  if (name === 'Read' || name === 'NotebookRead') return 'file'
  if (/^(Edit|MultiEdit|Write|NotebookEdit)$/.test(name)) return 'edit'
  if (name === 'Grep' || name === 'Glob' || name === 'ToolSearch') return 'search'
  if (/^Web/.test(name) || /chrome|browser/i.test(name)) return 'globe'
  if (name === 'Task' || name === 'Agent' || name === 'SendMessage') return 'bot'
  if (name === 'Monitor') return 'bell'
  if (name === 'TodoWrite' || name === 'ExitPlanMode') return 'plan'
  if (name === 'AskUserQuestion') return 'question'
  return 'tool'
}

/** Leading emoji the broker writes, and the icon that stands for each on the web. */
const EMOJI_ICON = [
  [/^(🔐|🔒)/u, 'lock'], [/^(⏸️?|⏸)/u, 'pause'], [/^(▶️?)/u, 'play'], [/^(⚡)/u, 'bolt'], [/^(✅|☑️?|✔️?)/u, 'check'],
  [/^(⛔|🚫|❌)/u, 'deny'], [/^(⚠️?)/u, 'alert'], [/^(❓|🙋)/u, 'question'], [/^(📋|🗺️?)/u, 'plan'], [/^(🕓|⏳|⏰)/u, 'ring'],
  [/^(🧹)/u, 'refresh'], [/^(📦)/u, 'clipboard'], [/^(↩️?)/u, 'undo'], [/^(🤖)/u, 'bot'], [/^(⚫)/u, 'ended'], [/^(🟢)/u, 'dot'],
  [/^(✏️?)/u, 'edit'], [/^(🔔)/u, 'bell'], [/^(📨|💬)/u, 'chat'], [/^(🖥️?|📸)/u, 'screen'], [/^(⌨️?)/u, 'keyboard'], [/^(🌐)/u, 'globe'],
  [/^(⚙️?|🔧|🛠️?)/u, 'tool'], [/^(🔑)/u, 'lock'], [/^(📎)/u, 'attach'], [/^(🔗)/u, 'link'], [/^(👁️?)/u, 'search'],
]
const ANY_LEADING_EMOJI = /^(?:\p{Extended_Pictographic}|\p{Regional_Indicator})(?:️|‍\p{Extended_Pictographic})*\s*/u

/** Split a leading emoji off a broker line: the icon to draw instead, and the rest of the text. */
export function takeEmoji(text) {
  const t = String(text ?? '').replace(/^\s+/, '')
  for (const [re, name] of EMOJI_ICON) {
    const m = re.exec(t)
    if (m) return { icon: name, rest: t.slice(m[0].length).replace(/^\s+/, '') }
  }
  const m = ANY_LEADING_EMOJI.exec(t)
  return m ? { icon: null, rest: t.slice(m[0].length) } : { icon: null, rest: t }
}
