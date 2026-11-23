// The stub adapter's contribution module: the `stubs` and `stubs_internal` registry keys, the
// `stubInternal` accessor, the `stub` (request journal) and `stubFault` drivers, and the selftest
// probes. The keys of `drivers` equal the `drivers` array of adapter.json.
//
// A stub is any server that answers a control plane under `/__scn/`: `GET` and `DELETE`
// `/__scn/requests` for its journal, `POST` and `DELETE` `/__scn/fail` for its faults. Every call
// goes through core's `scnFetch`, so the adapter needs no other adapter.
import { Blocked } from './errors.mjs';
import { scnFetch } from './observe.mjs';

export const name = 'stub';

const isMapping = v => v !== null && typeof v === 'object' && !Array.isArray(v);

// --- registry: stubs, stubs_internal ---

const urlMap = what => ({
  validate(value) {
    if (!isMapping(value)) return `must be a mapping of stub name to ${what}`;
    for (const [stub, url] of Object.entries(value)) {
      if (typeof url !== 'string' || url === '') return `${stub} must be a non-empty URL (${what})`;
    }
    return null;
  },
});

export const registry = {
  keys: {
    stubs: urlMap('the URL the harness reaches the stub at'),
    stubs_internal: urlMap('the URL the stub is reachable at from inside the stack'),
  },
  accessors: raw => ({
    // The in-stack address of a stub, for a fixture value the PRODUCT itself dereferences. It is a
    // separate accessor because the caller is not talking to the stub at all: it writes a string
    // into a fixture that some service fetches later. Anything the harness itself fetches keeps
    // using reg.raw.stubs[name], the address Node on the host can reach.
    stubInternal(stubName) {
      const url = raw?.stubs_internal?.[stubName];
      if (!url) {
        throw new Blocked(`unknown stub address: ${stubName} `
          + `(add infra.env_registry.stubs_internal.${stubName} with the URL the stub is reachable at `
          + 'from inside the stack)');
      }
      return url;
    },
  }),
};

// --- stub: the request journal ---

function stubJournal(reg, stubName) {
  const base = reg.raw.stubs?.[stubName];
  if (!base) throw new Blocked(`unknown stub: ${stubName} (add infra.env_registry.stubs.${stubName})`);
  return {
    async requests() {
      const res = await scnFetch(`${base}/__scn/requests`);
      if (!res.ok) {
        throw new Blocked(
          `stub ${stubName} journal returned ${res.status} — its __scn control plane is not `
          + `answering at ${base}/__scn/requests`,
        );
      }
      return res.json();
    },
    // A script that pushes its own requests against a stub needs to start from an empty journal.
    // The journal has no per-scenario reset of its own, so an entry left by an earlier solo
    // rehearsal would otherwise let a later find()-style assert match the wrong run's request.
    async clear() {
      const res = await scnFetch(`${base}/__scn/requests`, { method: 'DELETE' });
      if (!res.ok) {
        throw new Blocked(
          `stub ${stubName} journal clear returned ${res.status} — its __scn control plane is not `
          + `answering DELETE ${base}/__scn/requests`,
        );
      }
    },
  };
}

// --- stubFault ---

function stubFault(reg, stubName) {
  const base = reg.raw.stubs?.[stubName];
  if (!base) throw new Blocked(`unknown stub: ${stubName}`);
  return {
    async fail({ path, status = 500, times = Infinity }) {
      const res = await scnFetch(`${base}/__scn/fail`, {
        method: 'POST',
        body: JSON.stringify({ path, status, times: times === Infinity ? null : times }),
      });
      if (!res.ok) throw new Blocked(`stub ${stubName} fault injection returned ${res.status}`);
    },
    // Symmetric with fail(): a silently failed clear leaves a fault live for the NEXT scenario,
    // which then fails in code that is not its own, so a bad response is never swallowed.
    async clear() {
      const res = await scnFetch(`${base}/__scn/fail`, { method: 'DELETE' });
      if (!res.ok) throw new Blocked(`stub ${stubName} fault clear returned ${res.status}`);
    },
  };
}

export const drivers = { stub: stubJournal, stubFault };

// --- selftest ---

// Neither probe's path sits under `/__scn/`: that namespace is the control plane, matched before the
// journal sees a request, so a path under it would journal by accident today and stop doing so the
// day the control plane claims the whole namespace.
export const selftest = [
  {
    name: 'stub journal: records a request',
    needs: ['adapters.stub.selftest.name'],
    run: async (reg, cfg) => {
      const stubName = cfg.adapters.stub.selftest.name;
      const journal = stubJournal(reg, stubName);
      const before = (await journal.requests()).length;
      await scnFetch(`${reg.raw.stubs[stubName]}/scn-selftest-ping`).catch(() => {});
      return (await journal.requests()).length > before;
    },
  },
  {
    // Clears in a `finally`: a fault this probe armed must never outlive it, because the next
    // scenario to touch that stub would fail in code that is not its own.
    name: 'stub fault: injects then clears',
    needs: ['adapters.stub.selftest.name'],
    run: async (reg, cfg) => {
      const stubName = cfg.adapters.stub.selftest.name;
      const base = reg.raw.stubs[stubName];
      const fault = stubFault(reg, stubName);
      try {
        await fault.fail({ path: '/scn-selftest-boom', status: 503, times: 1 });
        const hot = await scnFetch(`${base}/scn-selftest-boom`);
        await fault.clear();
        const cold = await scnFetch(`${base}/scn-selftest-boom`);
        return hot.status === 503 && cold.status !== 503;
      } finally {
        await fault.clear().catch(() => {});
      }
    },
  },
];
