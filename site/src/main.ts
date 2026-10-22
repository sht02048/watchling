import "./style.css";
import defaults from "./config.json";
import { validateConfig } from "./config.ts";
import { mountSite } from "./desktop.ts";

const config = validateConfig(defaults);
if (!config) throw new Error("site/src/config.json is invalid");
mountSite(document.querySelector<HTMLElement>("#app")!, config);
