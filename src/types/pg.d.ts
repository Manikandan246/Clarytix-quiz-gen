declare module "pg" {
  interface QueryResult<T = any> {
    rows: T[];
    rowCount?: number;
  }

  interface PoolClient {
    query<T = any>(text: string, values?: unknown[]): Promise<QueryResult<T>>;
    release(): void;
  }

  interface PoolConfig {
    connectionString: string;
    ssl?: { rejectUnauthorized?: boolean } | boolean;
  }

  export class Pool {
    constructor(config: PoolConfig);
    query<T = any>(text: string, values?: unknown[]): Promise<QueryResult<T>>;
    connect(): Promise<PoolClient>;
  }
}
