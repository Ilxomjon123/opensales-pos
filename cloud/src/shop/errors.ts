// Domen xatosi: `code` — klient tarjima qiladigan kalit, `params` — o'rinbosarlar.
//
// Ikki xil kod:
// - desktop `db.ts` uslubidagi op'larda TO'LIQ i18n kaliti (`products.barcodeInUse`) —
//   klient `new Error(t(code, params))` qiladi, desktop'dagi xabar aynan chiqadi;
// - Rust'dan ko'chirilgan op'larda (vozvrat/kirim) QISQA kod (`qtyExceeds`) — klient
//   `{code, params}` ni o'zgartirmay `returnErrorMessage`/`stockErrorMessage` ga beradi.
export class DomainError extends Error {
  readonly code: string
  readonly params: Record<string, unknown>
  readonly status: number

  constructor(code: string, params: Record<string, unknown> = {}, status = 422) {
    super(code)
    this.name = 'DomainError'
    this.code = code
    this.params = params
    this.status = status
  }
}

export const forbidden = () => new DomainError('cloud.errors.forbidden', {}, 403)
export const invalid = (field: string) => new DomainError('cloud.errors.invalidInput', { field }, 400)
export const notFound = (what: string) => new DomainError('cloud.errors.notFound', { what }, 404)
