import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { API_ROUTES, HTTP_STATUS, type OnlineConfig, type LoginGate } from "../core/auth";
import { success, failure, type Result, type LogSink } from "../core/crm";
import type { AuthService } from "../services/auth";

const MILLISECONDS_PER_SECOND = 1000;
export function send(response: ServerResponse, result: Result<unknown>) {
  if(response.destroyed || response.writableEnded) return;
  response.writeHead(result.ok ? HTTP_STATUS.OK : HTTP_STATUS[result.error.code], {
    "Content-Type":"application/json; charset=utf-8", "Cache-Control":"no-store",
    "X-Content-Type-Options":"nosniff", "Connection":"close",
  });
  response.end(JSON.stringify(result));
}
export async function body(request: IncomingMessage, maximum: number): Promise<Result<unknown>> {
  if(request.headers["content-type"]?.split(";")[0]?.trim() !== "application/json") return failure("INVALID_INPUT","需要 JSON 请求");
  const declared = Number(request.headers["content-length"] ?? 0);
  if(!Number.isSafeInteger(declared) || declared<0) return failure("INVALID_INPUT","请求长度无效");
  return new Promise(resolve => {
    const chunks: Buffer[] = []; let size = 0, finished = false, exceeded = declared>maximum;
    const finish = (result: Result<unknown>) => { if(!finished) { finished=true; resolve(result); } };
    request.on("data", (chunk: Buffer) => {
      if(finished || exceeded) return;
      size+=chunk.length;
      if(size>maximum) { exceeded=true; chunks.length=0; }
      else chunks.push(chunk);
    });
    request.on("end", () => {
      if(finished) return;
      // Discard excess data until the upload ends, within the server request timeout.
      // Closing while the client is still writing can reset the socket before it reads 413.
      if(exceeded) { finish(failure("PAYLOAD_TOO_LARGE","请求体超限")); return; }
      try { finish(success(JSON.parse(Buffer.concat(chunks).toString("utf8")))); }
      catch { finish(failure("INVALID_INPUT","JSON 格式无效")); } // no submitted body in logs
    });
    request.on("error", () => finish(failure("INVALID_INPUT","请求中断")));
    request.on("aborted", () => finish(failure("INVALID_INPUT","请求中断")));
  });
}
export type BrowserHandler = (request: IncomingMessage, response: ServerResponse) => Promise<void>;
export function createOnlineServer(service: AuthService, gate: LoginGate, config: OnlineConfig, log: LogSink, instanceId = "integration", browser?: BrowserHandler, crm?: BrowserHandler, desktop?: BrowserHandler) {
  const dispatch = async (request: IncomingMessage, response: ServerResponse) => {
    const path = request.url ?? "", method = request.method;
    const expectedHost = `${request.socket.localAddress}:${request.socket.localPort}`;
    if(request.headers.host !== expectedHost) { send(response,failure("FORBIDDEN","测试服务 Host 无效")); return; }
    if(browser && (path.startsWith('/admin-api/') || path === '/' || path.startsWith('/?') || path.startsWith('/assets/'))) {await browser(request,response);return;}
    if(request.headers.origin || request.headers["sec-fetch-site"] === "cross-site") { send(response,failure("FORBIDDEN","当前仅接受本机非浏览器跨站请求")); return; }
    if(desktop && path.startsWith('/api/auth/desktop/')) { await desktop(request,response); return; }
    if(crm && path.startsWith('/api/crm/') && path !== API_ROUTES.crmAccess) { await crm(request,response); return; }
    const authorization = request.headers.authorization ?? "";
    const token = /^Bearer ([A-Za-z0-9_-]+)$/.exec(authorization)?.[1] ?? "";
    let result: Result<unknown>;
    if(method === "GET" && path === API_ROUTES.live) result = success({status:"live",instanceId,pid:process.pid});
    else if(method === "GET" && path === API_ROUTES.ready) result = await service.ready();
    else if(method === "POST" && path === API_ROUTES.login) {
      const input = await body(request,config.request_body_bytes);
      if(!input.ok) result=input;
      else {
        const email = input.data && typeof input.data==="object" && "email" in input.data && typeof input.data.email==="string" ? input.data.email.trim().toLowerCase() : "invalid";
        result = gate.allow(email,request.socket.remoteAddress ?? "unknown") ? await service.login(input.data) : failure("RATE_LIMITED","登录尝试过多，请稍后重试");
      }
    } else if(method === "GET" && path === API_ROUTES.me) result = await service.me(token);
    else if(method === "POST" && path === API_ROUTES.logout) result = await service.logout(token);
    else if(method === "GET" && path === API_ROUTES.users) result = await service.users(token);
    else if(method === "GET" && path === API_ROUTES.crmAccess) result = await service.crmAccess(token);
    else if(method === "GET" && path === API_ROUTES.navigatorAccess) result = await service.navigatorAccess(token);
    else result = failure("NOT_FOUND","接口不存在");
    send(response,result);
  };
  const server = createServer((request,response) => {
    void dispatch(request,response).catch(() => {
      log.write("ERROR","identity.http","请求处理失败，拒绝响应业务数据");
      send(response,failure("UNAVAILABLE","服务暂不可用"));
    });
  });
  server.requestTimeout = config.request_timeout_seconds*MILLISECONDS_PER_SECOND;
  server.headersTimeout = config.request_timeout_seconds*MILLISECONDS_PER_SECOND;
  server.timeout = config.request_timeout_seconds*MILLISECONDS_PER_SECOND;
  return server;
}
