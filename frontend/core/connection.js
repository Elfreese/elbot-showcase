export function createConnection({ onMessage, onStateChange, onAuthenticated, onAuthenticationError }) {
  // 两类连接凭据只属于当前 WebSocket，不能持久化。
  const state = { ready: false, generation: 0, credentials: null, mediaToken: "", apiToken: "" };
  let socket = null;
  let retry = null;
  let timeout = null;
  let attempt = 0;
  let closing = false;

  function publish(label) { onStateChange({ ...state, label }); }

  function clearConnection() {
    state.ready = false;
    state.mediaToken = "";
    state.apiToken = "";
    clearTimeout(timeout);
  }

  function connect(credentials) {
    clearTimeout(retry);
    clearTimeout(timeout);
    const generation = ++state.generation;
    socket?.close();
    clearConnection();
    closing = false;
    state.credentials = credentials;
    publish(attempt ? "重连中" : "连接中");
    const address = new URL("/cli/v1/ws", location.href);
    address.protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const current = new WebSocket(address);
    socket = current;
    let authenticated = false;
    let rejected = false;
    timeout = setTimeout(() => current.close(), 12000);
    current.addEventListener("open", () => {
      if (generation !== state.generation) return;
      current.send(JSON.stringify({ type: "hello", client_id: credentials.clientID, token: credentials.token }));
    });
    current.addEventListener("message", event => {
      if (generation !== state.generation) return;
      const message = JSON.parse(event.data);
      if (message.type === "hello_ok") {
        clearTimeout(timeout);
        authenticated = true;
        attempt = 0;
        state.ready = true;
        state.mediaToken = message.media_token;
        state.apiToken = message.api_token;
        publish("已连接");
        onAuthenticated(credentials);
      } else if (!authenticated && message.type === "error") {
        rejected = true;
        state.credentials = null;
        clearConnection();
        publish("认证失败");
        onAuthenticationError(message.text || "认证失败，请检查 ID / Token");
        current.close();
      } else if (authenticated) onMessage(message);
    });
    current.addEventListener("close", () => {
      if (generation !== state.generation) return;
      clearConnection();
      if (closing || rejected || !state.credentials) { publish("未连接"); return; }
      publish("重连中");
      retry = setTimeout(() => connect(credentials), Math.min(1000 * 2 ** attempt++, 10000));
    });
  }

  function disconnect() {
    closing = true;
    clearTimeout(retry);
    state.generation++;
    state.credentials = null;
    clearConnection();
    socket?.close();
    socket = null;
    attempt = 0;
    publish("未连接");
  }

  function send(message) {
    if (!state.ready) throw new Error("未连接，消息未发送");
    socket.send(JSON.stringify(message));
  }

  return { state, connect, disconnect, send };
}
