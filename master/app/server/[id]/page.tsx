import { redirect, notFound } from "next/navigation";
import { ensureSchema, isPublicDashboard, listNodes, publicNodes } from "@/lib/db";
import { userCount } from "@/lib/auth";
import { currentUser } from "@/lib/session";
import type { NodeView } from "@/lib/types";
import ServerDetail from "@/components/ServerDetail";
import GuestLoginModal from "@/components/GuestLoginModal";

export const dynamic = "force-dynamic";

export default async function ServerPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id: raw } = await params;
  const id = decodeURIComponent(raw); // opaque (encrypted) id from the URL

  let node: NodeView | null = null;
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
        const all = await listNodes();
        const found = all.find((n) => n.opaqueId === id) ?? null;
        node = found && !authed ? publicNodes([found])[0] : found;
      }
    }
  } catch (err) {
    dbError = err instanceof Error ? err.message : "database unavailable";
  }

  if (needSetup) redirect("/setup");
  if (!authed && !isPublic && !dbError) redirect("/login");
  if (!node && !dbError) notFound();

  return (
    <>
      <ServerDetail id={id} initial={node} dbError={dbError} isPublic={isPublic} />
      {isPublic && <GuestLoginModal />}
    </>
  );
}
