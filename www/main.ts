import eta from "nadder/renderers/eta.ts";
import md from "nadder/renderers/markdown.ts";
import njk from "nadder/renderers/nunjucks.ts";
import pug from "nadder/renderers/pug.ts";
import liquid from "nadder/renderers/liquid.ts";
import { start, useFilter, useRenderer } from "nadder/server.ts";
import manifest from "./manifest.gen.ts";

useFilter("uppercase", (s) => s.toUpperCase());
useRenderer(eta);
useRenderer(pug);
useRenderer(liquid);
useRenderer(md);
useRenderer(njk);
start(manifest);
