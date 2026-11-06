import { server, setup } from "./plugin.js";
// The V2 loader requires a default `{ id, setup }`; the V1 loader reads `server`.
// `server` is deliberately not a named export so the V1 loader sees one plugin.
export default { id: "opencode-plugin-memory", server, setup };
//# sourceMappingURL=index.js.map