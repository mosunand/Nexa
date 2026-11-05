// components/JsonView.tsx — JSON 语法着色（记录对话框 / 会话 JSON 标签页共用）。
// 正则分词 → span 着色，与老项目同一套配色语义（key/字符串/数字/布尔/null）。

import { memo, type ReactNode } from 'react'

const TOKEN_RE = /("(?:[^"\\]|\\.)*")(\s*:)?|\b(true|false)\b|\bnull\b|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g

function highlight(json: string): ReactNode {
  const out: ReactNode[] = []
  let last = 0
  let m: RegExpExecArray | null
  TOKEN_RE.lastIndex = 0
  let i = 0
  while ((m = TOKEN_RE.exec(json)) !== null) {
    if (m.index > last) out.push(json.slice(last, m.index))
    if (m[1] !== undefined) {
      if (m[2]) {
        // key
        out.push(
          <span key={i++} className="j-key">
            {m[1]}
          </span>,
          <span key={i++} className="text-faint">
            {m[2]}
          </span>
        )
      } else {
        out.push(
          <span key={i++} className="j-str">
            {m[1]}
          </span>
        )
      }
    } else if (m[3] !== undefined || m[4] !== undefined) {
      // true/false 数字混在同一组 —— 区分：m[3] 布尔
      out.push(
        <span key={i++} className={m[3] !== undefined ? 'j-bool' : 'j-num'}>
          {m[0]}
        </span>
      )
    } else if (m[0] === 'null') {
      out.push(
        <span key={i++} className="j-null">
          null
        </span>
      )
    }
    last = m.index + m[0].length
  }
  if (last < json.length) out.push(json.slice(last))
  return out
}

export const JsonView = memo(function JsonView({ data, maxChars = 200000 }: { data: unknown; maxChars?: number }): ReactNode {
  let text: string
  try {
    text = typeof data === 'string' ? data : JSON.stringify(data, null, 2)
  } catch {
    text = String(data)
  }
  if (text.length > maxChars) text = text.slice(0, maxChars) + '\n… (已截断)'
  return <div className="json-view selectable">{highlight(text)}</div>
})
