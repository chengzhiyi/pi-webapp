import React from "react";
import { createRoot } from "react-dom/client";
import "./ui/theme/base.css";
import "./ui/theme/design-platform.css";
import "./ui/theme/gradient-shadow-text.css";
import "./ui/theme/scrollbar.css";
import "./ui/theme/corner-shape.css";
import { PiApp } from "./PiApp.tsx";
import { installThemePreference } from "./ui/theme/preference.ts";
import { installLocalePreference } from "./ui/locale/preference.ts";

installThemePreference();
installLocalePreference();
const root = document.getElementById("root");
if (!root) throw new Error("Missing #root");
createRoot(root).render(<PiApp />);
