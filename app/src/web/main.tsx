import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import "./styles/app.css";
import "./styles/center.css";
import "./styles/motion.css";
import { ControlCenter } from "./center/ControlCenter";
import { VaultGate } from "./components/VaultGate";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <VaultGate>
      <ControlCenter />
    </VaultGate>
  </StrictMode>,
);
