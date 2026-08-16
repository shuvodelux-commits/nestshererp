/** Runtime configuration. Boot fails loudly rather than starting half-configured. */
export interface ApiConfig {
  readonly databaseUrl: string;
  readonly jwtSecret: string;
  readonly port: number;
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
  };
}
