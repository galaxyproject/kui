/** Join a site-relative path onto the configured base. GitHub Pages serves the
 *  site from /kui, so no link may start from the domain root. */
export function withBase(path: string): string {
  const base = import.meta.env.BASE_URL.replace(/\/$/, '');
  const suffix = path.startsWith('/') ? path : `/${path}`;
  return `${base}${suffix}`;
}
