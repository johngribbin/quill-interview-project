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

## Dependencies

- node-sql-parser
