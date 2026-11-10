// Desktop invoke(): sxema self-heal buyruqlari no-op (bulut sxemasi to'liq), qolganlari
// paritet testida chaqirilmasligi kerak.
export async function invoke(cmd: string): Promise<unknown> {
  if (cmd === 'ensure_returns_schema' || cmd === 'ensure_stock_schema') return null
  throw new Error(`invoke(${cmd}) is not available in parity tests`)
}
