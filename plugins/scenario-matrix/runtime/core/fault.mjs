// Fault injection and concurrency levers. race() is technology-free and lives
// here; every other lever is a facade that forwards all its arguments, in order
// and unchanged, to the driver an installed adapter contributes under the same
// name. With no such driver installed, driver() throws Blocked naming the
// adapter to add.
import { driver } from './ext.mjs';

export const routeFault = async (...args) => driver('routeFault')(...args);
export const stubFault = (...args) => driver('stubFault')(...args);
export const dbFault = async (...args) => driver('dbFault')(...args);
export const stopFault = async (...args) => driver('stopFault')(...args);
export const schemaFreeze = async (...args) => driver('schemaFreeze')(...args);

export async function race(n, fn) {
  const settled = await Promise.allSettled(Array.from({ length: n }, (_, i) => fn(i)));
  return settled.map(s => s.status === 'fulfilled'
    ? { ok: true, value: s.value }
    : { ok: false, error: s.reason?.message ?? String(s.reason) });
}
