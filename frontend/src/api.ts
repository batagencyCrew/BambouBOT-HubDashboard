const TOKEN_KEY = "bambou.access_token";
export const auth = {
  get: () => sessionStorage.getItem(TOKEN_KEY),
  set: (token: string) => sessionStorage.setItem(TOKEN_KEY, token),
  clear: () => sessionStorage.removeItem(TOKEN_KEY),
};

export async function api<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const headers = new Headers(options.headers);
  if (options.body) headers.set("Content-Type", "application/json");
  const token = auth.get();
  if (token && path !== "/auth/login")
    headers.set("Authorization", `Bearer ${token}`);
  const response = await fetch(`/api${path}`, {
    ...options,
    headers,
    signal: options.signal ?? AbortSignal.timeout(20000),
  });
  if (response.status === 401 && path !== "/auth/login") {
    auth.clear();
    window.dispatchEvent(new Event("bambou:unauthorized"));
    throw new Error("Your session expired. Please sign in again.");
  }
  if (!response.ok) {
    const body: unknown = await response.json().catch(() => null);
    let message = `Request failed (${response.status}). Please try again.`;
    if (body && typeof body === "object" && "detail" in body) {
      const detail = body.detail;
      if (typeof detail === "string") message = detail;
      else if (Array.isArray(detail)) {
        message = detail
          .map(
            (item: { msg?: string; loc?: string[] }) =>
              `${item.loc?.slice(1).join(".") || "Input"}: ${item.msg || "Invalid value"}`,
          )
          .join("; ");
      }
    }
    throw new Error(message);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

export const json = (method: string, body?: unknown): RequestInit => ({
  method,
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});
export const errorMessage = (error: unknown) =>
  error instanceof Error
    ? error.message
    : "Something went wrong. Please try again.";
