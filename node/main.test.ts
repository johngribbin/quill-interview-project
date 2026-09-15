import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";

import { main, schema, TenantScopeError, assertFullyScoped } from "./main.ts";

const TENANT_ID = 1;
const TENANT_COLUMN = "organization_id";

function seedDatabase(): DatabaseSync {
  const db = new DatabaseSync(":memory:");

  for (const table of schema) {
    const columns = table.columns.map((c) => `${c.name} ${c.type}`).join(", ");
    db.exec(`CREATE TABLE ${table.name} (${columns})`);
  }

  for (const organizationId of [1, 2, 3, 4, 5]) {
    db.exec(`INSERT INTO organizations (id, organization_id, name)
             VALUES (${organizationId}, ${organizationId}, 'Org ${organizationId}')`);

    for (let i = 0; i < 2; i++) {
      const userId = organizationId * 10 + i;
      db.exec(`INSERT INTO users (id, organization_id, email)
               VALUES (${userId}, ${organizationId}, 'user${userId}@example.com')`);
    }

    // One project per org, owned by that org's first user. Project ids are
    // chosen so that org 2's project references a user id that also exists in
    // org 1's numbering space would be a leak if scoping were wrong.
    const ownerId = organizationId * 10;
    db.exec(`INSERT INTO projects (id, organization_id, owner_id, title)
             VALUES (${organizationId * 100}, ${organizationId}, ${ownerId}, 'Project ${organizationId}')`);
  }

  // A cross-tenant reference: a project belonging to org 2 whose owner_id
  // points at a user in org 1. A naive join would let org 1 see it.
  db.exec(`INSERT INTO projects (id, organization_id, owner_id, title)
           VALUES (999, 2, 10, 'Leaked')`);

  return db;
}

type Row = Record<string, unknown>;

function run(db: DatabaseSync, sql: string): Row[] {
  // node:sqlite returns null-prototype objects; normalize for deepEqual.
  return (db.prepare(sql).all() as Row[]).map((row) => ({ ...row }));
}

/** Scope `query`, execute it, and assert its rows equal those of `reference`. */
function assertScopedEquals(db: DatabaseSync, query: string, reference: string): Row[] {
  const scoped = main(schema, query, TENANT_ID, TENANT_COLUMN);
  const actual = run(db, scoped);
  const expected = run(db, reference);
  assert.deepEqual(actual, expected, `scoped SQL was: ${scoped}`);
  return actual;
}

describe("basic scoping", () => {
  test("SELECT COUNT(*) only counts rows belonging to the tenant", () => {
    const db = seedDatabase();

    const scopedSql = main(schema, "SELECT COUNT(*) FROM users", TENANT_ID, TENANT_COLUMN);
    const [row] = run(db, scopedSql);

    const expected = db
      .prepare("SELECT COUNT(*) AS count FROM users WHERE organization_id = ?")
      .get(TENANT_ID) as { count: number };

    assert.equal(Object.values(row)[0], expected.count);
    assert.equal(expected.count, 2);
  });

  test("SELECT * returns only tenant rows", () => {
    const db = seedDatabase();
    const rows = assertScopedEquals(
      db,
      "SELECT * FROM users",
      "SELECT * FROM users WHERE organization_id = 1",
    );
    assert.equal(rows.length, 2);
    for (const row of rows) assert.equal(row.organization_id, TENANT_ID);
  });

  test("WHERE with a top-level OR cannot widen beyond the tenant", () => {
    const db = seedDatabase();
    const rows = assertScopedEquals(
      db,
      "SELECT * FROM users WHERE id = 10 OR 1 = 1",
      "SELECT * FROM users WHERE organization_id = 1",
    );
    assert.equal(rows.length, 2);
  });

  test("a caller-supplied tenant predicate for another tenant yields nothing", () => {
    const db = seedDatabase();
    const rows = assertScopedEquals(
      db,
      "SELECT * FROM users WHERE organization_id = 2",
      "SELECT * FROM users WHERE 0",
    );
    assert.equal(rows.length, 0);
  });

  test("GROUP BY / HAVING / ORDER BY / LIMIT are preserved", () => {
    const db = seedDatabase();
    assertScopedEquals(
      db,
      "SELECT organization_id, COUNT(*) AS n FROM users GROUP BY organization_id HAVING COUNT(*) > 0 ORDER BY n DESC LIMIT 5",
      "SELECT organization_id, COUNT(*) AS n FROM users WHERE organization_id = 1 GROUP BY organization_id HAVING COUNT(*) > 0 ORDER BY n DESC LIMIT 5",
    );
  });

  test("aliased table with qualified column references", () => {
    const db = seedDatabase();
    const rows = assertScopedEquals(
      db,
      "SELECT u.email FROM users u WHERE u.id > 0",
      "SELECT u.email FROM users u WHERE u.organization_id = 1 AND u.id > 0",
    );
    assert.equal(rows.length, 2);
  });

  test("schema-qualified table names are handled", () => {
    const db = seedDatabase();
    assertScopedEquals(
      db,
      "SELECT * FROM main.users",
      "SELECT * FROM users WHERE organization_id = 1",
    );
  });

  test("table name matching is case-insensitive like SQLite", () => {
    const db = seedDatabase();
    assertScopedEquals(
      db,
      "SELECT * FROM USERS",
      "SELECT * FROM users WHERE organization_id = 1",
    );
  });
});

describe("joins", () => {
  test("INNER JOIN scopes both sides and excludes the cross-tenant project", () => {
    const db = seedDatabase();
    const rows = assertScopedEquals(
      db,
      "SELECT p.id, p.title FROM users u JOIN projects p ON p.owner_id = u.id",
      "SELECT p.id, p.title FROM users u JOIN projects p ON p.owner_id = u.id WHERE u.organization_id = 1 AND p.organization_id = 1",
    );
    assert.deepEqual(rows, [{ id: 100, title: "Project 1" }]);
  });

  test("LEFT JOIN keeps outer-join semantics", () => {
    const db = seedDatabase();
    const rows = assertScopedEquals(
      db,
      "SELECT u.id, p.id AS project_id FROM users u LEFT JOIN projects p ON p.owner_id = u.id ORDER BY u.id",
      "SELECT u.id, p.id AS project_id FROM users u LEFT JOIN (SELECT * FROM projects WHERE organization_id = 1) p ON p.owner_id = u.id WHERE u.organization_id = 1 ORDER BY u.id",
    );
    // Both tenant users present; the one without a project keeps a NULL.
    assert.deepEqual(rows, [
      { id: 10, project_id: 100 },
      { id: 11, project_id: null },
    ]);
  });

  test("comma join is scoped on every table", () => {
    const db = seedDatabase();
    const rows = assertScopedEquals(
      db,
      "SELECT COUNT(*) AS n FROM users, projects",
      "SELECT COUNT(*) AS n FROM users, projects WHERE users.organization_id = 1 AND projects.organization_id = 1",
    );
    assert.deepEqual(rows, [{ n: 2 }]);
  });

  test("join without aliases uses the table name as the alias", () => {
    const db = seedDatabase();
    assertScopedEquals(
      db,
      "SELECT projects.title FROM users JOIN projects ON projects.owner_id = users.id",
      "SELECT projects.title FROM users JOIN projects ON projects.owner_id = users.id WHERE users.organization_id = 1 AND projects.organization_id = 1",
    );
  });

  test("subquery inside an ON clause is scoped", () => {
    const db = seedDatabase();
    assertScopedEquals(
      db,
      "SELECT p.id FROM users u JOIN projects p ON p.owner_id = u.id AND p.id IN (SELECT id FROM projects)",
      "SELECT p.id FROM users u JOIN projects p ON p.owner_id = u.id WHERE u.organization_id = 1 AND p.organization_id = 1",
    );
  });
});

describe("subqueries, CTEs, set operations", () => {
  test("derived table in FROM", () => {
    const db = seedDatabase();
    const rows = assertScopedEquals(
      db,
      "SELECT COUNT(*) AS n FROM (SELECT * FROM users) AS sub",
      "SELECT COUNT(*) AS n FROM users WHERE organization_id = 1",
    );
    assert.deepEqual(rows, [{ n: 2 }]);
  });

  test("IN subquery is scoped so cross-tenant ids do not match", () => {
    const db = seedDatabase();
    const rows = assertScopedEquals(
      db,
      "SELECT id FROM users WHERE id IN (SELECT owner_id FROM projects)",
      "SELECT id FROM users WHERE organization_id = 1 AND id IN (SELECT owner_id FROM projects WHERE organization_id = 1)",
    );
    assert.deepEqual(rows, [{ id: 10 }]);
  });

  test("EXISTS subquery is scoped", () => {
    const db = seedDatabase();
    assertScopedEquals(
      db,
      "SELECT id FROM users u WHERE EXISTS (SELECT 1 FROM projects p WHERE p.owner_id = u.id)",
      "SELECT id FROM users u WHERE u.organization_id = 1 AND EXISTS (SELECT 1 FROM projects p WHERE p.organization_id = 1 AND p.owner_id = u.id)",
    );
  });

  test("scalar subquery in the column list is scoped", () => {
    const db = seedDatabase();
    const rows = assertScopedEquals(
      db,
      "SELECT (SELECT COUNT(*) FROM projects) AS n FROM users LIMIT 1",
      "SELECT (SELECT COUNT(*) FROM projects WHERE organization_id = 1) AS n FROM users WHERE organization_id = 1 LIMIT 1",
    );
    assert.deepEqual(rows, [{ n: 1 }]);
  });

  test("UNION ALL scopes every branch", () => {
    const db = seedDatabase();
    const rows = assertScopedEquals(
      db,
      "SELECT id FROM users UNION ALL SELECT id FROM projects",
      "SELECT id FROM users WHERE organization_id = 1 UNION ALL SELECT id FROM projects WHERE organization_id = 1",
    );
    assert.equal(rows.length, 3);
  });

  test("CTE body is scoped and the CTE reference is left alone", () => {
    const db = seedDatabase();
    const rows = assertScopedEquals(
      db,
      "WITH x AS (SELECT * FROM users) SELECT COUNT(*) AS n FROM x",
      "SELECT COUNT(*) AS n FROM users WHERE organization_id = 1",
    );
    assert.deepEqual(rows, [{ n: 2 }]);
  });

  test("CTE that shadows a schema table name", () => {
    const db = seedDatabase();
    const rows = assertScopedEquals(
      db,
      "WITH users AS (SELECT * FROM projects) SELECT COUNT(*) AS n FROM users",
      "SELECT COUNT(*) AS n FROM projects WHERE organization_id = 1",
    );
    assert.deepEqual(rows, [{ n: 1 }]);
  });

  test("later CTE referencing an earlier one", () => {
    const db = seedDatabase();
    assertScopedEquals(
      db,
      "WITH a AS (SELECT * FROM users), b AS (SELECT id FROM a) SELECT * FROM b",
      "SELECT id FROM users WHERE organization_id = 1",
    );
  });

  test("subquery nested inside a derived table", () => {
    const db = seedDatabase();
    const rows = assertScopedEquals(
      db,
      "SELECT * FROM (SELECT id FROM users WHERE id IN (SELECT owner_id FROM projects)) AS t",
      "SELECT id FROM users WHERE organization_id = 1 AND id IN (SELECT owner_id FROM projects WHERE organization_id = 1)",
    );
    assert.deepEqual(rows, [{ id: 10 }]);
  });
});

describe("schema flexibility", () => {
  const customSchema = [
    {
      name: "accounts",
      columns: [
        { name: "id", type: "integer" as const },
        { name: "account_id", type: "integer" as const },
      ],
    },
    {
      name: "invoices",
      columns: [
        { name: "id", type: "integer" as const },
        { name: "account_id", type: "integer" as const },
        { name: "amount", type: "integer" as const },
      ],
    },
  ];

  function seedCustom(): DatabaseSync {
    const db = new DatabaseSync(":memory:");
    db.exec("CREATE TABLE accounts (id integer, account_id integer)");
    db.exec("CREATE TABLE invoices (id integer, account_id integer, amount integer)");
    db.exec("INSERT INTO invoices VALUES (1, 7, 100), (2, 7, 200), (3, 8, 300)");
    return db;
  }

  test("a different schema and tenant column name work without code changes", () => {
    const db = seedCustom();
    const sql = main(customSchema, "SELECT SUM(amount) AS total FROM invoices", 7, "account_id");
    assert.deepEqual(run(db, sql), [{ total: 300 }]);
  });

  test("tenant column lookup is case-insensitive", () => {
    const db = seedCustom();
    const sql = main(customSchema, "SELECT COUNT(*) AS n FROM invoices", 8, "ACCOUNT_ID");
    assert.deepEqual(run(db, sql), [{ n: 1 }]);
  });

  test("a table in the schema without the tenant column is rejected", () => {
    const noTenant = [
      { name: "shared", columns: [{ name: "id", type: "integer" as const }] },
    ];
    assert.throws(
      () => main(noTenant, "SELECT * FROM shared", 1, "organization_id"),
      (e: unknown) => e instanceof TenantScopeError && /no tenant column/.test((e as Error).message),
    );
  });

  test("the hardcoded schema is not used when a different one is passed", () => {
    assert.throws(
      () => main(customSchema, "SELECT * FROM users", 1, "account_id"),
      (e: unknown) => e instanceof TenantScopeError && /not in the schema/.test((e as Error).message),
    );
  });
});

describe("rejected input", () => {
  const rejects = (query: string, pattern: RegExp) => {
    assert.throws(
      () => main(schema, query, TENANT_ID, TENANT_COLUMN),
      (e: unknown) => {
        assert.ok(e instanceof TenantScopeError, `expected TenantScopeError, got ${String(e)}`);
        assert.match(e.message, pattern);
        return true;
      },
    );
  };

  test("unknown table", () => rejects("SELECT * FROM sqlite_master", /not in the schema/));
  test("unknown table inside a subquery", () =>
    rejects("SELECT * FROM users WHERE id IN (SELECT id FROM secrets)", /not in the schema/));
  test("unknown table in a UNION branch", () =>
    rejects("SELECT id FROM users UNION SELECT id FROM secrets", /not in the schema/));
  test("DELETE", () => rejects("DELETE FROM users", /only SELECT/));
  test("UPDATE", () => rejects("UPDATE users SET email = 'x'", /only SELECT/));
  test("INSERT", () => rejects("INSERT INTO users (id) VALUES (1)", /only SELECT/));
  test("multiple statements", () =>
    rejects("SELECT * FROM users; SELECT * FROM projects", /single statement/));
  test("unparseable SQL", () => rejects("SELEC * FORM users", /could not be parsed/));
  test("PRAGMA", () => rejects("PRAGMA table_info(users)", /could not be parsed/));
  test("empty query", () => rejects("   ", /non-empty string/));

  test("non-integer tenant ids", () => {
    for (const bad of [1.5, NaN, Infinity, "1", null, undefined]) {
      assert.throws(
        () => main(schema, "SELECT * FROM users", bad as unknown as number, TENANT_COLUMN),
        TenantScopeError,
      );
    }
  });

  test("empty tenant column name", () => {
    assert.throws(() => main(schema, "SELECT * FROM users", 1, ""), TenantScopeError);
  });

  test("empty schema", () => {
    assert.throws(() => main([], "SELECT * FROM users", 1, TENANT_COLUMN), TenantScopeError);
  });

  test("duplicate table names in schema", () => {
    const dup = [schema[1], { ...schema[1], name: "USERS" }];
    assert.throws(() => main(dup, "SELECT * FROM users", 1, TENANT_COLUMN), /twice/);
  });
});

describe("output", () => {
  test("scoped SQL is valid and idempotent under re-scoping", () => {
    const db = seedDatabase();
    const once = main(schema, "SELECT * FROM users u JOIN projects p ON p.owner_id = u.id", TENANT_ID, TENANT_COLUMN);
    const twice = main(schema, once, TENANT_ID, TENANT_COLUMN);
    assert.deepEqual(run(db, twice), run(db, once));
  });

  test("tenant id is emitted as a numeric literal", () => {
    const sql = main(schema, "SELECT * FROM users", 42, TENANT_COLUMN);
    assert.match(sql, /"organization_id" = 42\b/);
    assert.doesNotMatch(sql, /'42'/);
  });
});

describe("name resolution and hardening", () => {
  const rejects = (query: string, pattern: RegExp) => {
    assert.throws(
      () => main(schema, query, TENANT_ID, TENANT_COLUMN),
      (e: unknown) => {
        assert.ok(e instanceof TenantScopeError, `expected TenantScopeError, got ${String(e)}`);
        assert.match(e.message, pattern);
        return true;
      },
    );
  };

  test("CTE shadowing a table via a qualified name still scopes the base table", () => {
    const db = seedDatabase();
    const rows = assertScopedEquals(
      db,
      "WITH users AS (SELECT * FROM main.users) SELECT COUNT(*) AS n FROM users",
      "SELECT COUNT(*) AS n FROM users WHERE organization_id = 1",
    );
    assert.deepEqual(rows, [{ n: 2 }]);
  });

  test("unqualified CTE self-shadow emits scoped SQL that SQLite rejects as circular", () => {
    const db = seedDatabase();
    const sql = main(schema, "WITH users AS (SELECT * FROM users) SELECT * FROM users", TENANT_ID, TENANT_COLUMN);
    assert.match(sql, /"organization_id" = 1/);
    assert.throws(() => run(db, sql), /circular reference/);
  });

  test("recursive CTE that does not touch schema tables is passed through", () => {
    const db = seedDatabase();
    const rows = assertScopedEquals(
      db,
      "WITH RECURSIVE c(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM c WHERE n < 3) SELECT COUNT(*) AS n FROM c, users",
      "WITH RECURSIVE c(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM c WHERE n < 3) SELECT COUNT(*) AS n FROM c, users WHERE users.organization_id = 1",
    );
    assert.deepEqual(rows, [{ n: 6 }]);
  });

  test("CTE scope does not leak into a sibling subquery", () => {
    const db = seedDatabase();
    assertScopedEquals(
      db,
      "SELECT (SELECT COUNT(*) FROM (WITH users AS (SELECT * FROM projects) SELECT * FROM users)) AS p, (SELECT COUNT(*) FROM users) AS u",
      "SELECT (SELECT COUNT(*) FROM projects WHERE organization_id = 1) AS p, (SELECT COUNT(*) FROM users WHERE organization_id = 1) AS u",
    );
  });

  test("JOIN ... USING is preserved", () => {
    const db = seedDatabase();
    const sql = main(schema, "SELECT COUNT(*) AS n FROM users JOIN projects USING (organization_id)", TENANT_ID, TENANT_COLUMN);
    assert.match(sql, /USING \(organization_id\)/);
    // Tenant 1 has two users and one project sharing organization_id.
    assert.deepEqual(run(db, sql), [{ n: 2 }]);
  });

  test("qualified main.* names are scoped; other qualifiers are rejected", () => {
    const db = seedDatabase();
    assertScopedEquals(
      db,
      "SELECT COUNT(*) AS n FROM Main.Users u JOIN main.projects p ON p.owner_id = u.id",
      "SELECT COUNT(*) AS n FROM users u JOIN projects p ON p.owner_id = u.id WHERE u.organization_id = 1 AND p.organization_id = 1",
    );
    rejects("SELECT * FROM temp.users", /database qualifier/);
    rejects("SELECT * FROM other.users", /database qualifier/);
  });

  test("NATURAL and CROSS joins are rejected (parser misparse)", () => {
    rejects("SELECT * FROM users NATURAL JOIN projects", /join keyword/);
    rejects("SELECT * FROM users CROSS JOIN projects", /join keyword/);
    rejects("SELECT * FROM users AS cross", /join keyword/);
  });

  test("table-valued functions in FROM are rejected", () => {
    rejects("SELECT * FROM pragma_table_info('users')", /table-valued/);
    rejects("SELECT * FROM users, json_each('[1]')", /table-valued/);
    rejects("SELECT * FROM users WHERE id IN (SELECT value FROM json_each('[10]'))", /table-valued/);
  });

  test("schema identifiers must be plain", () => {
    const badTable = [{ name: 'users" --', columns: [{ name: "organization_id", type: "integer" as const }] }];
    assert.throws(() => main(badTable, "SELECT * FROM users", 1, TENANT_COLUMN), /not a plain identifier/);
    const badColumn = [{ name: "users", columns: [{ name: 'organization_id" OR 1=1 OR "', type: "integer" as const }] }];
    assert.throws(() => main(badColumn, "SELECT * FROM users", 1, 'organization_id" OR 1=1 OR "'), /not a plain identifier/);
  });

  test("tenant id edge values are emitted as literals", () => {
    for (const id of [0, -5, Number.MAX_SAFE_INTEGER]) {
      const sql = main(schema, "SELECT * FROM users", id, TENANT_COLUMN);
      assert.match(sql, new RegExp(`"organization_id" = ${id}(?![0-9])`));
    }
  });

  test("deep nesting fails closed with a typed error", () => {
    const depth = 5000;
    const q = "SELECT * FROM " + "(SELECT * FROM ".repeat(depth) + "users" + ")".repeat(depth);
    assert.throws(() => main(schema, q, TENANT_ID, TENANT_COLUMN), TenantScopeError);
  });
});

describe("post-condition verifier", () => {
  const W = (where: string, alias = "users") =>
    `SELECT * FROM (SELECT * FROM "users" WHERE ${where}) AS "${alias}"`;

  test("accepts the exact wrapper shape, including bigint tenant ids", () => {
    assertFullyScoped(W('"users"."organization_id" = 1'), schema, 1, TENANT_COLUMN);
    assertFullyScoped(W('"users"."organization_id" = 1', "u"), schema, 1, TENANT_COLUMN);
    const big = Number.MAX_SAFE_INTEGER;
    assertFullyScoped(W(`"users"."organization_id" = ${big}`), schema, big, TENANT_COLUMN);
  });

  test("rejects unscoped or mis-scoped SQL", () => {
    const bad = [
      'SELECT * FROM "users"',
      W('"users"."organization_id" = 2'),
      W('"users"."organization_id" = 1 OR 1 = 1'),
      W('"email" = 1'),
      'SELECT * FROM (SELECT * FROM "users" WHERE "users"."organization_id" = 1) AS "u", "projects"',
      'SELECT * FROM (SELECT * FROM "users" WHERE "users"."organization_id" = 1 UNION ALL SELECT * FROM "users") AS "u"',
      'SELECT * FROM (SELECT *, 1 FROM "users" WHERE "users"."organization_id" = 1) AS "u"',
      'SELECT * FROM (SELECT * FROM "users" u2 WHERE "u2"."organization_id" = 1) AS "u"',
      'SELECT * FROM (SELECT * FROM "users" WHERE "users"."organization_id" = 1) AS "u" WHERE "id" IN (SELECT "id" FROM "projects")',
      'SELECT * FROM json_each(\'[1]\')',
    ];
    for (const sql of bad) {
      assert.throws(
        () => assertFullyScoped(sql, schema, 1, TENANT_COLUMN),
        (e: unknown) => e instanceof TenantScopeError && /post-condition/.test((e as Error).message),
        `verifier accepted: ${sql}`,
      );
    }
  });
});
