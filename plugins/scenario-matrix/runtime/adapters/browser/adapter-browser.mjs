// The browser adapter's contribution module: the `login` registry key with its `recipe` and
// `marker` accessors, and the `routeFault` driver. The keys of `drivers` equal the `drivers`
// array of adapter.json.
import { Blocked } from './errors.mjs';
import { parseMarker, resolveHostFor } from './login.mjs';

export const name = 'browser';

const isMapping = v => v !== null && typeof v === 'object' && !Array.isArray(v);

// --- registry: login ---

function validateLogin(value) {
  if (!isMapping(value)) return 'must be a mapping of recipe name to a list of lines, plus an optional markers mapping';
  for (const [key, entry] of Object.entries(value)) {
    if (key === 'markers') {
      if (!isMapping(entry)) return 'markers must be a mapping of marker name to "dom:<selector>" or "url:<regex>"';
      for (const [marker, text] of Object.entries(entry)) {
        if (typeof text !== 'string' || !/^(dom|url):./s.test(text)) {
          return `markers.${marker} must start with dom: or url:`;
        }
      }
    } else if (!Array.isArray(entry) || entry.some(line => typeof line !== 'string')) {
      return `${key} must be a list of lines`;
    }
  }
  return null;
}

export const registry = {
  keys: { login: { validate: validateLogin } },
  accessors: (raw, reg) => ({
    recipe(recipeName) {
      const steps = raw.login?.[recipeName];
      if (recipeName === 'markers' || !Array.isArray(steps)) throw new Blocked(`unknown login recipe: ${recipeName}`);
      return steps;
    },
    // {host:<kind>} rather than {<kind>}: a marker VALUE is a regex, and resolveTemplate's own
    // \{([a-zA-Z0-9_-]+)\} placeholder syntax would otherwise eat the quantifier in `[0-9a-f]{8}`
    // and throw "unresolved placeholder: 8". The `host:` prefix cannot occur in a quantifier.
    marker(markerName, { tenant = null } = {}) {
      const entry = raw.login?.markers?.[markerName];
      if (!entry) throw new Blocked(`unknown marker: ${markerName}`);
      const resolved = String(entry).replace(/\{host:([a-z0-9-]+)\}/g,
        (_, kind) => String(resolveHostFor(reg, kind, { tenant, use: 'marker' })).replace(/\./g, '\\.'));
      return parseMarker(resolved);
    },
  }),
};

// --- driver: routeFault ---

// `matcher` is a predicate over the intercepted request, so a caller pins the METHOD as well as
// the URL: a bare URL substring would also swallow the GET that shares the collection path.
// Returns a handle whose clear() removes the route; register it as a ctx cleanup so a thrown
// assert cannot leak the fault into the next scenario. Counting fulfilments lets a caller assert
// the request was actually attempted rather than silently never sent: an absent request and a
// rejected one look identical from the DOM alone.
async function routeFault(page, matcher, { status = 500, body = null } = {}) {
  if (typeof matcher !== 'function') {
    throw new Blocked('routeFault(matcher) must be a predicate over the request, so the METHOD is pinned '
      + 'alongside the path -- a bare URL match also intercepts the GET that renders the same collection');
  }
  const state = { count: 0 };
  const handler = async route => {
    const request = route.request();
    if (!matcher(request)) {
      await route.fallback();
      return;
    }
    state.count += 1;
    await route.fulfill({
      status,
      contentType: 'application/json',
      body: body === null ? JSON.stringify({ message: 'scn injected fault' }) : body,
    });
  };
  await page.route('**/*', handler);
  return {
    get count() { return state.count; },
    clear: () => page.unroute('**/*', handler),
  };
}

export const drivers = { routeFault };
