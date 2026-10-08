import "./styles.css";
import { startApp } from "./ui/app.ts";

// A WebSocket override is honoured only in the e2e build (VITE_E2E=1), never in
// the published app: pointing a real wallet at an untrusted server would let it
// collect valid Derive order signatures.
const params = new URLSearchParams(location.search);
const wsOverride = import.meta.env.VITE_E2E === "1" ? params.get("ws") : null;

startApp({ wsOverride });
