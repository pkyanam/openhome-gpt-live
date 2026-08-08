import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { PairingApp } from "./PairingApp.tsx";
import "./styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("Missing #root mount point.");

const Page = window.location.pathname === "/setup" ? PairingApp : App;

createRoot(root).render(
  <StrictMode>
    <Page />
  </StrictMode>,
);
