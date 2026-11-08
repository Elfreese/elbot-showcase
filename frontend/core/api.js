export function createAPI({ getCredentials, getConnectionToken, onUnauthorized = () => {} }) {
  return async function request(path, { method = "GET", body, signal } = {}) {
    const credentials = getCredentials();
    if (!credentials) throw new Error("请先登录");
    const headers = { "X-Client-ID": credentials.clientID, Authorization: `Bearer ${credentials.token}` };
    const token = getConnectionToken();
    if (token) headers["X-CLI-Connection"] = token;
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const response = await fetch(`/api/v1${path}`, {
      method, headers, signal, cache: "no-store", ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const result = await response.json();
    if (!response.ok) {
      const error = new Error(result.error?.message || `请求失败（${response.status}）`);
      error.status = response.status;
      error.code = result.error?.code || "";
      if (response.status === 401) onUnauthorized();
      throw error;
    }
    return result;
  };
}
