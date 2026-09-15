## Inputs

- a tenant-scoped SQLite schema (any schema; every referenced table must carry the tenant column)
- a SQLite `SELECT` query against that schema
- a valid tenant id (safe integer)
- the name of the tenant column (e.g. `organization_id`)

## Output

- a SQLite query that guarantees that the only rows that can be returned from the query belong to that tenant id

## How scoping works

Every base-table reference in the query, at any nesting depth, is replaced with a
tenant-filtered derived table:

```sql
SELECT u.email FROM users u LEFT JOIN projects p ON p.owner_id = u.id
-- becomes
SELECT "u"."email"
FROM (SELECT * FROM "users" WHERE "users"."organization_id" = 1) AS "u"
LEFT JOIN (SELECT * FROM "projects" WHERE "projects"."organization_id" = 1) AS "p"
  ON "p"."owner_id" = "u"."id"
```

Filtering at the source means joins, unions, subqueries, CTEs and `OR` predicates
never see a row from another tenant, and outer-join semantics are preserved.

## Rejected input (throws `TenantScopeError`)

- anything other than a single `SELECT` statement (DML, DDL, PRAGMA, multi-statement)
- a table not present in the supplied schema
- a referenced table that lacks the tenant column
- a non-integer tenant id, empty query, empty tenant column, or empty schema
- a database qualifier other than `main` (qualified names never resolve to CTEs)
- a table alias that is a join keyword (`natural`, `cross`, `outer`, `full`,
  `left`, `right`, `inner`, `using`, `on`) — fails closed on the parser's
  NATURAL/CROSS misparse
- a FROM entry with an unrecognized shape (unknown keys are rejected, not
  passed through)

## TODO

- **Test suite expansion** (agreed follow-up, not yet landed):
  - poisoned second tenant in the seed data (every value suffixed/offset so a
    leak is visible even when row shapes match) with a `assertNoPoison` oracle
    applied to every result — equality against a hand-written reference must
    not be the only oracle
  - leak regressions: CTE shadowing via qualified name
    (`WITH users AS (SELECT * FROM main.users) SELECT * FROM users`) and the
    unqualified self-shadow (emits scoped SQL that SQLite rejects at runtime
    with `circular reference`, same as the original query)
  - USING preserved; NATURAL/CROSS JOIN rejected; INTERSECT/EXCEPT and
    RIGHT/FULL JOIN rejection pinned (parser limitations)
  - quoted identifiers, self-joins, subqueries in ORDER BY/HAVING/CASE,
    plain UNION and parenthesized UNION branches, table-valued-function
    policy, tenant-id edge values (0, negative, MAX_SAFE_INTEGER), duplicate
    CTE names, deep-nesting DoS, and direct `assertFullyScoped` unit tests
- **Name-resolution re-audit writeup**: every place the rewriter decides what
  an identifier refers to (CTE vs base table, qualified vs unqualified, case
  folding, shadowing, scope inheritance into subqueries and set-op branches),
  checked against SQLite's actual behavior with doc citations.
- **Document the supported subset**: the parser (not the scoper) rejects some
  valid SQLite shapes — INTERSECT/EXCEPT, RIGHT/FULL JOIN, INDEXED BY,
  VALUES-in-FROM, bracket-quoted identifiers, parenthesized table names.
- **DoS hardening**: query-length / nesting-depth limits (deep nesting
  currently fails closed via the parser's stack limit, with a confusing
  "could not be parsed: Maximum call stack size exceeded" message).
- **Port the audit to the Python (sqlglot) implementation**: the same
  name-resolution bug class (CTE shadowing + qualifier handling) should be
  checked there; the post-condition verifier pattern should be mirrored.

## Dependencies

- node-sql-parser
