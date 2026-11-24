import type { Server } from "node:http";
import { request as httpRequest } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { API_ROUTES, ONLINE_DEFAULTS, type LoginGate } from "../../server/core/auth";
import { failure, success } from "../../server/core/crm";
import type { AuthService } from "../../server/services/auth";
import { createOnlineServer } from "../../server/transport/http";

const gate: LoginGate = { allow: () => true };
const logger = { write: () => undefined };
const servers: Server[] = [];

async function start(ready: AuthService["ready"]) {
  const service = { ready } as AuthService;
  const server = createOnlineServer(service, gate, ONLINE_DEFAULTS, logger);
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing TCP address");
  return `http://127.0.0.1:${address.port}`;
}

async function response(base: string, path: string, method = "GET") {
  const result = await fetch(base + path, { method });
  return {
    status: result.status,
    contentType: result.headers.get("content-type"),
    text: await result.text(),
  };
}

async function responseWithHost(base: string, path: string, host: string) {
  const target = new URL(base + path);
  return new Promise<{ status: number; text: string }>((resolve, reject) => {
    const call = httpRequest({ hostname: target.hostname, port: target.port, path: target.pathname, method: "GET", headers: { host } }, result => {
      const chunks: Buffer[] = [];
      result.on("data", chunk => chunks.push(chunk as Buffer));
      result.on("end", () => resolve({ status: result.statusCode ?? 0, text: Buffer.concat(chunks).toString("utf8") }));
    });
    call.on("error", reject);
    call.end();
  });
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve, reject) => {
    server.closeAllConnections();
    server.close(error => error ? reject(error) : resolve());
  })));
});

describe("ACK operational HTTP compatibility", () => {
  it("serves readiness-backed actuator info for GET and HEAD", async () => {
    const base = await start(async () => success(undefined));

    const get = await response(base, "/actuator/info");
    expect(get).toMatchObject({
      status: 200,
      contentType: "application/json; charset=utf-8",
    });
    expect(JSON.parse(get.text)).toMatchObject({ status: "UP" });

    const head = await response(base, "/actuator/info", "HEAD");
    expect(head).toMatchObject({ status: 200, text: "" });
  });

  it("keeps HEAD actuator as a process heartbeat without readiness", async () => {
    const base = await start(async () => failure("UNAVAILABLE", "not ready"));

    expect(await response(base, "/actuator/info")).toMatchObject({ status: 503 });
    expect(await response(base, "/actuator/info", "HEAD")).toMatchObject({ status: 200, text: "" });
  });

  it("serves a valid minimal Prometheus exposition", async () => {
    const base = await start(async () => success(undefined));
    const metrics = await response(base, "/actuator/prometheus");

    expect(metrics).toMatchObject({
      status: 200,
      contentType: "text/plain; version=0.0.4; charset=utf-8",
    });
    expect(metrics.text).toContain("# TYPE prospector_center_up gauge\n");
    expect(metrics.text).toContain("prospector_center_up 1\n");
  });

  it("keeps the native health endpoints available", async () => {
    const base = await start(async () => success(undefined));

    expect(await response(base, API_ROUTES.live)).toMatchObject({ status: 200 });
    expect(await response(base, API_ROUTES.live, "HEAD")).toMatchObject({ status: 200, text: "" });
    expect(await response(base, API_ROUTES.ready)).toMatchObject({ status: 200 });
    expect(await response(base, API_ROUTES.ready, "HEAD")).toMatchObject({ status: 200, text: "" });
  });

  it("rejects a foreign Host by default but allows it when explicitly configured", async () => {
    const strict = await start(async () => success(undefined));
    expect(await responseWithHost(strict, "/actuator/prometheus", "foreign.example")).toMatchObject({ status: 403 });

    const service = { ready: async () => success(undefined) } as AuthService;
    const relaxed = createOnlineServer(service, gate, { ...ONLINE_DEFAULTS, allow_any_host: true }, logger);
    servers.push(relaxed);
    await new Promise<void>(resolve => relaxed.listen(0, "127.0.0.1", resolve));
    const address = relaxed.address();
    if (!address || typeof address === "string") throw new Error("missing TCP address");
    expect(await responseWithHost(`http://127.0.0.1:${address.port}`, "/actuator/prometheus", "foreign.example")).toMatchObject({ status: 200 });
  });
});
