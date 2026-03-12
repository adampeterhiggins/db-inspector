# DB Inspector (VS Code Extension)

DB Inspector brings a DataGrip-style database workflow into VS Code:

- Saved connection profiles for PostgreSQL, MySQL, and SQLite
- Tree explorer for schemas, tables, views, functions
- Deep table inspection (columns, indexes, constraints)
- One-click table data preview in a result grid
- SQL editor execution with per-document connection targeting
- Inline `Run Query` buttons above SQL statements (CodeLens)
- DDL viewer for tables/views/functions

## What is implemented

### Explorer

- Activity Bar container: **DB Inspector**
- Connection nodes with connect/disconnect/edit/delete actions
- Schema/object browsing after connection
- Object types:
  - Tables
  - Views
  - Functions (where supported)

### Query workflow

- Command: `DB Inspector: Open SQL Editor`
- Command: `DB Inspector: Run Query`
- Query source:
  - Active selection, or
  - Entire SQL document when nothing is selected
- Active connection shown in status bar (`DB: ...`)
- Results open in a side webview table with row count and duration

### Inspection workflow

- Table context command: `Preview Table Data`
- Object context command: `Show Object DDL`

## Build and run

```bash
npm install
npm run compile
```

Then run extension development host from VS Code:

1. Open this folder in VS Code
2. Press `F5`
3. In the Extension Development Host window, open **DB Inspector** in the activity bar

## Packaging

```bash
npm run package
```

This produces a `.vsix` you can install manually.

## Extension settings

- `dbInspector.previewRowLimit` (default `200`)
- `dbInspector.connectOnExpand` (default `true`)
- `dbInspector.enableQueryCodeLens` (default `true`)

## Notes

- Passwords are stored in VS Code Secret Storage.
- For PostgreSQL table DDL, DB Inspector synthesizes `CREATE TABLE` from metadata.
- MySQL and SQLite use native `SHOW CREATE ...` / `sqlite_master` metadata where available.
