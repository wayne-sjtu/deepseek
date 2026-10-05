/**
 * `pyrandom.ts` / `pyround.ts` 的回归测试。
 *
 * 为什么这两个模块值得专门测试
 * ---------------------------
 * 它们是**静默失败**的典型：算错了不会报任何错，只会让看板上的数字悄悄变化。
 * 这里的期望值不是「我觉得对」，而是从 CPython 实测导出的 **IEEE754 位模式**，
 * 用 `doubleBits()` 做位级断言。
 *
 * 运行：npm test
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { PyRandom, doubleBits } from './pyrandom.ts';
import { pyRound, round0, round1, round2 } from './pyround.ts';

/** gen_mock.py 使用的种子。 */
const SEED = 20260920;

// ---------------------------------------------------------------------------
// PyRandom：期望值由 CPython 3.13 的 random.Random(20260920) 实测导出
// ---------------------------------------------------------------------------
test('random() 与 Python 逐位一致', () => {
  const rng = new PyRandom(SEED);
  const expected = [
    '3fe2c3cea287987c',
    '3fe6b6c57d1efca7',
    '3fc0594e673e63c0',
    '3fecd494eb417fba',
    '3fda3d216ac5e70a',
    '3fcee1591f52241c',
  ];
  const actual = expected.map(() => doubleBits(rng.random()));
  assert.deepEqual(actual, expected);
});

test('uniform() 与 Python 逐位一致', () => {
  const rng = new PyRandom(SEED);
  const expected = [
    '4018c3cea287987c',
    '401cb6c57d1efca7',
    '40042ca7339f31e0',
    '40216a4a75a0bfdd',
    '40131e90b562f385',
    '400b70ac8fa9120e',
  ];
  const actual = expected.map(() => doubleBits(rng.uniform(1.5, 9.5)));
  assert.deepEqual(actual, expected);
});

test('getrandbits / randrange / choice 与 Python 一致', () => {
  const r8 = new PyRandom(SEED);
  assert.deepEqual([0, 1, 2, 3, 4, 5].map(() => r8.getrandbits(8)), [150, 161, 181, 71, 32, 115]);

  const rr = new PyRandom(SEED);
  assert.deepEqual([0, 1, 2, 3, 4, 5].map(() => rr.randrange(10, 100)), [85, 90, 45, 26, 67, 62]);

  const rc = new PyRandom(SEED);
  const picked = [0, 1, 2, 3, 4, 5].map(() => rc.choice('abcde'));
  assert.deepEqual(picked, ['e', 'c', 'b', 'd', 'd', 'c']);
});

test('choicesWeighted 与 Python rng.choices 一致', () => {
  const rng = new PyRandom(SEED);
  const picked = [0, 1, 2, 3, 4, 5].map(() =>
    rng.choicesWeighted(['a', 'b', 'c', 'd', 'e'], [1, 2, 3, 4, 5]),
  );
  // 对应 Python: rng.choices("abcde", weights=[1,2,3,4,5], k=1) 的连续 6 次
  assert.deepEqual(picked, ['d', 'e', 'b', 'e', 'd', 'c']);
});

test('gauss() 与 Python 逐位一致（含跨调用状态缓存）', () => {
  const rng = new PyRandom(SEED);
  const expected = [
    '4046f06763b2d285',
    '404957d6fdc8ba9e',
    '4051dcb8c3e015cc',
    '4051fab77daf93ab',
    '404a2d489ff71195',
    '404ecac5214f9664',
  ];
  const actual = expected.map(() => doubleBits(rng.gauss(58, 9)));
  assert.deepEqual(actual, expected);
});

test('同种子可复现，异种子不可复现', () => {
  const a = new PyRandom(SEED);
  const b = new PyRandom(SEED);
  const c = new PyRandom(SEED + 1);
  const seqA = [0, 1, 2, 3].map(() => a.random());
  const seqB = [0, 1, 2, 3].map(() => b.random());
  const seqC = [0, 1, 2, 3].map(() => c.random());
  assert.deepEqual(seqA, seqB, '同种子必须产出相同序列');
  assert.notDeepEqual(seqA, seqC, '异种子应产出不同序列');
});

// ---------------------------------------------------------------------------
// 回归：大范围 RNG（getrandbits(k>32) 与 n >= 2**32）
//
// 这两条曾经是测试盲区 —— 只测 getrandbits(8) / randrange(10, 100) 这类小范围
// 完全覆盖不到，而 gen_mock.py 生成 UUID 用的恰恰是 `randrange(16**8)` 与
// `randrange(16**12)`。曾出现过的两个真实 bug：
//
//   1. 位长用 `32 - Math.clz32(n)` 实现。n = 2**32 时 ToUint32 → 0，
//      clz32(0) = 32，于是 k = 0 → `getrandbits(0)` 返回 0 **且不消耗任何熵**，
//      后果是 `randrange(16**8)` 恒为 0，且整条随机序列从此与 CPython 脱轨。
//   2. `getrandbits(k>32)` 把整块拼起来再整体右移；CPython 是**按字拼接、
//      只有最后一个字右移**（`words = (k-1)/32 + 1`），两者位序不同、值不同。
//
// 期望值均从 CPython 3.13 实测导出，不是推导出来的。
// ---------------------------------------------------------------------------
test('getrandbits(k>32)：按字拼接、只移最后一个字，与 Python 一致', () => {
  const cases: Array<[number, string[]]> = [
    [33, ['6813545748', '3048614886', '548576473', '8164517705', '1760855471']],
    [47, ['89007125853460', '39443733294054', '63716388412633', '114554942302025', '48783999403439']],
    [49, ['356020947678484', '157774377266150', '254863907921113', '458221045458761', '195135010014639']],
    [52, ['2848154246346004', '1262182267759590', '2038920308235481', '3665767046621001', '1561093523932591']],
    [53, ['5696310269080852', '2524365781871590', '4077844362861785', '7331534518658889', '3122185287009711']],
  ];
  for (const [k, expected] of cases) {
    const rng = new PyRandom(SEED);
    const got = expected.map(() => String(rng.getrandbits(k)));
    assert.deepEqual(got, expected, `getrandbits(${k}) 与 Python 不一致`);
  }
});

test('randrange 支持 n >= 2**32（UUID 生成路径）', () => {
  const r32 = new PyRandom(SEED);
  assert.deepEqual(
    [0, 1, 2, 3, 4].map(() => String(r32.randrange(0, 2 ** 32))),
    ['3048614886', '548576473', '1760855471', '1881884024', '90830183'],
  );

  const r48 = new PyRandom(SEED);
  assert.deepEqual(
    [0, 1, 2, 3, 4].map(() => String(r48.randrange(0, 2 ** 48))),
    [
      '157774377266150',
      '254863907921113',
      '195135010014639',
      '195268275029368',
      '71202058663271',
    ],
  );
});

test('randrange 单参形式等价 randrange(0, stop)，且必须真的消耗熵', () => {
  const a = new PyRandom(SEED);
  const b = new PyRandom(SEED);
  assert.deepEqual(
    [0, 1, 2, 3, 4].map(() => a.randrange(2 ** 48)),
    [0, 1, 2, 3, 4].map(() => b.randrange(0, 2 ** 48)),
  );

  // 只实现双参形式时会静默返回 stop 本身，这里正面钉住该失败模式
  const r = new PyRandom(SEED);
  const vals = [0, 1, 2, 3, 4].map(() => r.randrange(2 ** 32));
  assert.equal(new Set(vals).size, 5, '单参 randrange 必须产出互不相同的值');
  assert.ok(
    vals.every((v) => v < 2 ** 32),
    'randrange(2**32) 的结果必须严格小于 2**32',
  );
});

test('randint 大区间与 Python 一致', () => {
  const r = new PyRandom(SEED);
  assert.deepEqual(
    [0, 1, 2, 3, 4].map(() => String(r.randint(10 ** 14, 10 ** 15))),
    [
      '812039376778516',
      '415545705917414',
      '609727267265753',
      '490272554141103',
      '490538963142008',
    ],
  );
});

test('getrandbits 的精度边界停在 k=53（超出即丢精度，属已知边界）', () => {
  // k <= 53 时结果必定落在 double 安全整数范围内
  const rng = new PyRandom(SEED);
  for (const k of [33, 47, 49, 52, 53]) {
    const v = rng.getrandbits(k);
    assert.ok(Number.isSafeInteger(v), `getrandbits(${k}) 应在安全整数范围内`);
  }
  // gen_mock.py 实际最大用到 49 位（randrange(16**12)），在边界内
  const r49 = new PyRandom(SEED);
  assert.ok(Number.isSafeInteger(r49.getrandbits(49)));
});

// ---------------------------------------------------------------------------
// pyRound：期望值为 CPython round() 的实测结果
// ---------------------------------------------------------------------------
test('round 是银行家舍入，不是 half-up', () => {
  // Python: round(0.125, 2) == 0.12；朴素 Math.round(0.125*100)/100 == 0.13
  assert.equal(round2(0.125), 0.12);
  assert.equal(round2(0.375), 0.38);
  assert.equal(round2(0.625), 0.62);
  assert.equal(round2(0.875), 0.88);
  assert.equal(round2(-0.125), -0.12);
});

test('round 在精确十进制上舍入，不被浮点乘法带偏', () => {
  // 2.675 的双精度值实际略小于 2.675 → Python 得 2.67，朴素写法得 2.68
  assert.equal(round2(2.675), 2.67);
  // 123456.785 的双精度值实际略大于 .785 → Python 得 123456.79
  // （注意：这里不能想当然按「四舍五入 .785 -> .78」，必须以 CPython 实测为准）
  assert.equal(round2(123456.785), 123456.79);
});

test('round(x) / round(x, 1) 对齐 Python', () => {
  assert.equal(round0(2.5), 2); // Python round(2.5) == 2
  assert.equal(round0(1.5), 2);
  assert.equal(round0(-2.5), -2);
  assert.equal(round1(0.25), 0.2); // Python round(0.25, 1) == 0.2
  assert.equal(round1(0.35), 0.3); // 0.35 的双精度值略小于 0.35
});

test('密集采样：pyRound 与 CPython 位级一致', () => {
  // 期望值来自 CPython：对同一批输入跑 round(x, 2)，导出位模式
  const inputs = [0.125, 0.375, 0.625, 0.875, 2.5, -2.5, 1.5, 2.675, 1.005, 0.615, 123456.785];
  const pythonBits = [
    '3fbeb851eb851eb8', // 0.125 -> 0.12
    '3fd851eb851eb852', // 0.375 -> 0.38
    '3fe3d70a3d70a3d7', // 0.625 -> 0.62
    '3fec28f5c28f5c29', // 0.875 -> 0.88
    '4004000000000000', // 2.5   -> 2.5
    'c004000000000000', // -2.5  -> -2.5
    '3ff8000000000000', // 1.5   -> 1.5
    '40055c28f5c28f5c', // 2.675 -> 2.67
    '3ff0000000000000', // 1.005 -> 1.0
    '3fe3851eb851eb85', // 0.615 -> 0.61
    '40fe240ca3d70a3d', // 123456.785 -> 123456.79
  ];
  const actual = inputs.map((x) => doubleBits(round2(x)));
  assert.deepEqual(actual, pythonBits);
});

test('pyRound 拒绝未支持的负数位数而不是给错答案', () => {
  assert.throws(() => pyRound(123.456, -1), RangeError);
});

test('非有限值原样返回', () => {
  assert.ok(Number.isNaN(round2(Number.NaN)));
  assert.equal(round2(Number.POSITIVE_INFINITY), Number.POSITIVE_INFINITY);
});
