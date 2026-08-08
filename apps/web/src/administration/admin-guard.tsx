import type { SessionResponse } from "@capstone/protocol";
import { Navigate, Outlet, useOutletContext } from "react-router";

export function AdminGuard() {
  const session = useOutletContext<SessionResponse>();
  if (session.workspace.role !== "admin") {
    return <Navigate to="/" replace />;
  }
  return <Outlet context={session} />;
}
