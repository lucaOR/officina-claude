// The three typed outcomes a lever may throw. They live here rather than in
// scenario.mjs so that EVERY lever can type its throws — including
// registry.mjs, which scenario.mjs itself imports, and which would otherwise
// have to import back from scenario.mjs and close an import cycle around the
// classes' own declarations. scenario.mjs re-exports all three, so the public
// import surface (index.mjs, and `from './scenario.mjs'` in the tests) is
// unchanged.
//
// Which class to throw, stated once so every lever answers it the same way:
//
//   Blocked       — the ENVIRONMENT could not honour the call: a container
//                   that is down, a stack that is not provisioned, a registry
//                   key that names nothing, a safety guard refusing a target
//                   outside `scn_`. Nothing was learned about the product.
//   Inconclusive  — the SCENARIO AUTHOR asked for something the library
//                   cannot honour: a login recipe that references a missing
//                   parameter, an op no lever implements, a parse format with
//                   no lever behind it. Also nothing was learned.
//   Ko            — the SYSTEM UNDER TEST misbehaved. This is the only class
//                   that means "product bug", and scenario.mjs's classify()
//                   defaults an untyped throw to it — so an untyped throw out
//                   of a lever is silently reported as a product bug. That
//                   default is why every environment-reaching lever below
//                   types what it throws.
export class Ko extends Error {}
export class Blocked extends Error {}
export class Inconclusive extends Error {}
