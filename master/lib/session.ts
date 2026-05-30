import { cookies } from "next/headers";
import { SESSION_COOKIE, sessionUser, type User } from "./auth";

// currentUser reads the session cookie (works in route handlers and server
// components) and returns the authenticated admin, or null.
export async function currentUser(): Promise<User | null> {
  const store = await cookies();
  return sessionUser(store.get(SESSION_COOKIE)?.value);
}
