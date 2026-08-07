import capstoneLogo from "@capstone/brand/assets/logos/capstone-primary.svg";
import { Link, Outlet } from "react-router";

import { copy } from "../copy";
import { ReadinessIndicator } from "../readiness-indicator";

export function IdentityLayout() {
  return (
    <div className="app-shell">
      <header className="site-header">
        <Link className="brand-link" to="/" aria-label={copy.brand.homeLabel}>
          <img className="brand-logo" src={capstoneLogo} alt="" />
        </Link>
        <ReadinessIndicator />
      </header>
      <main className="identity-main" id="main-content">
        <Outlet />
      </main>
    </div>
  );
}
