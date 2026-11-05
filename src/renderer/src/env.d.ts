/// <reference types="vite/client" />
import type { NexaApi } from '@shared/api'

declare global {
  interface Window {
    nexa: NexaApi
  }
  /** 构建期注入的应用版本号（来源 package.json） */
  const __APP_VERSION__: string
}

export {}
