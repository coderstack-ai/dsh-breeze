// dsh-breeze — plugin entry.
//
// Two halves, both optional to the other:
//   * model-facing tools on `ctx.tools` (synthesis, voice library, status, config)
//   * a settings panel in the web GUI, backed by one loopback-only JSON route
//
// `webServer` is declared, not looked up opportunistically: it is a service that
// appears part-way through boot, and an apply that runs before it would register no
// routes at all — silently, since the plugin still reports active.

import { TOOLS } from './tools.mjs';
import { registerRoutes } from './routes.mjs';
import { configPath, readConfig } from './config.mjs';

/** Plugin identity, used by the loader for diagnostics. Keep in sync with package.json. */
export const name = 'dsh-breeze';

export const inject = ['tools', 'webServer'];

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

  let routeRegistered = false;
  const webServer = typeof ctx.get === 'function' ? ctx.get('webServer') : undefined;
  if (webServer && typeof webServer.register === 'function') {
    try {
      registerRoutes(ctx, webServer);
      routeRegistered = true;
    } catch (error) {
      // A route clash must not cost the tools: report it and keep going.
      ctx.logger?.warn?.(`dsh-breeze: could not register /dsh-breeze-api: ${error && error.message ? error.message : error}`);
    }
  }

  ctx.logger?.info?.(
    `dsh-breeze ready: ${registered.length} tools, endpoint ${config.baseUrl}`
    + `${config.token ? ' (bearer)' : ''}, config ${configPath()}`
    + `${routeRegistered ? ', http /dsh-breeze-api' : ''}`,
  );
}

export default { name, inject, apply };
