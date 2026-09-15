import NodeSqlParser from "node-sql-parser";

const { Parser } = NodeSqlParser;

type Column = {
  name: string;
  type: "integer" | "text";
};

type Table = {
  name: string;
  columns: Column[];
};

type Schema = Table[];

// Every table carries the tenant id field `organization_id`
export const schema: Schema = [
  {
    name: "organizations",
    columns: [
      { name: "id", type: "integer" },
      { name: "organization_id", type: "integer" },
      { name: "name", type: "text" },
    ],
  },
  {
    name: "users",
    columns: [
      { name: "id", type: "integer" },
      { name: "organization_id", type: "integer" },
      { name: "email", type: "text" },
    ],
  },
  {
    name: "projects",
    columns: [
      { name: "id", type: "integer" },
      { name: "organization_id", type: "integer" },
      { name: "owner_id", type: "integer" },
      { name: "title", type: "text" },
    ],
  },
];

const query = `SELECT COUNT(*) FROM users`;

/**
 * Raised for any input that cannot be scoped safely. The function fails closed:
 * when in doubt it throws rather than returning a query that might leak rows.
 */
export class TenantScopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TenantScopeError";
  }
}

const PARSER_OPTIONS = { database: "Sqlite" } as const;

// node-sql-parser ships loose typings; these describe only the fields we touch.
type AstNode = Record<string, unknown>;

type FromEntry = AstNode & {
  db?: string | null;
  table?: unknown;
  as?: string | null;
  join?: string;
  on?: unknown;
  expr?: AstNode;
};

type SelectNode = AstNode & {
  type: "select";
  with?: Array<{ name: { value: string }; stmt: { ast: AstNode } }> | null;
  from?: FromEntry[] | null;
  _next?: AstNode | null;
};

type TableInfo = {
  /** Table name exactly as declared in the schema (used in emitted SQL). */
  name: string;
  /** Tenant column name exactly as declared in the schema. */
  tenantColumn: string;
};

/** Case-insensitive lookup, matching SQLite identifier semantics. */
type SchemaIndex = Map<string, TableInfo>;

const fold = (identifier: string): string => identifier.toLowerCase();

function isSelect(node: unknown): node is SelectNode {
  return (
    typeof node === "object" &&
    node !== null &&
    (node as AstNode).type === "select"
  );
}

function validateInputs(
  schema: Schema,
  query: string,
  tenantId: number,
  tenantColumn: string,
): void {
  if (!Array.isArray(schema) || schema.length === 0) {
    throw new TenantScopeError("schema must be a non-empty array of tables");
  }
  if (typeof query !== "string" || query.trim().length === 0) {
    throw new TenantScopeError("query must be a non-empty string");
  }
  if (typeof tenantId !== "number" || !Number.isSafeInteger(tenantId)) {
    throw new TenantScopeError("tenantId must be a safe integer");
  }
  if (typeof tenantColumn !== "string" || tenantColumn.trim().length === 0) {
    throw new TenantScopeError("tenantColumn must be a non-empty string");
  }
}

/**
 * Build the lookup used by the walker. Only tables that are actually referenced
 * by the query are required to carry the tenant column; that check happens at
 * reference time so the error names the offending table.
 */
function indexSchema(schema: Schema, tenantColumn: string): SchemaIndex {
  const index: SchemaIndex = new Map();
  const wanted = fold(tenantColumn);

  for (const table of schema) {
    if (typeof table?.name !== "string" || table.name.length === 0) {
      throw new TenantScopeError("every schema table must have a name");
    }
    if (!Array.isArray(table.columns)) {
      throw new TenantScopeError(`schema table "${table.name}" has no columns`);
    }
    const key = fold(table.name);
    if (index.has(key)) {
      throw new TenantScopeError(`schema declares table "${table.name}" twice`);
    }
    const match = table.columns.find((c) => fold(c?.name ?? "") === wanted);
    index.set(key, {
      name: table.name,
      tenantColumn: match?.name ?? "",
    });
  }

  return index;
}

function parseSingleSelect(query: string): SelectNode {
  const parser = new Parser();
  let ast: unknown;
  try {
    ast = parser.astify(query, PARSER_OPTIONS);
  } catch (error) {
    const detail = error instanceof Error ? error.message.split("\n")[0] : "";
    throw new TenantScopeError(`query could not be parsed: ${detail}`);
  }

  if (Array.isArray(ast)) {
    throw new TenantScopeError("only a single statement is allowed");
  }
  if (!isSelect(ast)) {
    const kind = (ast as AstNode | null)?.type ?? "unknown";
    throw new TenantScopeError(`only SELECT statements are allowed (got ${kind})`);
  }
  return ast;
}

/**
 * Replace a base-table reference with `(SELECT * FROM t WHERE t.<tenant> = id) AS alias`.
 * Filtering at the source means every downstream construct (joins, unions,
 * subqueries, OR predicates) only ever sees rows belonging to the tenant, and
 * outer-join semantics are preserved because the filter is not in the outer WHERE.
 */
function scopedTableReference(
  entry: FromEntry,
  info: TableInfo,
  tenantId: number,
): FromEntry {
  const alias = typeof entry.as === "string" && entry.as.length > 0 ? entry.as : info.name;

  const inner: SelectNode = {
    with: null,
    type: "select",
    options: null,
    distinct: null,
    columns: [{ expr: { type: "column_ref", table: null, column: "*" }, as: null }],
    from: [{ db: entry.db ?? null, table: info.name, as: null }],
    where: {
      type: "binary_expr",
      operator: "=",
      left: { type: "column_ref", table: info.name, column: info.tenantColumn },
      right: { type: "number", value: tenantId },
    },
    groupby: null,
    having: null,
    orderby: null,
    limit: null,
    for_update: null,
  };

  const replacement: FromEntry = {
    expr: { ast: inner, parentheses: true },
    as: alias,
  };
  if (entry.join !== undefined) replacement.join = entry.join;
  if (entry.on !== undefined) replacement.on = entry.on;
  return replacement;
}

class Scoper {
  private readonly index: SchemaIndex;
  private readonly tenantId: number;
  private readonly tenantColumn: string;

  constructor(index: SchemaIndex, tenantId: number, tenantColumn: string) {
    this.index = index;
    this.tenantId = tenantId;
    this.tenantColumn = tenantColumn;
  }

  /** Scope a SELECT (and its UNION/INTERSECT/EXCEPT chain) in place. */
  scopeSelect(node: SelectNode, outerCtes: ReadonlySet<string>): void {
    // CTEs declared here are visible to later CTEs, the body, and set-op branches.
    const ctes = new Set(outerCtes);
    if (Array.isArray(node.with)) {
      for (const cte of node.with) {
        const name = cte?.name?.value;
        if (typeof name !== "string") {
          throw new TenantScopeError("unsupported CTE shape");
        }
        // SQLite treats a self-reference as recursive even without RECURSIVE,
        // so the name is in scope inside its own body.
        ctes.add(fold(name));
        this.walk(cte.stmt, ctes);
      }
    }

    if (Array.isArray(node.from)) {
      node.from = node.from.map((entry) => this.scopeFromEntry(entry, ctes));
    } else if (node.from != null) {
      throw new TenantScopeError("unsupported FROM clause shape");
    }

    for (const [key, value] of Object.entries(node)) {
      if (key === "with" || key === "from" || key === "_next") continue;
      this.walk(value, ctes);
    }

    if (node._next != null) {
      if (!isSelect(node._next)) {
        throw new TenantScopeError("unsupported set operation branch");
      }
      this.scopeSelect(node._next, ctes);
    }
  }

  private scopeFromEntry(entry: FromEntry, ctes: ReadonlySet<string>): FromEntry {
    if (typeof entry !== "object" || entry === null) {
      throw new TenantScopeError("unsupported FROM entry");
    }

    // ON conditions may contain subqueries of their own.
    if (entry.on !== undefined) this.walk(entry.on, ctes);

    // Derived table: `FROM (SELECT ...) AS x` — scope the inner query.
    if (entry.expr !== undefined) {
      this.walk(entry.expr, ctes);
      return entry;
    }

    if (typeof entry.table !== "string") {
      throw new TenantScopeError("unsupported table reference");
    }

    const key = fold(entry.table);
    if (ctes.has(key)) {
      // Reference to a CTE whose body has already been scoped.
      return entry;
    }

    const info = this.index.get(key);
    if (info === undefined) {
      throw new TenantScopeError(`table "${entry.table}" is not in the schema`);
    }
    if (info.tenantColumn.length === 0) {
      throw new TenantScopeError(
        `table "${info.name}" has no tenant column "${this.tenantColumn}"`,
      );
    }

    return scopedTableReference(entry, info, this.tenantId);
  }

  /** Generic descent through any expression, recursing into nested SELECTs. */
  private walk(value: unknown, ctes: ReadonlySet<string>): void {
    if (Array.isArray(value)) {
      for (const item of value) this.walk(item, ctes);
      return;
    }
    if (typeof value !== "object" || value === null) return;

    if (isSelect(value)) {
      this.scopeSelect(value, ctes);
      return;
    }
    for (const child of Object.values(value)) this.walk(child, ctes);
  }
}

/**
 * Rewrite `query` so that every table it reads is restricted to rows whose
 * `tenantColumn` equals `tenantId`. Throws TenantScopeError on any input that
 * cannot be scoped with certainty.
 */
export function main(
  schema: Schema,
  query: string,
  tenantId: number,
  tenantColumn: string,
): string {
  validateInputs(schema, query, tenantId, tenantColumn);

  const index = indexSchema(schema, tenantColumn);
  const ast = parseSingleSelect(query);

  new Scoper(index, tenantId, tenantColumn).scopeSelect(ast, new Set());

  const parser = new Parser();
  const sql = parser.sqlify(ast as unknown as NodeSqlParser.AST, PARSER_OPTIONS);

  // Defensive round-trip: the rewritten AST must serialize to parseable SQL.
  try {
    parser.astify(sql, PARSER_OPTIONS);
  } catch {
    throw new TenantScopeError("internal error: scoped query failed to re-parse");
  }

  return sql;
}

// Only run when executed directly (not when imported by tests).
if (process.argv[1] === import.meta.filename) {
  console.log(main(schema, query, 1, "organization_id"));
}
