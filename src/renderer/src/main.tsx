import { Component, type ReactNode } from 'react'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { ThemeProvider } from './lib/theme'
import App from './App'
import './styles/global.css'

// 全局错误边界：单页崩溃不该打白整个应用
class ErrorBoundary extends Component<{ children: ReactNode }, { err: Error | null }> {
  state = { err: null as Error | null }
  static getDerivedStateFromError(err: Error): { err: Error } {
    return { err }
  }
  render(): ReactNode {
    if (this.state.err) {
      return (
        <div className="flex h-full flex-col items-center justify-center gap-3 p-8">
          <div className="text-sm font-semibold text-bad">页面渲染出错</div>
          <pre className="mono max-w-[720px] overflow-auto rounded-xl border border-line bg-panel-2 p-4 text-xs text-muted">
            {String(this.state.err.stack ?? this.state.err.message)}
          </pre>
          <button className="btn" onClick={() => this.setState({ err: null })}>
            重试
          </button>
        </div>
      )
    }
    return this.props.children
  }
}

void createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <ThemeProvider>
        <App />
      </ThemeProvider>
    </ErrorBoundary>
  </StrictMode>
)
