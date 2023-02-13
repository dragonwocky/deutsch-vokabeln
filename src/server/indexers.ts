import {
  extract as extractFrontmatter,
  test as hasFrontmatter,
} from "std/encoding/front_matter/any.ts";
import { parse as parseToml } from "std/encoding/toml.ts";
import { parse as parseYaml } from "std/encoding/yaml.ts";
import {
  type ErrorStatus,
  isErrorStatus,
  Status,
  STATUS_TEXT,
} from "std/http/http_status.ts";
import { extname } from "std/path/mod.ts";
import type {
  Context,
  Data,
  ErrorHandler,
  Handler,
  HttpMethod,
  Manifest,
  Middleware,
  Renderer,
  Route,
} from "./types.ts";
import { HttpMethods } from "./types.ts";
import { walkDirectory } from "./reader.ts";
import { BUILD_ID, INTERNAL_PREFIX } from "../constants.ts";

import {
  getErrorHandler,
  getProcessorsByExtension,
  getRendererById,
  getRenderersByExtension,
  useData,
  useErrorHandler,
  useMiddleware,
} from "./hooks.ts";

const pathToPattern = (path: string): URLPattern => {
  // if (ignoreExtension) path = path.slice(0, -extname(path).length);
  return new URLPattern({
    pathname: path.split("/")
      .map((part) => {
        if (part.endsWith("]")) {
          // repeated group e.g. /[...path] matches /path/to/file/
          if (part.startsWith("[...")) return `:${part.slice(4, -1)}*`;
          // named group e.g. /user/[id] matches /user/6448
          if (part.startsWith("[")) `:${part.slice(1, -1)}`;
        }
        return part;
      }).join("/")
      // /route/index is equiv to -> /route
      .replace(/\/index$/, "")
      // /*? matches all nested routes
      .replace(/\/_(middleware|data)$/, "/*?")
      // ensure starting slash and remove repeat slashes
      .replace(/(^\/*|\/+)/g, "/"),
  });
};

const indexRoutes = async (manifest: Manifest) => {
  const decoder = new TextDecoder("utf-8"),
    files = await walkDirectory(new URL("./routes", manifest.baseUrl));

  for (const { content, pathname } of files) {
    const [, status] = pathname.match(/\/_(\d+)+\.[^/]+$/) ?? [],
      isData = /\/_data\.[^/]+$/.test(pathname),
      isMiddleware = /\/_middleware\.[^/]+$/.test(pathname),
      isErrorHandler = isErrorStatus(+status?.[1]);
    if (!(isData || isMiddleware || isErrorHandler)) {
      if (manifest.ignorePattern?.test(pathname)) continue;
    }

    const ext = extname(pathname),
      exports = { ...(manifest.routes[pathname] ?? {}) };
    let body = decoder.decode(content as Uint8Array);
    if (ext === ".json") Object.assign(exports, JSON.parse(body));
    if (ext === ".yaml") Object.assign(exports, parseYaml(body));
    if (ext === ".toml") Object.assign(exports, parseToml(body));
    if (!(exports.pattern instanceof URLPattern)) delete exports.pattern;
    exports.pattern ??= pathToPattern(pathname.slice(0, -ext.length));
    if (hasFrontmatter(body)) {
      const { body: _body, attrs } = extractFrontmatter(body);
      Object.assign(exports, attrs);
      body = _body;
    }

    if (isMiddleware) useMiddleware(exports as Middleware);
    else if (isData) useData(exports);
    else if (isErrorHandler) {
      useErrorHandler({
        ...(exports as ErrorHandler),
        status: +status,
      });
    } else {
      const data: Data = {},
        { GET, ...route } = exports as Route,
        isPage = GET || "default" in route || "handler" in route;
      let render: Renderer<unknown> = () => body;
      if ("default" in route) render = route.default as Renderer<unknown>;
      if ("handler" in route) render = route.handler as Renderer<unknown>;
      if (isPage || !manifest.routes[pathname]) {
        route.GET = async (req: Request, ctx: Context) => {
          const engines = ctx.state.has("renderEngines")
            ? (ctx.state.get("renderEngines") as string[]).map(getRendererById)
              .filter((engine) => engine)
            : getRenderersByExtension(pathname);
          ctx.render = async () => {
            let page = await render(ctx);
            for (const engine of engines) page = await engine!(page, ctx);
            return String(page);
          };
          if (GET) return GET(req, ctx);
          const document = await ctx.render(),
            type = ctx.state.get("contentType") ?? "text/html",
            headers = new Headers({ "content-type": String(type) });
          return new Response(document, { status: Status.OK, headers });
        };
      }
      for (const key in route) {
        if (["default", "handler"].includes(key)) continue;
        if (HttpMethods.includes(key as HttpMethod)) {
          useMiddleware({
            method: key as HttpMethod,
            pattern: route.pattern,
            handler: route[key] as Handler,
            initialisesResponse: true,
          });
        } else data[key] = route[key];
      }
      useData(data);
    }
  }
};

const indexStatic = async (manifest: Manifest) => {
  const files = await walkDirectory(new URL("./static", manifest.baseUrl));
  await Promise.all(files.map(async (file) => {
    const processors = getProcessorsByExtension(file.pathname);
    for (const transform of processors) file = await transform(file);
    if (manifest.ignorePattern?.test(file.pathname)) return;

    useMiddleware({
      method: "GET",
      pattern: pathToPattern(file.pathname),
      handler: (req, ctx) => {
        const cacheKey = `${INTERNAL_PREFIX}_cache_id`,
          cacheId = ctx.url.searchParams.get(cacheKey),
          cacheControl = "public, max-age=31536000, immutable",
          headers = new Headers({
            "content-type": file.type,
            "vary": "If-None-Match",
            etag: file.etag,
          });
        if (cacheId && cacheId !== BUILD_ID) {
          // redirect files cached from old builds to uncached path
          ctx.url.searchParams.delete(cacheKey);
          return Response.redirect(ctx.url);
          // cache requested files matching current build for a year
        } else if (cacheId) headers.set("cache-control", cacheControl);
        // conditional request: only send response body if cache resource has
        // changed, tested by comparing etags (hashed from build id and pathname)
        // https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/If-None-Match
        // https://developer.mozilla.org/en-US/docs/Web/HTTP/Status/304
        const etagsMatch = (a: string, b: string) =>
          a?.replace(/^W\//, "") === b?.replace(/^W\//, "");
        return etagsMatch(file.etag, req.headers.get("if-none-match") ?? "")
          ? new Response(null, { status: Status.NotModified, headers })
          : new Response(file.content, { status: Status.OK, headers });
      },
      initialisesResponse: true,
    });
  }));
};

export { indexRoutes, indexStatic };