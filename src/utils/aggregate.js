/**
 * Tiny lodash-compatible aggregation helpers (sumBy / groupBy / countBy).
 *
 * lodash was never a declared dependency — it resolved only because
 * recharts@2 hoisted it. recharts@3 dropped lodash, exposing the phantom
 * import. These cover the exact iteratee forms the app uses (string key or
 * function) without re-adding the library.
 */

const toFn = (iteratee) =>
  typeof iteratee === 'function' ? iteratee : (item) => item?.[iteratee]

/** Sum of iteratee(item) over the array; non-numeric values count as 0. */
export function sumBy(arr, iteratee) {
  const fn = toFn(iteratee)
  let total = 0
  for (const item of arr ?? []) {
    const v = Number(fn(item))
    if (Number.isFinite(v)) total += v
  }
  return total
}

/** { key: [items...] } keyed by String(iteratee(item)). */
export function groupBy(arr, iteratee) {
  const fn = toFn(iteratee)
  const out = {}
  for (const item of arr ?? []) {
    const k = String(fn(item))
    ;(out[k] ??= []).push(item)
  }
  return out
}

/** { key: count } keyed by String(iteratee(item)). */
export function countBy(arr, iteratee) {
  const fn = toFn(iteratee)
  const out = {}
  for (const item of arr ?? []) {
    const k = String(fn(item))
    out[k] = (out[k] ?? 0) + 1
  }
  return out
}
