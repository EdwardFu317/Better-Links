# Better Links

> Make Obsidian heading links far more resilient.

In knowledge management, there is always a tradeoff. Highly atomic notes can become fragmented and hard to maintain, while longer notes make precise links like `[[Note#Heading 1#Heading 2]]` much more fragile.

When you rename headings, cut sections into another note, or change heading structure, native Obsidian link tracking can easily break down. **Better Links** is built to solve that problem.

## Core Features

### 1. Automatic refactor repair

When you **rename** content or **cut and paste** headings across notes, Better Links works in the background and automatically repairs affected links.

- Cross-file moves: move a heading and its child content into another file, and backlinks pointing to that heading are updated automatically.
- Parent-path awareness: Better Links detects the new heading context after a move so paths like `[[Note#Heading]]` and `[[Note#Parent#Child]]` stay accurate.

### 2. Deep heading tracking

Better Links is not limited to simple filename changes. It tracks nested heading paths such as `[[Note#Header1#Header2]]`, so deeper links can survive renames and moves as well.

### 3. Performance for large repairs

The plugin is designed for vaults with heavy internal linking. It uses incremental indexing and redirect compaction so large-scale restructures stay practical.

### 4. Smarter structure detection

- Detects heading moves caused by cut and paste.
- Handles heading-path resolution beyond a single level.
- Supports both direct heading links and nested heading links during repair.

## Problems It Solves

| Scenario | Native Obsidian | Better Links |
| :--- | :--- | :--- |
| Rename a heading | Partially supported, sometimes unreliable | Updates references automatically |
| Move a heading to another note | Links often break | Rewrites links to the new file |
| Change nested heading structure | `[[#A#B]]` can become invalid | Recomputes the correct nested path |
| Large content refactors | Manual cleanup | Bulk repair workflow |

## Recommended For

- Users who rely heavily on heading-level links.
- Long-form note writers who reorganize content often.
- Vaults with many backlinks and nested heading references.

## Development

Install dependencies:

```powershell
npm install
```

Build the plugin:

```powershell
npm run build
```

## Stress Test Content

This repository includes a stress-test vault fixture under `test-vault/stress-test/`.

To regenerate it:

```powershell
npm run stress:reset
```

## Local Test Vault Sync

To sync the current build into the local test-vault plugin folder:

```powershell
powershell -ExecutionPolicy Bypass -File .\sync-test-vault.ps1
```
