declare module 'sql.js' {
  interface SqlJsStatic {
    Database: new (data?: Buffer | Uint8Array) => Database;
  }
  interface Database {
    run(sql: string, params?: any[]): Database;
    exec(sql: string, params?: any[]): QueryResult[];
    prepare(sql: string): Statement;
    export(): Uint8Array;
    close(): void;
  }
  interface QueryResult {
    columns: string[];
    values: any[][];
  }
  interface Statement {
    bind(params?: any[]): Statement;
    step(): boolean;
    getAsObject(): Record<string, any>;
    free(): void;
  }
  export default function initSqlJs(config?: any): Promise<SqlJsStatic>;
}
