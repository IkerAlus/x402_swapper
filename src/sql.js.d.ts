/**
 * Minimal type declarations for sql.js.
 *
 * sql.js doesn't ship its own types and @types/sql.js doesn't exist.
 * These declarations cover only the subset we use in the state store.
 */
declare module "sql.js" {
  export interface SqlJsStatic {
    Database: new (data?: ArrayLike<number> | Buffer | null) => Database;
  }

  export interface Database {
    run(sql: string, params?: unknown[]): Database;
    exec(sql: string, params?: unknown[]): QueryExecResult[];
    export(): Uint8Array;
    close(): void;
  }

  export interface QueryExecResult {
    columns: string[];
    values: unknown[][];
  }

  export default function initSqlJs(
    config?: Record<string, unknown>,
  ): Promise<SqlJsStatic>;
}
