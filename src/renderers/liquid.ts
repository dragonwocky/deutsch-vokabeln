import type { Renderer } from "../server.ts";
import { Liquid } from "npm:liquidjs@10.5.0";

const engine = new Liquid();

export default ({
  name: "liquid",
  targets: [".liquid"],
  render: (template, props) => engine.parseAndRender(String(template), props),
}) as Renderer;
