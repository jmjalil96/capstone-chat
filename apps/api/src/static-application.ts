import { readdirSync } from "node:fs";
import { extname, join, relative, sep } from "node:path";
import fastifyStatic from "@fastify/static";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

const immutableAssetName = /(?:^|\/)assets\/[^/]+-[A-Za-z0-9_-]{8,}\.[^/]+$/u;
const reportableAssetExtension = /\.(?:css|js)$/u;

export function createKnownApplicationAssetValidator(
  root: string | null,
): (asset: string) => boolean {
  if (root === null) {
    return () => false;
  }

  const assets = new Set(
    readdirSync(join(root, "assets"), {
      withFileTypes: true,
    })
      .filter((entry) => entry.isFile() && reportableAssetExtension.test(entry.name))
      .map((entry) => entry.name),
  );
  return (asset) => assets.has(asset);
}

function relativeAssetPath(root: string, filePath: string): string {
  return relative(root, filePath).split(sep).join("/");
}

function setStaticCachePolicy(reply: FastifyReply, root: string, filePath: string): void {
  const assetPath = relativeAssetPath(root, filePath);

  if (assetPath === "index.html") {
    void reply.header("cache-control", "no-cache");
    return;
  }

  if (immutableAssetName.test(assetPath)) {
    void reply.header("cache-control", "public, max-age=31536000, immutable");
    return;
  }

  void reply.header("cache-control", "public, max-age=300, must-revalidate");
}

function rawPath(request: FastifyRequest): string | null {
  const path = request.raw.url?.split("?", 1)[0];
  if (path === undefined || path.includes("%") || path.includes("\\") || path.includes("\0")) {
    return null;
  }

  const segments = path.split("/");
  if (segments.some((segment) => segment === "." || segment === ".." || segment.startsWith("."))) {
    return null;
  }

  return path;
}

export function shouldServeSpaShell(request: FastifyRequest): boolean {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return false;
  }

  const path = rawPath(request);
  if (path === null || path === "/api" || path.startsWith("/api/")) {
    return false;
  }

  return extname(path) === "";
}

export function registerStaticApplication(
  fastify: FastifyInstance,
  root: string,
): (request: FastifyRequest, reply: FastifyReply) => boolean {
  void fastify.register(fastifyStatic, {
    allowedPath: (pathName) => !pathName.split("/").some((segment) => segment.startsWith(".")),
    cacheControl: false,
    dotfiles: "deny",
    index: ["index.html"],
    redirect: false,
    root,
    serveDotFiles: false,
    setHeaders: (reply, filePath) => {
      setStaticCachePolicy(reply, root, filePath);
    },
  });

  return (request, reply) => {
    if (!shouldServeSpaShell(request)) {
      return false;
    }

    void reply.header("cache-control", "no-cache").type("text/html").sendFile("index.html", {
      cacheControl: false,
      dotfiles: "deny",
    });
    return true;
  };
}
