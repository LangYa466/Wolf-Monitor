import { redirect } from "next/navigation";
import { ensureSchema, listNodes } from "@/lib/db";
import { userCount } from "@/lib/auth";
import type { NodeView } from "@/lib/types";
import Dashboard from "@/components/Dashboard";

// SSR: render the first paint on the server with current data from Postgres,
// then the client component takes over and polls for live updates.
export const dynamic = "force-dynamic";

export default async function Page() {
  let initial: NodeView[] = [];
  let dbError: string | null = null;
  let needSetup = false;
  try {
    await ensureSchema();
    needSetup = (await userCount()) === 0;
    if (!needSetup) initial = await listNodes();
  } catch (err) {
    dbError = err instanceof Error ? err.message : "database unavailable";
  }

  // Brand-new install with no admin yet → guide to first-run setup.
  // redirect() must be called outside try/catch (it throws a control signal).
  if (needSetup) redirect("/setup");

  return <Dashboard initial={initial} dbError={dbError} />;
}
