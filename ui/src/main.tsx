import React from "react";
import ReactDOM from "react-dom/client";
import "katex/dist/katex.min.css";
import App from "./App";
import "./styles/app.css";

if (!("global" in globalThis)) {
  Object.defineProperty(globalThis, "global", {
    value: globalThis,
    configurable: true,
  });
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
