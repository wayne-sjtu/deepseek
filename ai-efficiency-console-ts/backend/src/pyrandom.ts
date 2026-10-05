/**
 * Python `random.Random` 的逐位兼容实现。
 *
 * 为什么需要它
 * ------------
 * `gen_mock.py` 用 `random.Random(SEED)` 生成数据集。要让 TS 版生成出**逐字节相同**的
 * 数据集（从而把「口径没搬错」变成可机器验证的事实），就必须复刻 CPython 的 PRNG，
 * 而不是换成 JS 的 `Math.random()`。
 *
 * 实现依据（CPython 3.13 `Modules/_randommodule.c` + `Lib/random.py`）
 * ---------------------------------------------------------------
 *   - MT19937 状态 624 字；`init_genrand` / `init_by_array` 按原始论文实现；
 *   - 整数种子：取绝对值 → 拆成小端 32 位字（`keyused = max(1, ceil(bits/32))`）→ `init_by_array`；
 *   - `random()` = `genrand_res53()`：`(a*67108864 + b) * 2**-53`，a/b 各取 32 位的高 27/26 位；
 *   - `getrandbits(k)`：k<=32 时取 `genrand_uint32() >>> (32-k)`；
 *   - `_randbelow(n)`：取 `k = n.bit_length()` 位，>=n 就重取（拒绝采样）；
 *   - `gauss` 用极坐标法，并缓存第二个值（`gauss_next`）—— **状态跨调用**，必须保留。
 *
 * 已知的唯一不可控差异
 * --------------------
 * `Math.log/sin/cos` 与 CPython 所用 libm 偶有 **1 ULP** 差异（实测 log 7.0%、
 * sin 4.3%、cos 4.9% 的样本各不相同）。这些差异在 `gen_mock.py` 里会被 `round()`
 * 取整吸收（1 ULP 跨越 .5 边界的概率约 1e-16/次），因此数据集仍逐字节一致 ——
 * 该结论由 `scripts/parity-dataset.mjs` 的全量字节 diff 直接证实。
 *
 * 边界：仅实现 `gen_mock.py` 用到的 API。未实现 sample/shuffle/randbytes 等，
 * 用到时请补实现并同步扩测 `pyrandom.test.ts`。
 */

const N = 624;
const M = 397;
const MATRIX_A = 0x9908b0df;
const UPPER_MASK = 0x80000000;
const LOWER_MASK = 0x7fffffff;
const TWOPI = 2 * Math.PI;

/**
 * 等价 Python `int.bit_length()`（n 为非负整数）。
 * 用于 `_randbelow` 的 `k = n.bit_length()`；`n < 2**53` 时结果精确。
 */
function bitLength(n: number): number {
  if (n <= 0) return 0;
  if (n <= 0xffffffff) return 32 - Math.clz32(n);
  return 32 + (32 - Math.clz32(Math.floor(n / 4294967296)));
}

/** 把 double 的 IEEE754 位模式转成 16 位十六进制串（用于逐位断言）。 */
export function doubleBits(v: number): string {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, v);
  let out = '';
  for (const byte of new Uint8Array(view.buffer)) out += byte.toString(16).padStart(2, '0');
  return out;
}

export class PyRandom {
  private mt = new Uint32Array(N);
  private mti = N + 1;
  private gaussNext: number | null = null;

  constructor(seed: number) {
    this.seed(seed);
  }

  /** 复刻 CPython：整数种子 → 小端 32 位字数组 → init_by_array。 */
  seed(value: number): void {
    let n = BigInt(value);
    if (n < 0n) n = -n;
    const key: number[] = [];
    if (n === 0n) {
      key.push(0);
    } else {
      while (n > 0n) {
        key.push(Number(n & 0xffffffffn));
        n >>= 32n;
      }
    }
    this.initByArray(key, key.length);
  }

  private initGenrand(s: number): void {
    this.mt[0] = s >>> 0;
    for (let i = 1; i < N; i++) {
      const prev = this.mt[i - 1];
      this.mt[i] = (Math.imul(1812433253, prev ^ (prev >>> 30)) + i) >>> 0;
    }
    this.mti = N;
  }

  private initByArray(key: number[], keyLength: number): void {
    this.initGenrand(19650218);
    let i = 1;
    let j = 0;
    let k = Math.max(N, keyLength);
    for (; k; k--) {
      const prev = this.mt[i - 1];
      this.mt[i] =
        (((this.mt[i] ^ Math.imul(prev ^ (prev >>> 30), 1664525)) >>> 0) + key[j] + j) >>> 0;
      i++;
      j++;
      if (i >= N) {
        this.mt[0] = this.mt[N - 1];
        i = 1;
      }
      if (j >= keyLength) j = 0;
    }
    for (k = N - 1; k; k--) {
      const prev = this.mt[i - 1];
      this.mt[i] = (((this.mt[i] ^ Math.imul(prev ^ (prev >>> 30), 1566083941)) >>> 0) - i) >>> 0;
      i++;
      if (i >= N) {
        this.mt[0] = this.mt[N - 1];
        i = 1;
      }
    }
    this.mt[0] = 0x80000000;
  }

  /** MT19937 核心：产出下一个 32 位无符号整数。 */
  genrandUint32(): number {
    const mt = this.mt;
    let y: number;
    if (this.mti >= N) {
      let kk: number;
      if (this.mti === N + 1) this.initGenrand(5489);
      for (kk = 0; kk < N - M; kk++) {
        y = (mt[kk] & UPPER_MASK) | (mt[kk + 1] & LOWER_MASK);
        mt[kk] = mt[kk + M] ^ (y >>> 1) ^ (y & 1 ? MATRIX_A : 0);
      }
      for (; kk < N - 1; kk++) {
        y = (mt[kk] & UPPER_MASK) | (mt[kk + 1] & LOWER_MASK);
        mt[kk] = mt[kk + (M - N)] ^ (y >>> 1) ^ (y & 1 ? MATRIX_A : 0);
      }
      y = (mt[N - 1] & UPPER_MASK) | (mt[0] & LOWER_MASK);
      mt[N - 1] = mt[M - 1] ^ (y >>> 1) ^ (y & 1 ? MATRIX_A : 0);
      this.mti = 0;
    }
    y = mt[this.mti++];
    y ^= y >>> 11;
    y ^= (y << 7) & 0x9d2c5680;
    y ^= (y << 15) & 0xefc60000;
    y ^= y >>> 18;
    return y >>> 0;
  }

  /** 等价 Python `random.random()`。 */
  random(): number {
    const a = this.genrandUint32() >>> 5;
    const b = this.genrandUint32() >>> 6;
    return (a * 67108864.0 + b) * (1.0 / 9007199254740992.0);
  }

  /**
   * 等价 Python `getrandbits(k)`。
   *
   * CPython 的拼装方式（`_randommodule.c` 的 `random_getrandbits_impl`）是
   * **按字拼接、只有最后一个字右移**：
   *   `words = (k-1)/32 + 1`；第 i 个字取 `genrand_uint32()`，若该字是最后一截
   *   （剩余位数 < 32）则 `r >>= (32 - 剩余位数)`，然后 `word[i] = r`。
   * 即结果 = `r0 | ((r1 >> 15) << 32)`（k=49 时），而不是把整块拼起来再整体右移。
   *
   * 边界：k <= 53 时结果仍在 double 的精确整数范围内（gen_mock.py 最大用到 49 位）；
   * 更大的 k 需要返回 BigInt，本项目未使用。
   */
  getrandbits(k: number): number {
    if (k <= 0) return 0;
    if (k <= 32) return this.genrandUint32() >>> (32 - k);
    const words = Math.floor((k - 1) / 32) + 1;
    let remaining = k;
    let acc = 0n;
    for (let i = 0; i < words; i++, remaining -= 32) {
      let r = this.genrandUint32();
      if (remaining < 32) r >>>= 32 - remaining;
      acc |= BigInt(r) << BigInt(32 * i);
    }
    return Number(acc);
  }

  /**
   * 等价 Python `_randbelow_with_getrandbits(n)`（拒绝采样）。
   *
   * `k = n.bit_length()` 必须用真正的位长：`Math.clz32` 只对 32 位无符号数有效，
   * 对 `n >= 2**32`（如 `randrange(16**8)`、`randrange(16**12)`）会得到 k = 0，
   * 于是返回 0 **且不消耗任何熵**，整条随机序列从此与 CPython 脱轨。
   */
  randbelow(n: number): number {
    if (!n) return 0;
    const k = bitLength(n);
    let r = this.getrandbits(k);
    while (r >= n) r = this.getrandbits(k);
    return r;
  }

  /**
   * 等价 Python `randrange`（step=1）。
   *
   * 同时支持两种调用形式 —— Python 两种都有，而移植时极易只实现双参形式：
   *   - `randrange(stop)`      → 等价 `randrange(0, stop)`（gen_mock.py 用的就是这种）
   *   - `randrange(start, stop)`
   *
   * 只支持双参会埋一个**静默**的坑：`randrange(16**8)` 里 `b` 为 undefined，
   * `b - a` 变成 `NaN`，而 `randbelow(NaN)` 被「n 为假值即返回 0」的分支兜住，
   * 于是每次都返回 `stop` 本身 —— 值错、且不消耗熵。UUID 生成正好踩这条路径。
   */
  randrange(a: number, b?: number): number {
    if (b === undefined) return this.randbelow(a);
    return a + this.randbelow(b - a);
  }

  /** 等价 Python `randint(a, b)`（闭区间）。 */
  randint(a: number, b: number): number {
    return this.randrange(a, b + 1);
  }

  /** 等价 Python `choice(seq)`。 */
  choice<T>(seq: readonly T[] | string): T | string {
    const idx = this.randbelow(seq.length);
    return typeof seq === 'string' ? seq[idx] : (seq as readonly T[])[idx];
  }

  /** 等价 Python `choices(population, weights=..., k=1)[0]`（bisect_right 定位）。 */
  choicesWeighted<T>(population: readonly T[], weights: readonly number[]): T {
    const cum: number[] = [];
    let total = 0;
    for (const w of weights) {
      total += w;
      cum.push(total);
    }
    if (total <= 0) throw new Error('Total of weights must be greater than zero');
    const x = this.random() * total;
    let lo = 0;
    let hi = cum.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (x < cum[mid]) hi = mid;
      else lo = mid + 1;
    }
    return population[lo];
  }

  /** 等价 Python `uniform(a, b)`。 */
  uniform(a: number, b: number): number {
    return a + (b - a) * this.random();
  }

  /**
   * 等价 Python `gauss(mu, sigma)`（极坐标法 + 跨调用缓存）。
   * 注意 `gaussNext` 是**状态**：调用奇偶次会改变后续序列，不可省略。
   */
  gauss(mu = 0, sigma = 1): number {
    let z = this.gaussNext;
    this.gaussNext = null;
    if (z === null) {
      const x2pi = this.random() * TWOPI;
      const g2rad = Math.sqrt(-2.0 * Math.log(1.0 - this.random()));
      z = Math.cos(x2pi) * g2rad;
      this.gaussNext = Math.sin(x2pi) * g2rad;
    }
    return mu + z * sigma;
  }
}
