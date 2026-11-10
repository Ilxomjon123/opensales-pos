// Tip pariteti: bulut modullari desktop modullarining API'sini to'liq beradi. vue-tsc
// shu faylni tekshiradi — desktop'ga yangi funksiya qo'shilib, bu yerda unutilsa build yiqiladi.
import type * as DDb from '../../src/lib/db'
import type * as DStock from '../../src/lib/stock'
import type * as DReports from '../../src/lib/reports'
import type * as DXlsx from '../../src/lib/xlsx'
import type * as DPlatform from '../../src/lib/platform'
import type * as DTheme from '../../src/lib/theme'
import * as CDb from './lib/db'
import * as CStock from './lib/stock'
import * as CReports from './lib/reports'
import * as CXlsx from './lib/xlsx'
import * as CPlatform from './lib/platform'
import * as CTheme from './lib/theme'
import * as CPrint from './lib/print'
import * as CAuth from './lib/auth'
import * as CI18n from './lib/i18n'

type Fns<T> = { [K in keyof T as T[K] extends (...a: never[]) => unknown ? K : never]: T[K] }

export const _db: Omit<Fns<typeof DDb>, 'db'> = CDb
export const _stock: Fns<typeof DStock> = CStock
export const _reports: Fns<typeof DReports> = CReports
export const _xlsx: Fns<typeof DXlsx> = CXlsx
export const _platform: typeof DPlatform = CPlatform
export const _theme: Fns<typeof DTheme> = CTheme
export const _print: Pick<typeof import('../../src/lib/print'), 'printReceipt' | 'printLabel'> = CPrint
export const _auth: Pick<typeof import('../../src/lib/auth'), 'can' | 'routeAllowed' | 'logout'> = CAuth
export const _i18n: Pick<typeof import('../../src/lib/i18n'), 't' | 'loadLocale' | 'setLocale' | 'availableLocales'> = CI18n
