import { createServer, type Server } from "node:http";

export interface HealthBootstrapServerOptions {
  readonly deploymentRevision: string;
}

const healthPaths = new Set(["/api/health/live", "/api/health/ready"]);

export function createHealthBootstrapServer(options: HealthBootstrapServerOptions): Server {
  return createServer((request, response) => {
    response.setHeader("cache-control", "no-store");
    response.setHeader("content-type", "application/json; charset=utf-8");
    response.setHeader("x-capstone-revision", options.deploymentRevision);
    const target = request.url ?? "";
    if ((request.method === "GET" || request.method === "HEAD") && healthPaths.has(target)) {
      response.statusCode = 200;
      response.end(request.method === "HEAD" ? undefined : '{"status":"ready"}');
      return;
    }
    response.statusCode = 404;
    response.end('{"status":"unavailable"}');
  });
}
