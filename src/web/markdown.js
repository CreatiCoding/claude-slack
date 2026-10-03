// Markdown (Claude's answers) and Slack mrkdwn (the broker's cards) to HTML. No library: the input is
// escaped first, then a small set of constructs is turned back into markup, so nothing in a message can
// inject HTML.

import { icon } from './icons.js'

/** A code block with a copy button (shown on hover on a PC, always on a phone). */
export function codeBox(inner, lang = '') {
  return `<div class="codebox"><pre${lang ? ` data-lang="${esc(lang)}"` : ''}><code>${inner}</code></pre><button class="copy" type="button" aria-label="복사">${icon('copy')}<span>복사</span></button></div>`
}

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
}

// A bare http(s) address becomes a link. Only ASCII joins it — `PR(https://…/pull/1)은` used to glom the
// closing `)은` into the "address" because nothing in the old class stopped at the Korean character, and
// the trailing-punctuation strip below only looks at the very last character (20). Trailing . , ) ] ' "
// still belong to the sentence, not the address, once the match itself stops at the real end.
const URL_RE = /\bhttps?:\/\/[\x21-\x5f\x61-\x7e]+/g
export function autolink(escaped) {
  return escaped.replace(URL_RE, (m) => {
    // `&quot;` / `&#39;` are what quotes became after escaping.
    let url = m
    let tail = ''
    for (;;) {
      const t = /(&quot;|&#39;|[.,)\]'"])$/.exec(url)
      if (!t) break
      tail = t[1] + tail
      url = url.slice(0, -t[1].length)
    }
    if (!url) return m
    return `<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>${tail}`
  })
}

/** Links inside text that is already escaped but has no markup yet (code, tool output). */
export function linkify(text) {
  return autolink(esc(text))
}

// Inline constructs, applied to escaped text. Code spans are cut out first so nothing inside them changes.
function inline(escaped, { slack = false } = {}) {
  const codes = []
  let s = escaped.replace(/(`+)([^`\n]|[^`\n][^\n]*?[^`\n])\1(?!`)/g, (_, _ticks, c) => {
    codes.push(`<code>${autolink(c)}</code>`)
    return `\u0000${codes.length - 1}\u0000`
  })
  const links = []
  const keep = (html) => {
    links.push(html)
    return `\u0001${links.length - 1}\u0001`
  }
  if (slack) {
    // <url|label>, <url>, <@U123>, <#C123>
    s = s.replace(/&lt;(https?:\/\/[^|&\s]+(?:&amp;[^|&\s]*)*)\|([^&]+?)&gt;/g, (_, u, l) => keep(`<a href="${u}" target="_blank" rel="noopener noreferrer">${l}</a>`))
    s = s.replace(/&lt;(https?:\/\/[^&\s]+(?:&amp;[^&\s]*)*)&gt;/g, (_, u) => keep(`<a href="${u}" target="_blank" rel="noopener noreferrer">${u}</a>`))
    s = s.replace(/&lt;@([A-Z0-9]+)&gt;/g, () => keep('<span class="mention">@나</span>'))
    s = s.replace(/&lt;#([A-Z0-9]+)(?:\|([^&]+))?&gt;/g, (_, id, n) => keep(`<span class="mention">#${n || '채널'}</span>`))
    s = s.replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,!?:;]|$)/g, '$1<strong>$2</strong>')
    s = s.replace(/(^|[\s(])_([^_\n]+)_(?=[\s).,!?:;]|$)/g, '$1<em>$2</em>')
    s = s.replace(/(^|[\s(])~([^~\n]+)~(?=[\s).,!?:;]|$)/g, '$1<del>$2</del>')
  } else {
    s = s.replace(/!?\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, (_, l, u) => keep(`<a href="${u}" target="_blank" rel="noopener noreferrer">${l}</a>`))
    s = s.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    s = s.replace(/__([^_\n]+)__/g, '<strong>$1</strong>')
    s = s.replace(/(^|[^*\w])\*([^*\n]+)\*(?!\w)/g, '$1<em>$2</em>')
    s = s.replace(/(^|[^_\w])_([^_\n]+)_(?!\w)/g, '$1<em>$2</em>')
    s = s.replace(/~~([^~\n]+)~~/g, '<del>$1</del>')
  }
  s = s.replace(/(^|[^"=\u0001])(\bhttps?:\/\/[^\s<>"'`\u0000\u0001]+)/g, (m, pre, u) => pre + autolink(u))
  s = s.replace(/:([a-z0-9_+-]+):/g, (m, name) => EMOJI[name] ?? m)
  s = s.replace(/\u0001(\d+)\u0001/g, (_, i) => links[Number(i)])
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => codes[Number(i)])
}

const EMOJI = {
  white_check_mark: '✅', x: '❌', eyes: '👀', hourglass_flowing_sand: '⏳', warning: '⚠️', lock: '🔒', tada: '🎉',
  heavy_check_mark: '✔️', rocket: '🚀', memo: '📝', bulb: '💡', red_circle: '🔴', large_green_circle: '🟢',
  large_yellow_circle: '🟡', large_orange_circle: '🟠', black_circle: '⚫', thumbsup: '👍', '+1': '👍', fire: '🔥',
  black_circle_for_record: '⏺', gear: '⚙️', mag: '🔍', pencil2: '✏️', robot_face: '🤖', clock3: '🕒',
}

function table(rows) {
  const cells = (r) => r.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map((c) => c.trim())
  const head = cells(rows[0])
  const body = rows.slice(2).map(cells)
  return `<div class="table-wrap"><table><thead><tr>${head.map((c) => `<th>${inline(esc(c))}</th>`).join('')}</tr></thead><tbody>${body
    .map((r) => `<tr>${r.map((c) => `<td>${inline(esc(c))}</td>`).join('')}</tr>`)
    .join('')}</tbody></table></div>`
}

function blocks(text, opts) {
  const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n')
  const out = []
  let i = 0
  let para = []
  const flush = () => {
    if (para.length) out.push(`<p>${para.map((l) => inline(esc(l), opts)).join('<br>')}</p>`)
    para = []
  }
  while (i < lines.length) {
    const line = lines[i]
    // Markdown fences by CommonMark's rule: three or more backticks (or tildes) at the start of the line
    // (indented, as inside a list item), closed by at least as many of the same, alone on a line. A ```
    // in the middle of a line is not a fence, and shorter runs inside a longer fence are code.
    const open = !opts.slack && /^( {0,8})(`{3,}|~{3,})([^`]*)$/.exec(line)
    if (open) {
      flush()
      const indent = open[1].length
      const mark = open[2]
      const close = new RegExp(`^ {0,${indent + 3}}${mark[0] === '`' ? '`' : '~'}{${mark.length},}\\s*$`)
      const body = []
      i++
      while (i < lines.length && !close.test(lines[i])) {
        const l = lines[i++]
        body.push(l.startsWith(' '.repeat(indent)) ? l.slice(indent) : l.replace(/^ +/, ''))
      }
      i++ // the closing fence (or the end)
      out.push(codeBox(linkify(body.join('\n')), open[3].trim()))
      continue
    }
    const fence = opts.slack && /^\s*```/.exec(line)
    if (fence) {
      flush()
      const lang = line.trim().slice(3).trim()
      const body = []
      // Slack writes ```code``` on one line too.
      const oneLine = /^\s*```(.+)```\s*$/.exec(line)
      if (oneLine) {
        out.push(codeBox(linkify(oneLine[1])))
        i++
        continue
      }
      i++
      while (i < lines.length && !/^\s*```/.test(lines[i])) body.push(lines[i++])
      if (i < lines.length) {
        const rest = lines[i].replace(/^\s*```/, '')
        if (rest.trim() && opts.slack) para.push(rest)
      }
      i++
      out.push(codeBox(linkify(opts.slack && lang ? [lang, ...body].join('\n') : body.join('\n')), opts.slack ? '' : lang))
      continue
    }
    if (!opts.slack && /^\s*\|.*\|\s*$/.test(line) && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1] ?? '')) {
      flush()
      const rows = []
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) rows.push(lines[i++])
      out.push(table(rows))
      continue
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(line)
    if (h && !opts.slack) {
      flush()
      out.push(`<h${Math.min(6, h[1].length + 2)} class="md-h">${inline(esc(h[2]), opts)}</h${Math.min(6, h[1].length + 2)}>`)
      i++
      continue
    }
    if (/^\s*(&gt;|>)\s?/.test(line)) {
      flush()
      const q = []
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) q.push(lines[i++].replace(/^\s*>\s?/, ''))
      out.push(`<blockquote>${blocks(q.join('\n'), opts)}</blockquote>`)
      continue
    }
    const li = /^(\s*)([-*•]|\d+[.)])\s+(.*)$/.exec(line)
    if (li) {
      flush()
      const ordered = /\d/.test(li[2])
      const items = []
      while (i < lines.length) {
        const m = /^(\s*)([-*•]|\d+[.)])\s+(.*)$/.exec(lines[i])
        if (!m) {
          // A fence under the item ends the list here, so the code block is drawn as one.
          if (!opts.slack && /^ {0,8}(`{3,}|~{3,})[^`]*$/.test(lines[i])) break
          // A continuation line indented under the item.
          if (/^\s{2,}\S/.test(lines[i]) && items.length) {
            items[items.length - 1] += '<br>' + inline(esc(lines[i].trim()), opts)
            i++
            continue
          }
          break
        }
        const task = /^\[( |x|X)\]\s+(.*)$/.exec(m[3])
        const body = task ? `<span class="task ${task[1] === ' ' ? '' : 'done'}">${task[1] === ' ' ? '☐' : '☑'}</span> ${inline(esc(task[2]), opts)}` : inline(esc(m[3]), opts)
        items.push((m[1].length >= 2 ? '<span class="indent"></span>' : '') + body)
        i++
      }
      out.push(`<${ordered ? 'ol' : 'ul'}>${items.map((x) => `<li>${x}</li>`).join('')}</${ordered ? 'ol' : 'ul'}>`)
      continue
    }
    if (/^\s*(---+|\*\*\*+)\s*$/.test(line) && !opts.slack) {
      flush()
      out.push('<hr>')
      i++
      continue
    }
    if (!line.trim()) {
      flush()
      i++
      continue
    }
    para.push(line)
    i++
  }
  flush()
  return out.join('')
}

/** Claude's markdown. */
export function md(text) {
  return blocks(text, {})
}

/** Slack mrkdwn, as the broker writes it for cards and notices. */
export function mrkdwn(text) {
  return blocks(text, { slack: true })
}
