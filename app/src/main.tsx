import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource/hanken-grotesk/400.css";
import "@fontsource/hanken-grotesk/500.css";
import "@fontsource/hanken-grotesk/600.css";
import "@fontsource/hanken-grotesk/700.css";
import "@fontsource/hanken-grotesk/800.css";
import "@fontsource/jetbrains-mono/400.css";
import "bootstrap-icons/font/bootstrap-icons.css";
import "./styles.css";
import App from "./Feed.tsx";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
