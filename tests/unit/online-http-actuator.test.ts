import type { Server } from "node:http";
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
    expect(JSON.parse(get.text)).toEqual({ status: "UP" });

    const head = await response(base, "/actuator/info", "HEAD");
    expect(head).toMatchObject({ status: 200, text: "" });
  });

  it("fails actuator info closed when the center is not ready", async () => {
    const base = await start(async () => failure("UNAVAILABLE", "not ready"));

    expect(await response(base, "/actuator/info")).toMatchObject({ status: 503 });
    expect(await response(base, "/actuator/info", "HEAD")).toMatchObject({ status: 503, text: "" });
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
    expect(await response(base, API_ROUTES.ready)).toMatchObject({ status: 200 });
  });
});
