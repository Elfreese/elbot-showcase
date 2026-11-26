export function createAPI(getConnectionToken) {
  return async function request(path, { method = "GET", body, signal } = {}) {
    const token = getConnectionToken();
    if (!token) throw new Error("未连接，管理请求未发送");
    const headers = { Authorization: `Bearer ${token}` };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const response = await fetch(`/api/v1${path}`, {
      method, headers, signal, cache: "no-store", ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (response.status === 204) return;
    const result = await response.json();
    if (!response.ok) {
      const error = new Error(result.error?.message || `请求失败（${response.status}）`);
      error.status = response.status;
      error.code = result.error?.code || "";
      throw error;
    }
    return result;
  };
}
