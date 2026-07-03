import { redirect } from "next/navigation";
import { ensureSchema, isPublicDashboard, listNodes, publicNodes } from "@/lib/db";
import { userCount } from "@/lib/auth";
import { currentUser } from "@/lib/session";
import type { NodeView } from "@/lib/types";
import Dashboard from "@/components/Dashboard";
import GuestLoginModal from "@/components/GuestLoginModal";

// SSR: render the first paint on the server with current data from Postgres,
// then the client component takes over and polls for live updates.
export const dynamic = "force-dynamic";

export default async function Page() {
  let initial: NodeView[] = [];
  let dbError: string | null = null;
  let needSetup = false;
  let authed = false;
  let isPublic = false;

  try {
    await ensureSchema();
    needSetup = (await userCount()) === 0;
    if (!needSetup) {
      authed = Boolean(await currentUser());
      isPublic = authed ? false : await isPublicDashboard();
      if (authed || isPublic) {
        const nodes = await listNodes();
        initial = authed ? nodes : publicNodes(nodes);
      }
    }
  } catch (err) {
    dbError = err instanceof Error ? err.message : "database unavailable";
  }

  // Brand-new install with no admin yet → guide to first-run setup.
  // redirect() must be called outside try/catch (it throws a control signal).
  if (needSetup) redirect("/setup");
  // Not signed in and the dashboard isn't public → require login. Skip on DB
  // error so an admin still lands on the dashboard's error screen.
  if (!authed && !isPublic && !dbError) redirect("/login");

  return (
    <>
      <Dashboard initial={initial} dbError={dbError} isPublic={isPublic} />
      {isPublic && <GuestLoginModal />}
    </>
  );
}
