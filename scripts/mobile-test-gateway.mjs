import http from "node:http";
import { createHash, timingSafeEqual } from "node:crypto";

const targetHost = "127.0.0.1";
const targetPort = Number(process.env.MOBILE_TEST_TARGET_PORT ?? 3000);
const listenPort = Number(process.env.MOBILE_TEST_GATEWAY_PORT ?? 4173);
const fullTestAccessKey = process.env.FULL_TEST_ACCESS_KEY ?? "";
const fullTestCookieValue = fullTestAccessKey
  ? createHash("sha256").update(fullTestAccessKey).digest("hex")
  : "";
const fullTestEntryPath = fullTestAccessKey
  ? `/complete-test/${encodeURIComponent(fullTestAccessKey)}`
  : "";

const allowedPrefixes = [
  "/mobile-test",
  "/assets/",
  "/app/globals.css",
  "/@id/",
  "/@vite/",
  "/node_modules/",
  "/.vinext/",
];
const allowedFiles = new Set([
  "/tokyo-dogs-logo.jpg",
  "/interviewer-woman-medium-v2.png",
  "/favicon.svg",
  "/og.png",
  "/og-official-v2.png",
  "/og-online-first-interview-v3.png",
]);

function isAllowed(pathname) {
  return allowedFiles.has(pathname) || allowedPrefixes.some((prefix) => pathname.startsWith(prefix));
}

function hasFullTestAccess(request) {
  if (!fullTestCookieValue) return false;
  const cookieHeader = request.headers.cookie ?? "";
  const cookie = cookieHeader
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith("td_full_test="));
  const value = cookie?.slice("td_full_test=".length) ?? "";
  if (value.length !== fullTestCookieValue.length) return false;
  return timingSafeEqual(Buffer.from(value), Buffer.from(fullTestCookieValue));
}

function deny(response) {
  response.writeHead(404, {
    "content-type": "text/plain; charset=utf-8",
    "cache-control": "no-store",
    "permissions-policy": "camera=(self), microphone=(self), display-capture=(self)",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
  });
  response.end("この公開URLでは、許可されたオンライン一次面接ポータルの確認環境だけを利用できます。");
}

const server = http.createServer((request, response) => {
  const publicUrl = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);

  if (fullTestEntryPath && publicUrl.pathname === fullTestEntryPath) {
    response.writeHead(302, {
      location: "/",
      "cache-control": "no-store",
      "set-cookie": `td_full_test=${fullTestCookieValue}; Path=/; Max-Age=7200; HttpOnly; Secure; SameSite=Strict`,
    });
    response.end();
    return;
  }

  const fullTestAccess = hasFullTestAccess(request);

  if (publicUrl.pathname === "/" && !fullTestAccess) {
    response.writeHead(302, { location: "/mobile-test", "cache-control": "no-store" });
    response.end();
    return;
  }

  if (
    publicUrl.pathname === "/staff" ||
    publicUrl.pathname.startsWith("/api/staff/")
  ) {
    deny(response);
    return;
  }

  if (!isAllowed(publicUrl.pathname) && !fullTestAccess) {
    deny(response);
    return;
  }

  const upstream = http.request({
    host: targetHost,
    port: targetPort,
    path: request.url,
    method: request.method,
    headers: {
      ...request.headers,
      host: `${targetHost}:${targetPort}`,
      "x-forwarded-host": request.headers.host ?? "localhost",
      "x-forwarded-proto": "https",
    },
  }, (upstreamResponse) => {
    response.writeHead(upstreamResponse.statusCode ?? 502, {
      ...upstreamResponse.headers,
      "permissions-policy": "camera=(self), microphone=(self), display-capture=(self)",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      "x-frame-options": "DENY",
    });
    upstreamResponse.pipe(response);
  });

  upstream.on("error", () => {
    if (!response.headersSent) response.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
    response.end("テスト画面を準備しています。少し待ってから再読み込みしてください。");
  });
  request.pipe(upstream);
});

server.on("upgrade", (request, socket, head) => {
  const publicUrl = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
  const fullTestAccess = hasFullTestAccess(request);
  if (
    publicUrl.pathname === "/staff" ||
    publicUrl.pathname.startsWith("/api/staff/") ||
    (!isAllowed(publicUrl.pathname) && !fullTestAccess)
  ) {
    socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
    socket.destroy();
    return;
  }

  const upstreamRequest = http.request({
    host: targetHost,
    port: targetPort,
    path: request.url,
    method: request.method,
    headers: {
      ...request.headers,
      host: `${targetHost}:${targetPort}`,
      "x-forwarded-host": request.headers.host ?? "localhost",
      "x-forwarded-proto": "https",
    },
  });
  upstreamRequest.on("upgrade", (upstreamResponse, upstreamSocket, upstreamHead) => {
    const statusCode = upstreamResponse.statusCode ?? 101;
    const statusMessage = upstreamResponse.statusMessage ?? "Switching Protocols";
    const responseHeaders = [];
    for (let index = 0; index < upstreamResponse.rawHeaders.length; index += 2) {
      responseHeaders.push(`${upstreamResponse.rawHeaders[index]}: ${upstreamResponse.rawHeaders[index + 1]}`);
    }
    socket.write(`HTTP/1.1 ${statusCode} ${statusMessage}\r\n${responseHeaders.join("\r\n")}\r\n\r\n`);
    if (upstreamHead.length) socket.write(upstreamHead);
    if (head.length) upstreamSocket.write(head);
    upstreamSocket.pipe(socket);
    socket.pipe(upstreamSocket);
  });
  upstreamRequest.on("response", () => {
    socket.write("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n");
    socket.destroy();
  });
  upstreamRequest.on("error", () => socket.destroy());
  upstreamRequest.end();
});

server.listen(listenPort, "127.0.0.1", () => {
  process.stdout.write(`Mobile test gateway: http://127.0.0.1:${listenPort}\n`);
});
