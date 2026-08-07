import capstoneLogo from "@capstone/brand/assets/logos/capstone-primary.svg";
import type { ReactNode } from "react";
import { Link, Outlet } from "react-router";

import { copy } from "../copy";
import { ReadinessIndicator } from "../readiness-indicator";

export function IdentityFrame({ children }: { readonly children: ReactNode }) {
  return (
    <div className="app-shell">
      <header className="site-header">
        <Link className="brand-link" to="/" aria-label={copy.brand.homeLabel}>
          <img className="brand-logo" src={capstoneLogo} alt="" />
        </Link>
        <ReadinessIndicator />
      </header>
      <main className="identity-main" id="main-content">
        {children}
      </main>
    </div>
  );
}

export function IdentityLayout() {
  return (
    <IdentityFrame>
      <Outlet />
    </IdentityFrame>
  );
}
