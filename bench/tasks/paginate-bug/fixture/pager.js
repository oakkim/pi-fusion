export function page(items, n, per) {
  const start = (n - 1) * per;
  return items.slice(start, start + per - 1);
}
