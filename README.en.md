# Better Links

<p>
  <a href="./README.md">简体中文</a> |
  <a href="./README.en.md"><strong>English</strong></a>
</p>

> Keep Obsidian heading links working after renames, cuts, and refactors.

In long-form note taking, precise links like `[[Note#Heading 1#Heading 2]]` are powerful, but they are also fragile. As soon as you rename a heading, move a section into another note, or change heading structure, native link tracking can fall behind.

**Better Links** is built for that exact problem. It tracks heading-path changes in the background and repairs affected internal links automatically.

## What It Does

### Automatic heading-rename repair

- Updates normal heading links
- Updates aliased heading links
- Supports nested paths such as `[[Note#Parent Heading#Child Heading]]`

### Automatic cut / paste move repair

- When a heading section is moved into another note, backlinks can be rewritten to the new file automatically
- Tries to preserve the original path shape instead of unnecessarily expanding it
- Supports nested heading paths during moves

### Manual repair fallback

- Includes a `Repair links in current file` command
- Useful when you want a second pass for edge cases not covered by the automatic flow

### Optimized for larger link sets

- Uses incremental indexing and redirect compaction
- Designed for heavier note refactors
- Includes built-in stress-test fixtures in this repository

## Who It Is For

- Users who rely heavily on heading-level links
- Writers who frequently reorganize long notes
- People who want long-form notes without losing precise internal linking

## Problems It Solves

| Scenario | Native Obsidian | Better Links |
| :--- | :--- | :--- |
| Rename a heading | Can miss updates or break | Automatically updates references |
| Move a heading to another note | Links often break | Rewrites them to the new file |
| Change nested heading paths | `[[#A#B]]` can become invalid | Recomputes and repairs the path |
| Large content refactors | Requires manual cleanup | Supports bulk repair workflows |

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

The repository includes stress-test fixtures under:

- `test-vault/stress-test/`

The current fixture includes two larger scenarios:

- Rename stress test: 80 backlink files, 400 links expected to update
- Move stress test: 80 backlink files, 400 links expected to update

To regenerate the fixture:

```powershell
npm run stress:reset
```

## Local Test Vault Sync

To sync the current build into the local test-vault plugin folder:

```powershell
powershell -ExecutionPolicy Bypass -File .\sync-test-vault.ps1
```

## Repository Layout

- `src/`: plugin source code
- `main.js`: current compiled build
- `scripts/generate-stress-test.mjs`: stress-test fixture generator
- `test-vault/stress-test/`: stress-test sample content

## Acknowledgements

This project evolves from the ideas and code of [obsidian-persistent-links](https://github.com/ivan-lednev/obsidian-persistent-links), with attribution preserved in accordance with the original MIT license.
