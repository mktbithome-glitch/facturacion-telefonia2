import type { AppConfig } from "./config.js";

type Json = Record<string, unknown>;

export class NexlinkClient {
  private token?: string;
  constructor(private readonly config: AppConfig) {
    this.token = config.NEXLINK_AUTH_TOKEN;
  }

  configured() {
    return Boolean(this.token || (this.config.NEXLINK_USERNAME && this.config.NEXLINK_PASSWORD));
  }

  private async authenticate() {
    if (this.token) return this.token;
    if (!this.config.NEXLINK_USERNAME || !this.config.NEXLINK_PASSWORD) {
      throw new Error("Nexlink no está configurado");
    }
    const response = await fetch(`${this.config.NEXLINK_BASE_URL}/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: this.config.NEXLINK_USERNAME, password: this.config.NEXLINK_PASSWORD })
    });
    if (!response.ok) throw new Error(`Nexlink login respondió ${response.status}`);
    const value = await response.json();
    this.token = typeof value === "string" ? value : String((value as Json).token ?? "");
    if (!this.token) throw new Error("Nexlink no devolvió un token");
    return this.token;
  }

  private async post<T>(path: string, body: Json, retry = true): Promise<T> {
    const token = await this.authenticate();
    const response = await fetch(`${this.config.NEXLINK_BASE_URL}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", "X-Auth-Token": token },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000)
    });
    if (response.status === 401 && retry && !this.config.NEXLINK_AUTH_TOKEN) {
      this.token = undefined;
      return this.post<T>(path, body, false);
    }
    if (!response.ok) {
      const detail = await response.text();
      throw new Error(`Nexlink ${path} respondió ${response.status}: ${detail.slice(0, 300)}`);
    }
    return response.json() as Promise<T>;
  }

  async listAll(path: "/services/list" | "/cdrs/calls" | "/invoices/list", filters: Json[] = []) {
    const items: Json[] = [];
    let page = 1;
    while (true) {
      const result = await this.post<Json>(path, { page, rows_per_page: 50, filters });
      const batch = Array.isArray(result.items) ? result.items as Json[] : [];
      items.push(...batch);
      const total = Number(result.total_rows ?? items.length);
      if (!batch.length || items.length >= total) break;
      page += 1;
    }
    return items;
  }

  async listProducts() {
    const products: Json[] = [];
    let page = 1;
    while (true) {
      const result = await this.post<Json>("/products/list", { page, rows_per_page: 50, sort: "id", sort_type: "asc" });
      const batch = Array.isArray(result.items) ? result.items as Json[] : Array.isArray(result) ? result as Json[] : [];
      products.push(...batch);
      const total = Number(result.total_rows ?? products.length);
      if (!batch.length || products.length >= total) break;
      page += 1;
    }
    return products;
  }
}
