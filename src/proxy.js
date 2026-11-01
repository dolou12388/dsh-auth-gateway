/**
 * 到 DSH 的反向代理。
 *
 * 两个必须做对的点（否则表现为「页面能开、什么都点不动」）：
 *
 *   1. **Host 头原样透传**。DSH 把 authority 用 HMAC 签进 cookie
 *      （`payload.authority !== authority` 直接拒），并用 Host 头做
 *      DNS-rebinding 围栏。代理改写 Host 会导致 cookie 失效 + API 403。
 *
 *   2. **WebSocket upgrade 透传**。前端实时通道走 `/api/remote.mux`，
 *      漏了这步页面能开、能看到历史会话，但发消息没反应。
 */
import http from "node:http";
import https from "node:https";

/**
 * @typedef {object} ProxyOptions
 * @property {URL} upstream - DSH 地址，例如 http://127.0.0.1:3299
 * @property {(msg: string, meta?: object) => void} log
 */

export class UpstreamProxy {
  /**
   * @param {ProxyOptions} options
   */
  constructor({ upstream, log }) {
    this.upstream = upstream;
    this.log = log;
    // DSH 是明文 HTTP；这里只支持 http upstream，
    // 因为网关和 DSH 同机，没有加密必要
    this.agent = new http.Agent({ keepAlive: true, maxSockets: 64 });
  }

  /**
   * 转发普通 HTTP 请求。
   *
   * @param {import("node:http").IncomingMessage} req
   * @param {import("node:http").ServerResponse} res
   * @param {{ setCookie?: string }} [extras] - 需要**追加**到响应的 Set-Cookie
   */
  forward(req, res, extras) {
    const headers = this.#buildHeaders(req);
    const options = {
      protocol: this.upstream.protocol,
      hostname: this.upstream.hostname,
      port: this.upstream.port,
      method: req.method,
      path: req.url,
      headers,
      agent: this.agent,
    };

    const upstreamReq = http.request(options, (upstreamRes) => {
      // 原样回传状态码和头（包括 Set-Cookie）。
      // 不能只挑几个头转发：DSH 依赖 cache-control、content-encoding 等。
      const outHeaders = { ...upstreamRes.headers };

      // 追加我们自己的 Set-Cookie。上游的可能是字符串或数组，
      // 统一成数组再拼，否则 writeHead 只会保留一个。
      if (extras?.setCookie !== undefined) {
        const upstreamCookies = outHeaders["set-cookie"];
        const merged = Array.isArray(upstreamCookies)
          ? [...upstreamCookies, extras.setCookie]
          : upstreamCookies === undefined
            ? [extras.setCookie]
            : [upstreamCookies, extras.setCookie];
        outHeaders["set-cookie"] = merged;
      }

      res.writeHead(upstreamRes.statusCode ?? 502, outHeaders);
      upstreamRes.pipe(res);
    });

    upstreamReq.on("error", (err) => {
      this.log(`upstream error: ${err.message}`);
      if (!res.headersSent) {
        res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
      }
      res.end("上游服务不可达");
    });

    // 客户端提前断开时同步取消上游请求，避免连接泄漏
    res.on("close", () => {
      if (!res.writableEnded) upstreamReq.destroy();
    });

    req.pipe(upstreamReq);
  }

  /**
   * 转发 WebSocket upgrade。
   *
   * @param {import("node:http").IncomingMessage} req
   * @param {import("node:stream").Duplex} socket
   * @param {Buffer} head
   */
  forwardUpgrade(req, socket, head) {
    const headers = this.#buildHeaders(req);
    headers.connection = "Upgrade";
    headers.upgrade = req.headers.upgrade ?? "websocket";

    const upstreamReq = http.request({
      protocol: this.upstream.protocol,
      hostname: this.upstream.hostname,
      port: this.upstream.port,
      method: "GET",
      path: req.url,
      headers,
    });

    upstreamReq.on("upgrade", (upstreamRes, upstreamSocket, upstreamHead) => {
      const lines = [`HTTP/1.1 101 Switching Protocols`];
      for (const [k, v] of Object.entries(upstreamRes.headers)) {
        if (v === undefined) continue;
        lines.push(Array.isArray(v) ? v.map((x) => `${k}: ${x}`).join("\r\n") : `${k}: ${v}`);
      }
      socket.write(`${lines.join("\r\n")}\r\n\r\n`);
      if (upstreamHead?.length) socket.write(upstreamHead);
      if (head?.length) upstreamSocket.write(head);

      upstreamSocket.on("error", () => socket.destroy());
      socket.on("error", () => upstreamSocket.destroy());

      upstreamSocket.pipe(socket).pipe(upstreamSocket);
      this.log(`websocket 已建立 ${req.url}`);
    });

    // 上游拒绝 upgrade（例如 403/401）时，把它的响应原样回给客户端。
    // 早期版本这里直接 destroy，浏览器只能看到「连接意外关闭」，无从排查。
    upstreamReq.on("response", (upstreamRes) => {
      this.log(`websocket 被拒绝: ${upstreamRes.statusCode} ${req.url}`);
      const lines = [`HTTP/1.1 ${upstreamRes.statusCode} ${upstreamRes.statusMessage ?? ""}`];
      for (const [k, v] of Object.entries(upstreamRes.headers)) {
        if (v === undefined) continue;
        lines.push(Array.isArray(v) ? v.map((x) => `${k}: ${x}`).join("\r\n") : `${k}: ${v}`);
      }
      socket.write(`${lines.join("\r\n")}\r\n\r\n`);
      socket.destroy();
    });

    upstreamReq.on("error", (err) => {
      this.log(`websocket upstream error: ${err.message}`);
      socket.destroy();
    });

    socket.on("error", () => upstreamReq.destroy());

    upstreamReq.end();
  }

  /**
   * 构造转发头。
   *
   * @param {import("node:http").IncomingMessage} req
   * @returns {Record<string, string | string[]>}
   */
  #buildHeaders(req) {
    const headers = { ...req.headers };

    // **不改写 Host**：DSH 的 cookie 签名和围栏都基于 authority，
    // 改成 upstream 地址会让所有 API 请求 403。
    // 这里显式删除可能的代理链头，避免把客户端真实意图混进来。
    delete headers["x-forwarded-host"];
    delete headers["x-forwarded-proto"];

    // 记录真实客户端，便于日志排查（不影响认证）
    const remote = req.socket.remoteAddress;
    if (remote !== undefined) headers["x-real-ip"] = remote;

    return headers;
  }
}
