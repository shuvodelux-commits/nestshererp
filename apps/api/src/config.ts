/** Runtime configuration. Boot fails loudly rather than starting half-configured. */
export interface ApiConfig {
  readonly databaseUrl: string;
  readonly jwtSecret: string;
  readonly port: number;
  /** Origin the Vue app is served from, for CORS. Defaults to the Vite dev server. */
  readonly webOrigin: string;
  /**
   * Google OAuth client id (D-07). Empty disables Google sign-in — the server
   * then refuses every Google token rather than skipping the `aud` check, which
   * is what stops a token minted for another application being replayed here.
   */
  readonly googleClientId: string;
}

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(`${name} is required but not set`);
  }
  return value;
}

export function loadConfig(): ApiConfig {
  return {
    databaseUrl: required('DATABASE_URL'),
    jwtSecret: required('JWT_SECRET'),
    port: Number(process.env['PORT'] ?? 3000),
    webOrigin: process.env['WEB_ORIGIN'] ?? 'http://localhost:5173',
    googleClientId: process.env['GOOGLE_CLIENT_ID'] ?? '',
  };
}
