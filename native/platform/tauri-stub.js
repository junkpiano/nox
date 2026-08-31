/**
 * Stands in for the @tauri-apps packages when Metro bundles the shared code.
 *
 * The shared modules import Tauri lazily - `await import('@tauri-apps/...')`
 * inside a branch guarded by `isNativeRuntime()` - so under React Native the
 * import is never executed. Metro still has to resolve it at bundle time
 * though, and the package is not installed here, so the build stops.
 *
 * Throwing rather than quietly returning undefined is deliberate. If this is
 * ever actually reached, something is calling a Tauri API from React Native,
 * and a silent no-op would surface that as a confusing failure somewhere much
 * further away from the cause.
 */
const unreachable = (name) => () => {
  throw new Error(
    `[tauri-stub] ${name} was called under React Native. ` +
      'Tauri APIs are reachable only from the Tauri shell; this needs a seam.',
  );
};

module.exports = {
  fetch: unreachable('fetch'),
  invoke: unreachable('invoke'),
  isTauri: () => false,
};
