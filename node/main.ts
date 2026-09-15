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
  using?: unknown;
  expr?: AstNode;
};

type WithItem = {
  name: { value: string };
  stmt: { ast: AstNode };
  /** Present and true only for WITH RECURSIVE. */
  recursive?: boolean;
  columns?: unknown;
};

type SelectNode = AstNode & {
  type: "select";
  with?: WithItem[] | null;
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

/**
 * SQLite folds identifiers case-insensitively for ASCII only; a non-ASCII
 * "Üsers" does not match "üsers" (verified: "no such table"). JavaScript's
 * toLowerCase folds Unicode, which would treat names SQLite considers
 * distinct as equal — so fold ASCII only, exactly like the engine.
 */
const fold = (identifier: string): string =>
  identifier.replace(/[A-Z]/g, (c) => c.toLowerCase());

/**
 * node-sql-parser misparses NATURAL/CROSS joins, putting the keyword into the
 * alias slot (`users NATURAL JOIN projects` → `users AS "NATURAL"` + a join
 * with no constraint). Rejecting these aliases fails closed on that misparse
 * without inspecting raw query text. SQLite accepts keywords as aliases, so
 * this is stricter than the engine — deliberately.
 */
const JOIN_KEYWORDS = new Set(
  ["natural", "cross", "outer", "full", "left", "right", "inner", "using", "on"].map(fold),
);

/**
 * Every key node-sql-parser is known to place on a FROM entry. Anything else
 * is a shape the rewriter was not designed for: reject rather than pass it
 * through silently.
 */
const FROM_ENTRY_KEYS = new Set(["db", "table", "as", "join", "on", "using", "expr"]);

/** The only database qualifier the single-database schema can vouch for. */
const MAIN_DATABASE = "main";

/**
 * Names that reach the emitted SQL (table names, the tenant column) must be
 * plain identifiers. Anything else could break out of the double quotes
 * sqlify wraps them in.
 */
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** True when a FROM entry's `expr` is a subquery (possibly wrapped by the parser). */
function isSubqueryExpr(expr: unknown): boolean {
  if (isSelect(expr)) return true;
  return typeof expr === "object" && expr !== null && isSelect((expr as AstNode).ast);
}

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
    if (typeof table?.name !== "string" || !IDENTIFIER.test(table.name)) {
      throw new TenantScopeError(
        `schema table name ${JSON.stringify(table?.name)} is not a plain identifier`,
      );
    }
    if (!Array.isArray(table.columns)) {
      throw new TenantScopeError(`schema table "${table.name}" has no columns`);
    }
    const key = fold(table.name);
    if (index.has(key)) {
      throw new TenantScopeError(`schema declares table "${table.name}" twice`);
    }
    const match = table.columns.find((c) => fold(c?.name ?? "") === wanted);
    if (match !== undefined && !IDENTIFIER.test(match.name)) {
      throw new TenantScopeError(
        `tenant column ${JSON.stringify(match.name)} on "${table.name}" is not a plain identifier`,
      );
    }
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

  // Carry the entire original entry (join, on, using, and anything the parser
  // adds later) — only the table reference itself is replaced.
  const replacement: FromEntry = { ...entry };
  delete replacement.db;
  delete replacement.table;
  replacement.expr = { ast: inner, parentheses: true };
  replacement.as = alias;
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
        if (cte.recursive === true) {
          // WITH RECURSIVE: the name is in scope inside its own body
          // (SQLite documents the self-reference as the defining property
          // of a recursive CTE), so scope the body with it visible.
          ctes.add(fold(name));
          this.walk(cte.stmt, ctes);
        } else {
          // Ordinary CTE: SQLite resolves a self-reference inside the body
          // to the CTE itself and then fails with "circular reference: <name>".
          // Scope the body WITHOUT the name in scope: a self-reference then
          // resolves to the base table (and is scoped) or is rejected. Either
          // way the emitted query cannot read unscoped rows.
          this.walk(cte.stmt, ctes);
          ctes.add(fold(name));
        }
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

    // Unknown entry shape: reject rather than pass through silently.
    for (const key of Object.keys(entry)) {
      if (!FROM_ENTRY_KEYS.has(key)) {
        throw new TenantScopeError(`unsupported FROM entry shape: "${key}"`);
      }
    }

    // The parser's NATURAL/CROSS misparse lands the keyword in the alias slot.
    if (typeof entry.as === "string" && JOIN_KEYWORDS.has(fold(entry.as))) {
      throw new TenantScopeError(
        `table alias "${entry.as}" is a join keyword (NATURAL/CROSS joins are not supported)`,
      );
    }

    // ON conditions may contain subqueries of their own.
    if (entry.on !== undefined) this.walk(entry.on, ctes);

    // Derived table: `FROM (SELECT ...) AS x` — scope the inner query.
    // Anything else in the expr slot (table-valued functions, virtual
    // tables) reads data the schema cannot vouch for: reject.
    if (entry.expr !== undefined) {
      if (!isSubqueryExpr(entry.expr)) {
        throw new TenantScopeError(
          "only tables and subqueries are allowed in FROM (table-valued functions are not supported)",
        );
      }
      this.walk(entry.expr, ctes);
      return entry;
    }

    if (typeof entry.table !== "string") {
      throw new TenantScopeError("unsupported table reference");
    }

    // A schema-qualified name (`db.table`) can never resolve to a CTE in
    // SQLite — only to a real table in that schema ("If a schema name is
    // specified, then only that one schema is searched", lang_naming.html;
    // verified: `WITH x AS (...) SELECT * FROM main.x` → "no such table").
    // The schema describes a single database, so only `main` is accepted.
    if (entry.db != null) {
      if (typeof entry.db !== "string" || fold(entry.db) !== MAIN_DATABASE) {
        throw new TenantScopeError(
          `unsupported database qualifier "${String(entry.db)}" (only "${MAIN_DATABASE}" is allowed)`,
        );
      }
    } else if (ctes.has(fold(entry.table))) {
      // Unqualified reference to a CTE whose body has already been scoped.
      return entry;
    }

    const info = this.index.get(fold(entry.table));
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
 * Post-condition, verified on every call: re-parse the emitted SQL and prove
 * that every reference to a schema table is the sole FROM entry of a select
 * whose shape is exactly `SELECT * FROM t WHERE t.<tenant col> = <tenant id>`.
 * Parsing the output says nothing about tenancy; this check does. The scoper
 * is trusted only as far as this verifier can confirm its output.
 */
class Verifier {
  private readonly index: SchemaIndex;
  private readonly tenantId: number;

  constructor(index: SchemaIndex, tenantId: number) {
    this.index = index;
    this.tenantId = tenantId;
  }

  verify(sql: string): void {
    const parser = new Parser();
    let ast: unknown;
    try {
      ast = parser.astify(sql, PARSER_OPTIONS);
    } catch {
      throw new TenantScopeError("post-condition failed: emitted SQL does not re-parse");
    }
    if (Array.isArray(ast) || !isSelect(ast)) {
      throw new TenantScopeError("post-condition failed: emitted SQL is not a single SELECT");
    }
    this.verifySelect(ast, new Set());
  }

  private fail(reason: string): never {
    throw new TenantScopeError(`post-condition failed: ${reason}`);
  }

  private verifySelect(node: SelectNode, outerCtes: ReadonlySet<string>): void {
    // Mirror the scoper's name-resolution model exactly (recursive-aware CTE
    // ordering, qualified names never CTEs, scope inheritance into subqueries
    // and set-op branches) — but as a checker, not a mutator.
    const ctes = new Set(outerCtes);
    if (Array.isArray(node.with)) {
      for (const cte of node.with) {
        const name = cte?.name?.value;
        if (typeof name !== "string") this.fail("unsupported CTE shape");
        if (cte.recursive === true) ctes.add(fold(name));
        this.verifyNode(cte.stmt, ctes);
        if (cte.recursive !== true) ctes.add(fold(name));
      }
    }

    if (Array.isArray(node.from)) {
      for (const entry of node.from) this.verifyFromEntry(entry, node, ctes);
    } else if (node.from != null) {
      this.fail("unsupported FROM clause shape");
    }

    for (const [key, value] of Object.entries(node)) {
      if (key === "with" || key === "from" || key === "_next") continue;
      this.verifyNode(value, ctes);
    }

    if (node._next != null) {
      if (!isSelect(node._next)) this.fail("unsupported set operation branch");
      this.verifySelect(node._next, ctes);
    }
  }

  private verifyFromEntry(entry: FromEntry, parent: SelectNode, ctes: ReadonlySet<string>): void {
    if (typeof entry !== "object" || entry === null) this.fail("unsupported FROM entry");
    for (const key of Object.keys(entry)) {
      if (!FROM_ENTRY_KEYS.has(key)) this.fail(`unsupported FROM entry shape: "${key}"`);
    }
    if (typeof entry.as === "string" && JOIN_KEYWORDS.has(fold(entry.as))) {
      this.fail(`join-keyword alias "${entry.as}"`);
    }

    if (entry.on !== undefined) this.verifyNode(entry.on, ctes);

    // Derived table: verify whatever is inside. Non-subquery expressions
    // (table-valued functions) are never acceptable in scoped output.
    if (entry.expr !== undefined) {
      if (!isSubqueryExpr(entry.expr)) this.fail("non-subquery FROM expression");
      this.verifyNode(entry.expr, ctes);
      return;
    }

    if (typeof entry.table !== "string") this.fail("unsupported table reference");

    if (entry.db != null) {
      if (typeof entry.db !== "string" || fold(entry.db) !== MAIN_DATABASE) {
        this.fail(`unsupported database qualifier "${String(entry.db)}"`);
      }
    } else if (ctes.has(fold(entry.table))) {
      return; // CTE reference; its body was verified at definition.
    }

    const info = this.index.get(fold(entry.table));
    if (info === undefined) this.fail(`table "${entry.table}" is not in the schema`);

    // A base-table reference is only acceptable as the sole FROM entry of the
    // exact wrapper the scoper emits.
    if (!this.isWrapperSelect(parent, info)) {
      this.fail(`table "${info.name}" is referenced without tenant scoping`);
    }
  }

  /**
   * The wrapper shape: `SELECT * FROM <t> WHERE <t>.<tenant col> = <tenant id>`
   * with no WITH, set-ops, DISTINCT, GROUP BY, HAVING, ORDER BY, or LIMIT.
   */
  private isWrapperSelect(node: SelectNode, info: TableInfo): boolean {
    if (!Array.isArray(node.from) || node.from.length !== 1) return false;
    const sole = node.from[0];
    if (sole.expr !== undefined || typeof sole.table !== "string") return false;
    if (sole.as != null) return false;
    if (fold(sole.table) !== fold(info.name)) return false;
    if (sole.db != null && fold(sole.db) !== MAIN_DATABASE) return false;

    const empty = (v: unknown): boolean => v == null || (Array.isArray(v) && v.length === 0);
    if (!empty(node.with) || node._next != null) return false;
    for (const key of ["options", "distinct", "groupby", "having", "orderby", "limit", "for_update"]) {
      if (!empty(node[key])) return false;
    }

    if (!Array.isArray(node.columns) || node.columns.length !== 1) return false;
    const column = node.columns[0] as AstNode;
    const columnExpr = column.expr as AstNode | undefined;
    if (columnExpr?.type !== "column_ref" || columnExpr.column !== "*") return false;
    if ((column.as ?? null) !== null) return false;

    const where = node.where as AstNode | null | undefined;
    if (where == null || where.type !== "binary_expr" || where.operator !== "=") return false;
    const left = where.left as AstNode | undefined;
    const right = where.right as AstNode | undefined;
    if (left?.type !== "column_ref") return false;
    if (fold(String(left.column ?? "")) !== fold(info.tenantColumn)) return false;
    if (left.table != null && fold(String(left.table)) !== fold(info.name)) return false;
    // The parser re-reads large literals as `bigint` with a string value.
    if (right?.type === "number") return right.value === this.tenantId;
    if (right?.type === "bigint") return right.value === String(this.tenantId);
    return false;
  }

  /** Generic descent mirroring Scoper.walk. */
  private verifyNode(value: unknown, ctes: ReadonlySet<string>): void {
    if (Array.isArray(value)) {
      for (const item of value) this.verifyNode(item, ctes);
      return;
    }
    if (typeof value !== "object" || value === null) return;
    if (isSelect(value)) {
      this.verifySelect(value, ctes);
      return;
    }
    for (const child of Object.values(value)) this.verifyNode(child, ctes);
  }
}

/**
 * Standalone form of the post-condition main() runs on its output, exported
 * for tests. Throws TenantScopeError unless every schema-table reference in
 * `sql` sits under the exact tenant-filtered wrapper.
 */
export function assertFullyScoped(
  sql: string,
  schema: Schema,
  tenantId: number,
  tenantColumn: string,
): void {
  new Verifier(indexSchema(schema, tenantColumn), tenantId).verify(sql);
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

  // Post-condition on every call: the scoper's output must prove itself.
  new Verifier(index, tenantId).verify(sql);

  return sql;
}

// Only run when executed directly (not when imported by tests).
if (process.argv[1] === import.meta.filename) {
  console.log(main(schema, query, 1, "organization_id"));
}
