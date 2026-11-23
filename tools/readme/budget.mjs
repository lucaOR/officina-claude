// The byte budget for everything under .github/assets except the social preview. It lives in
// its own module so tests can import it without loading shots.mjs, which runs on import.
export const BUDGET = 1_000_000;
