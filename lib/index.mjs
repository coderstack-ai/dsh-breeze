// dsh-breeze — plugin entry (host half).
//
// Registers the breeze_* tools on ctx.tools and, when the deployment has a web
// server, one prefix route under /dsh-breeze-api. Settings live in
// <home>/.dsh/dsh-breeze/config.json, which the tools themselves can read and
// write, so the agent can configure the plugin without a restart or a UI.
//
// This module deliberately imports no DSH package: a linked plugin is resolved
// from its own directory, where @deepseek-ai/* is not installed, and only the
// ctx services it is injected with are guaranteed to be reachable.

import { TOOLS } from './tools.mjs';
import { registerRoutes } from './routes.mjs';
import { configPath, readConfig } from './config.mjs';

/** Plugin identity, used by the loader for diagnostics. Keep in sync with package.json. */
export const name = 'dsh-breeze';

/** `tools` is required; `webServer` is fetched opportunistically below. */
export const inject = ['tools'];

/**
 * @param ctx plugin context
 */
export function apply(ctx) {
  const config = readConfig();
  const registered = [];
  for (const definition of TOOLS) {
    ctx.tools.register(definition);
    registered.push(definition.name);
  }

  const webServer = typeof ctx.get === 'function' ? ctx.get('webServer') : undefined;
  let routeRegistered = false;
  if (webServer && typeof webServer.register === 'function') {
    try {
      registerRoutes(ctx, webServer);
      routeRegistered = true;
    } catch (error) {
      // A route clash must not cost the tools: report it and keep going.
      ctx.logger?.warn?.(`dsh-breeze: could not register ${'/dsh-breeze-api'}: ${error && error.message ? error.message : error}`);
    }
  }

  ctx.logger?.info?.(
    `dsh-breeze ready: ${registered.length} tools, endpoint ${config.baseUrl}`
    + `${config.token ? ' (bearer)' : ''}, config ${configPath()}`
    + `${routeRegistered ? ', http /dsh-breeze-api' : ''}`,
  );
}

export default { name, inject, apply };
