import type { DevaApi } from './index'

declare global {
  interface Window {
    deva: DevaApi
  }
}

export {}
