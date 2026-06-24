import { cookies } from "next/headers";
import { readSessionCookie, sessionUser, type User } from "./auth";

// currentUser reads the session cookie (works in route handlers and server
// components) and returns the authenticated admin, or null. Accepts either the
// __Host-wolf_session (HTTPS) or legacy wolf_session (HTTP) variant.
export async function currentUser(): Promise<User | null> {
  const store = await cookies();
  return sessionUser(readSessionCookie((n) => store.get(n)));
}
