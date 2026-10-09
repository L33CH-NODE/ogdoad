import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import "./styles/app.css";
import { Shell } from "./components/Shell";
import { VaultGate } from "./components/VaultGate";
import { match, usePath } from "./lib/router";
import { BankPage } from "./pages/Bank";
import { ClientPage, ClientsPage } from "./pages/Clients";
import { HomePage } from "./pages/Home";
import { InvoicePage } from "./pages/Invoice";
import { MoneyPage } from "./pages/Money";
import { SettingsPage } from "./pages/Settings";

function Routes() {
  const path = usePath();
  let params: Record<string, string> | null;
  if (path === "/") return <HomePage />;
  if (path === "/money") return <MoneyPage />;
  if ((params = match("/money/invoices/:id", path))) return <InvoicePage key={params.id} id={params.id} />;
  if (path === "/money/clients") return <ClientsPage />;
  if (path === "/money/bank") return <BankPage />;
  if ((params = match("/money/clients/:id", path))) return <ClientPage key={params.id} id={params.id} />;
  if (path === "/settings") return <SettingsPage />;
  return <div className="card">Nothing here. <a href="/">Go home</a>.</div>;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <VaultGate>
      <Shell>
        <Routes />
      </Shell>
    </VaultGate>
  </StrictMode>,
);
