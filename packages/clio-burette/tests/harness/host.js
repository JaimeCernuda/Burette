// A minimal MCP Apps host for checking the Burette views: it loads a view
// resource into a frame, passes tool input and results, routes the view's
// tools/call and resources/read to the server, records ui/update-model-context,
// and calls the view's own app tools. It plays CLIO's part for the loopback
// service: the frame gets hostContext["ai.iowarp.clio/service"].url on the same
// origin, which the harness server proxies with the bearer token.
import { AppBridge, PostMessageTransport } from "@modelcontextprotocol/ext-apps/app-bridge";

const params = new URLSearchParams(location.search);
const withService = params.get("service") !== "0";

async function rpc(method, body) {
  const response = await fetch("/rpc", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ method, params: body }) });
  const answer = await response.json();
  if (answer.error) throw new Error(answer.error);
  return answer.result;
}

const harness = {
  contexts: [],
  serverCalls: [],
  bridge: null,
  ready: null,
  async open(name, args, { height = 560 } = {}) {
    const result = await rpc("tools/call", { name, arguments: args });
    const uri = result.resourceUri;
    const frame = document.createElement("iframe");
    frame.style.cssText = `width:100%;height:${height}px;border:1px solid #ccc;border-radius:8px;display:block`;
    frame.src = `/view?uri=${encodeURIComponent(uri)}`;
    document.getElementById("views").replaceChildren(frame);
    const hostContext = {
      theme: "light",
      displayMode: "inline",
      ...(withService ? { "ai.iowarp.clio/service": { url: `${location.origin}/service/` } } : {}),
    };
    const bridge = new AppBridge(null, { name: "burette-harness", version: "0" }, {
      serverTools: {}, serverResources: {}, logging: {}, openLinks: {},
      updateModelContext: { text: {}, structuredContent: {} },
    }, { hostContext });
    bridge.oncalltool = async (call) => {
      harness.serverCalls.push(call.name);
      const answer = await rpc("tools/call", call);
      delete answer.resourceUri;
      return answer;
    };
    bridge.onreadresource = (request) => rpc("resources/read", request);
    bridge.onupdatemodelcontext = async (context) => {
      harness.contexts.push(context);
      document.getElementById("context").textContent = JSON.stringify(context, null, 1).slice(0, 4000);
      return {};
    };
    bridge.onsizechange = ({ height: h }) => { if (h) frame.style.height = `${Math.min(Math.max(h, 200), 900)}px`; };
    harness.ready = new Promise((resolve) => {
      bridge.oninitialized = async () => {
        await bridge.sendToolInput({ arguments: args });
        delete result.resourceUri;
        await bridge.sendToolResult(result);
        resolve(true);
      };
    });
    harness.bridge = bridge;
    await bridge.connect(new PostMessageTransport(frame.contentWindow, frame.contentWindow));
    await harness.ready;
    return result;
  },
  /** A server tool called for the open view (as CLIO's A2UI channel does): the view gets input and result. */
  async callServerToolForView(name, args) {
    const result = await rpc("tools/call", { name, arguments: args });
    delete result.resourceUri;
    await harness.bridge.sendToolInput({ arguments: args });
    await harness.bridge.sendToolResult(result);
    return result;
  },
  callAppTool(name, args) {
    return harness.bridge.callTool({ name, arguments: args });
  },
  listAppTools() {
    return harness.bridge.listTools({});
  },
  lastContext() {
    return harness.contexts.at(-1) ?? null;
  },
};
window.harness = harness;
