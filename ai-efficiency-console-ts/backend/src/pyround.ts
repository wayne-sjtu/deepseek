/**
 * Python 兼容的 `round()` —— 口径忠实性的一环，不是锦上添花。
 *
 * 为什么不能直接用 `Math.round()`
 * ------------------------------
 * 两点本质差异，都会直接改变看板上的数字：
 *
 *   1. **平局方向不同**：Python 的 `round` 是 round-half-even（银行家舍入），
 *      `round(0.125, 2) == 0.12`；JS 的 `Math.round` 是 half-up，
 *      `Math.round(0.125 * 100) / 100 == 0.13`。
 *   2. **舍入基准不同**：Python 在 `double` 的**精确十进制值**上做正确舍入；
 *      而 `Math.round(x * 100) / 100` 会先做一次浮点乘法，把误差引进平局判定。
 *      例如 `round(2.675, 2) == 2.67`（因为 2.675 的双精度值实际略小于 2.675），
 *      朴素写法在很多实现里会给出 2.68。
 *
 * 实现思路
 * --------
 * 把有限 double 精确分解为 `m * 2^e`（m 为整数，e 为整数，均可为负），于是
 *
 *     |x| * 10^n = m * 5^n * 2^(e+n) = P * 2^E
 *
 * 若 `E >= 0` 则结果本身是精确整数；若 `E < 0` 则除以 `2^(-E)`，用 BigInt 取
 * 商与余数，按「余数 vs 半个除数」做 half-even 判定 —— 全程无浮点误差。
 * 最后把整数拼成十进制字符串（把小数点插回去），交给 `Number()` 解析：
 * ECMAScript 的字符串转数字是**正确舍入**的，正好等价于 CPython 把舍入后的
 * 十进制值转回 double 的行为。
 *
 * 边界
 * ----
 *   - `ndigits` 只支持 >= 0（源项目未使用负数位）。
 *   - 非有限值原样返回（Python 对 `round(nan, n)` 返回 nan）。
 *   - 省略 `ndigits` 时等价 Python `round(x)`，返回整数值。
 */

/** 把正的有限 double 分解为 `m * 2^e`。 */
function decompose(x: number): { m: bigint; e: number } {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, x);
  const hi = view.getUint32(0);
  const lo = view.getUint32(4);
  const expBits = (hi >>> 20) & 0x7ff;
  const mantHi = hi & 0xfffff;
  if (expBits === 0) {
    // 次正规数：无隐含前导 1
    return { m: (BigInt(mantHi) << 32n) | BigInt(lo), e: -1074 };
  }
  return { m: (BigInt(mantHi | 0x100000) << 32n) | BigInt(lo), e: expBits - 1075 };
}

/** 把整数 N 还原成带 nd 位小数的十进制串。 */
function decimalString(n: bigint, nd: number): string {
  if (nd === 0) return n.toString();
  let s = n.toString();
  if (s.length <= nd) s = '0'.repeat(nd - s.length + 1) + s;
  return `${s.slice(0, s.length - nd)}.${s.slice(s.length - nd)}`;
}

/**
 * 等价 Python `round(x, ndigits)`（银行家舍入 + 精确十进制基准）。
 * `ndigits` 省略时等价 `round(x)`。
 */
export function pyRound(x: number, ndigits = 0): number {
  if (!Number.isFinite(x)) return x;
  if (x === 0) return 0;
  if (ndigits < 0) throw new RangeError('pyRound 只支持 ndigits >= 0');

  const negative = x < 0;
  const { m, e } = decompose(Math.abs(x));

  const p = m * 5n ** BigInt(ndigits);
  const shiftAmount = e + ndigits;

  let n: bigint;
  if (shiftAmount >= 0) {
    n = p << BigInt(shiftAmount); // 已是精确整数，无需舍入
  } else {
    const shift = BigInt(-shiftAmount);
    const q = p >> shift;
    const r = p - (q << shift);
    const half = 1n << (shift - 1n);
    if (r > half) n = q + 1n;
    else if (r < half) n = q;
    else n = (q & 1n) === 1n ? q + 1n : q; // 平局：向偶数
  }

  const magnitude = Number(decimalString(n, ndigits));
  return negative ? -magnitude : magnitude;
}

/** 等价 Python `round(x, 2)`，用于本文件与上层的高频调用。 */
export function round2(x: number): number {
  return pyRound(x, 2);
}

/** 等价 Python `round(x, 1)`。 */
export function round1(x: number): number {
  return pyRound(x, 1);
}

/** 等价 Python `round(x)`，返回整数。 */
export function round0(x: number): number {
  return pyRound(x, 0);
}
