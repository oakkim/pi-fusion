const store = { a: 1, b: 2, c: 3 };

export function fetchData(key) {
  return store[key] ?? null;
}
