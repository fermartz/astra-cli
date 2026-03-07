import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./styles/globals.css";
import "./styles/themes/perpetuity.css";
import "./styles/themes/cosmic-night.css";
import "./styles/themes/vercel.css";
import "./styles/themes/ocean-breeze.css";
import "./styles/themes/cyberpunk.css";
import "./styles/themes/cyber-wave.css";
import { applyTheme, getSavedTheme, getSavedMode } from "./lib/themes";

// Apply theme before first render to prevent flash
applyTheme(getSavedTheme(), getSavedMode());

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
