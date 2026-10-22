import "@/styles/global.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Site } from "@/app/Site.tsx";
import defaults from "@/config/config.json";
import { validateConfig } from "@/config/config.ts";

const config = validateConfig(defaults);
if (!config) throw new Error("site/src/config/config.json is invalid");

createRoot(document.querySelector("#app")!).render(
  <StrictMode>
    <Site config={config} />
  </StrictMode>,
);
