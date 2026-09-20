/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_DATA_MODE?: 'mock' | 'live'
  readonly VITE_API_BASE?: string
  readonly VITE_ENTERPRISE_ID?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
