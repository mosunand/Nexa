// lib/csv.ts — 表格导出（带 BOM，Excel 打开中文不乱码）

export function exportCsv(filename: string, headers: string[], rows: Array<Array<string | number>>): void {
  const esc = (v: string | number | undefined): string => {
    const s = String(v ?? '')
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s
  }
  const csv = '\ufeff' + [headers, ...rows].map((r) => r.map(esc).join(',')).join('\r\n')
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = filename
  a.click()
  setTimeout(() => URL.revokeObjectURL(a.href), 1000)
}
