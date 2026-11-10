/// <reference types="vite/client" />
declare module '*.vue' {
  import type { DefineComponent } from 'vue'
  const component: DefineComponent<object, object, unknown>
  export default component
}
interface ImportMetaEnv {
  readonly VITE_SUPPORT_PHONE?: string
  readonly VITE_SUPPORT_NAME?: string
  readonly VITE_SUPPORT_TG?: string
}
