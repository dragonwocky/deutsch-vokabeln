/*! mit license (c) dragonwocky <thedragonring.bod@gmail.com> (https://dragonwocky.me/) */

import {
  basename,
  contentType,
  getCookies,
  HTTPStatus,
  HTTPStatusText,
  readableStreamFromReader,
  serve,
} from "./deps.ts";

type Mutable<T> = { -readonly [P in keyof T]: T[P] };

// https://www.iana.org/assignments/http-methods/http-methods.xhtml
const RequestMethods = [
  "POST", // create
  "GET", // read
  "PUT", // replace
  "PATCH", // update
  "DELETE", // delete
  "*",
] as const;
type RequestMethod = typeof RequestMethods[number];
type RequestBody =
  | string
  | number
  | boolean
  | Record<string, unknown>
  | unknown[]
  | null
  | undefined
  | FormData
  | Blob
  | ArrayBuffer;

type Callback = (ctx: Context) => void | Promise<void>;
interface Context {
  readonly req: {
    method: RequestMethod;
    ip: string | null;
    url: URL;
    body: RequestBody;
    bodyType: undefined | "json" | "text" | "formData" | "blob";
    queryParams: URLSearchParams;
    pathParams: Record<string, string>;
    cookies: Record<string, string>;
    headers: Headers;
  };
  res: {
    body: BodyInit;
    status: number;
    headers: Headers;
    readonly sent: boolean;
    sendStatus: (status: HTTPStatus) => void;
    sendJSON: (data: unknown) => void;
    sendFile: (filepath: string) => Promise<void>;
    sendFileStream: (filepath: string) => Promise<void>;
    inferContentType: (lookup: string) => void;
    markForDownload: (filename?: string) => void;
  };
  upgrade: {
    readonly available: boolean;
    readonly socket: () => WebSocket | undefined;
    channel: {
      readonly name: string;
      join: (name: string) => void;
      broadcast: (message: unknown) => void;
    };
  };
}

const middleware: Callback[] = [],
  useMiddleware = (callback: Callback) => middleware.push(callback);

const routes: [RequestMethod, URLPattern, Callback][] = [],
  handleRoute = (
    method: RequestMethod,
    path: string,
    callback: Callback,
  ) => routes.push([method, new URLPattern({ pathname: path }), callback]),
  getRoute = (method: RequestMethod, href: string) => {
    href = href.replaceAll(/\/$/g, "");
    for (const route of routes) {
      if (!["*", route[0]].includes(method)) continue;
      if (!route[1].test(href)) continue;
      const pathParams = route[1].exec(href)?.pathname?.groups ?? {};
      return { callback: route[2], pathParams };
    }
    return undefined;
  };

const activeSocketConnections: Map<string, Set<WebSocket>> = new Map(),
  removeSocketFromChannel = (name: string, socket: WebSocket) => {
    if (!activeSocketConnections.get(name)) return;
    activeSocketConnections.get(name)!.delete(socket);
  },
  addSocketToChannel = (name: string, socket: WebSocket) => {
    if (!activeSocketConnections.get(name)) {
      activeSocketConnections.set(name, new Set());
    }
    activeSocketConnections.get(name)!.add(socket);
  };

const listenAndServe = (port = 3000, log = console.log) => {
  log("");
  log(`✨ server started at http://localhost:${port}/`);
  log("listening for requests...");
  log("");
  serve(async (req, conn) => {
    let override: Response | undefined, socket: WebSocket | undefined;

    const url = new URL(req.url),
      ctx: Mutable<Context> = {
        req: {
          method: req.method as RequestMethod,
          ip: (conn.remoteAddr as Deno.NetAddr).hostname,
          url,
          body: undefined,
          bodyType: undefined,
          queryParams: new URLSearchParams(url.search),
          pathParams: {},
          cookies: getCookies(req.headers),
          headers: req.headers,
        },

        res: {
          body: "",
          status: HTTPStatus.OK,
          headers: new Headers(),
          sent: false,
          sendStatus: (status) => {
            ctx.res.body = `${status} ${HTTPStatusText.get(status) ?? ""}`;
            ctx.res.status = status;
          },
          sendJSON: (data) => {
            if (data instanceof Map || data instanceof Set) data = [...data];
            ctx.res.body = JSON.stringify(data, null, 2);
            ctx.res.inferContentType("json");
            ctx.res.status = HTTPStatus.OK;
          },
          sendFile: async (filepath) => {
            try {
              ctx.res.body = await Deno.readTextFile(filepath);
              ctx.res.inferContentType(basename(filepath));
              ctx.res.status = HTTPStatus.OK;
            } catch {
              ctx.res.sendStatus(HTTPStatus.NotFound);
            }
          },
          sendFileStream: async (filepath) => {
            try {
              const file = await Deno.open(filepath, { read: true });
              ctx.res.body = readableStreamFromReader(file);
              ctx.res.inferContentType(basename(filepath));
              ctx.res.status = HTTPStatus.OK;
            } catch {
              ctx.res.sendStatus(HTTPStatus.NotFound);
            }
          },
          inferContentType: (lookup) => {
            const inferredType = contentType(lookup);
            if (inferredType) ctx.res.headers.set("content-type", inferredType);
          },
          markForDownload: (filename) => {
            filename = filename ? `; filename="${filename}"` : "";
            ctx.res.headers.set("content-disposition", `attachment${filename}`);
          },
        },

        upgrade: {
          available: req.headers.get("upgrade") === "websocket",
          socket: () => {
            if (!ctx.upgrade.available) return undefined;
            if (socket || ctx.res.sent) return socket;
            const upgrade = Deno.upgradeWebSocket(req);
            socket = upgrade.socket;
            override = upgrade.response;
            addSocketToChannel(ctx.upgrade.channel.name, socket);
            return socket;
          },
          channel: {
            name: "",
            join: (name) => {
              const socket = ctx.upgrade.socket();
              if (socket) {
                removeSocketFromChannel(ctx.upgrade.channel.name, socket);
                addSocketToChannel(name, socket);
              }
              const channel =
                (ctx.upgrade.channel as Mutable<Context["upgrade"]["channel"]>);
              channel.name = name;
            },
            broadcast: (message) => {
              const { name } = ctx.upgrade.channel,
                channel = activeSocketConnections.get(name);
              if (!channel) return;
              const safe = typeof message === "string" ||
                message instanceof Blob || message instanceof ArrayBuffer ||
                message instanceof SharedArrayBuffer ||
                message instanceof Int8Array ||
                message instanceof Uint8Array ||
                message instanceof Uint8ClampedArray ||
                message instanceof Int16Array ||
                message instanceof Uint16Array ||
                message instanceof Int32Array ||
                message instanceof Uint32Array ||
                message instanceof Float32Array ||
                message instanceof Float64Array ||
                message instanceof BigInt64Array ||
                message instanceof BigUint64Array ||
                message instanceof DataView;
              if (!safe) message = JSON.stringify(message);
              const data = message as
                | string
                | Blob
                | ArrayBufferView
                | ArrayBufferLike;
              for (const s of channel) s.send(data);
            },
          },
        },
      };

    if (RequestMethods.includes(ctx.req.method)) {
      try {
        log(`[${ctx.req.ip}] ${ctx.req.method} ${ctx.req.url.pathname}`);

        if (req.body) {
          const contentType = req.headers.get("content-type") ?? "",
            isJSON = contentType.includes("application/json"),
            isText = contentType.includes("text/plain"),
            isFormData =
              contentType.includes("application/x-www-form-urlencoded") ||
              contentType.includes("multipart/form-data");
          if (isJSON) {
            ctx.req.body = await req.json();
            ctx.req.bodyType = "json";
          } else if (isText) {
            ctx.req.body = await req.text();
            ctx.req.bodyType = "text";
          } else if (isFormData) {
            ctx.req.body = await req.formData();
            ctx.req.bodyType = "formData";
          } else {
            ctx.req.body = await req.blob();
            ctx.req.bodyType = "blob";
          }
        }

        const route = getRoute(ctx.req.method, ctx.req.url.href);
        if (route) {
          ctx.req.pathParams = route.pathParams;
          await route.callback(ctx);
        } else ctx.res.sendStatus(HTTPStatus.NotFound);

        for (const callback of middleware) await callback(ctx);
      } catch (err) {
        log(`[${ctx.req.ip}]`, err);
        ctx.res.sendStatus(HTTPStatus.InternalServerError);
      }
    } else ctx.res.sendStatus(HTTPStatus.NotImplemented);

    (ctx.res as Mutable<Context["res"]>).sent = true;
    Object.freeze(ctx.res);
    return override ?? new Response(ctx.res.body, {
      status: ctx.res.status,
      headers: ctx.res.headers,
    });
  }, { port });
};

export { handleRoute, listenAndServe, useMiddleware };
export type { Context };
