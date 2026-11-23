// The http adapter's contribution module. It adds no registry key, driver, rule or hook of its own:
// the client in http.mjs is a lever, and other adapters extend it through their `httpClient`
// contribution.
export const name = 'http';
