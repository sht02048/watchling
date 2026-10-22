export function contentSecurityPolicy(connect: "'none'" | "'self'"): string {
  return `default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src ${connect}; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`;
}
