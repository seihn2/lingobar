/** The protected owner page uses the same UI through an explicit Access namespace.
 * The gateway independently verifies owner identity; a URL prefix is not authority. */
export function webApiPath<T extends string>(path: T): T | `/owner${T}` {
  return typeof location !== 'undefined' && /^\/owner(?:\/|$)/u.test(location.pathname) ? `/owner${path}` : path
}
