const key = "elbot.credentials";

export function readCredentials(onError = () => {}) {
  try {
    const value = localStorage.getItem(key);
    if (!value) return null;
    const credentials = JSON.parse(value);
    if (typeof credentials.clientID !== "string" || !credentials.clientID || typeof credentials.token !== "string" || !credentials.token) {
      throw new Error("登录信息无效，请重新登录");
    }
    return credentials;
  } catch (error) {
    onError(error);
    return null;
  }
}

export function saveCredentials(credentials, onError = () => {}) {
  try {
    if (credentials) localStorage.setItem(key, JSON.stringify(credentials));
    else localStorage.removeItem(key);
    return true;
  } catch (error) {
    onError(error);
    return false;
  }
}
