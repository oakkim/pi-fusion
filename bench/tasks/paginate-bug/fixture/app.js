import { users } from "./db.js";
import { page } from "./pager.js";

export function getPage(n) {
  return page(users, n, 3);
}
