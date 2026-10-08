import "./styles.css";
import { startApp } from "./ui/app.ts";

// A WebSocket override is honoured only in the e2e build (VITE_E2E=1), never in
// the published app: pointing a real wallet at an untrusted server would let it
// collect valid Derive order signatures.
const params = new URLSearchParams(location.search);
const e2e = import.meta.env.VITE_E2E === "1";
const wsOverride = e2e ? params.get("ws") : null;
const hlOverride = e2e ? params.get("hl") : null;
const vrOverride = e2e ? params.get("vr") : null;

startApp({ wsOverride, hlOverride, vrOverride });
