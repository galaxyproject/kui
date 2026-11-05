/** Join a site-relative path onto the configured base, including root-domain
 *  deployments such as kui.galaxyproject.org. */
export function withBase(path: string): string {
  const base = import.meta.env.BASE_URL.replace(/\/$/, '');
  const suffix = path.startsWith('/') ? path : `/${path}`;
  return `${base}${suffix}`;
}
