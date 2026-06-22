# Publishing the SANIX VSCode Extension

This guide covers everything you need to publish the SANIX VSCode extension (`istiak-ahamed.sanix`) to the [Visual Studio Code Marketplace](https://marketplace.visualstudio.com/), from one-off local `.vsix` builds all the way to a fully automated GitHub Actions release pipeline. Read it once end-to-end before your first publish; bookmark it for the recipe you need at publish time.

---

## 1. Prerequisites

You need three things before you can publish:

1. **A VS Code Marketplace publisher account** (free). Create one at <https://marketplace.visualstudio.com/manage/publishers>. Sign in with the same Microsoft / GitHub account you'll use for all future publishes — **the publisher id is permanent** and is the namespace under which every version of every extension you ever publish will live. Pick a stable identifier (the SANIX extension uses `istiak-ahamed`).
2. **A Personal Access Token (PAT) from Azure DevOps.** The Marketplace authentication backend is Azure DevOps, not Microsoft Accounts — so even if you've never used Azure DevOps, you'll create a token there. Visit <https://dev.azure.com/> and:
   - If you don't yet have an organization, create one (any name is fine; it's just an OAuth container).
   - Open **User settings → Personal access tokens** (`https://dev.azure.com/<your-org>/_usersSettings/tokens`).
   - Click **New Token**.
   - **Name:** `vsce-publish` (or anything you'll recognize).
   - **Organization:** select **All accessible accounts** (this is critical — picking a single org scopes the token too narrowly and vsce will reject it).
   - **Expiration:** 1 year is the maximum. **Set a calendar reminder** to renew it before it expires — a publish that fails with `Personal Access Token verification failed` is almost always an expired PAT.
   - **Scopes:** under "Marketplace", tick **Acquire** and **Manage**. (If "Marketplace" is missing from the scopes list, your org isn't yet linked to your publisher account — go back to the Marketplace manage page and link it.)
   - Click **Create** and **copy the token immediately** — Azure DevOps never shows it again.
3. **`@vscode/vsce`** (the new package name; the old `vsce` CLI is deprecated). It's already a devDependency in this package (`packages/vscode/package.json` → `devDependencies["@vscode/vsce"]`). If you're working outside this repo, install it globally: `npm install -g @vscode/vsce`.

---

## 2. First-time publisher setup

Once you have your PAT, log in once:

```bash
cd packages/vscode
vsce login istiak-ahamed
```

Paste the PAT when prompted. vsce stores it in your OS keychain (macOS Keychain, Windows Credential Manager, or libsecret on Linux). You'll never need to paste it again on this machine — `vsce publish` reads it from the keychain automatically. Run `vsce logout istiak-ahamed` to clear it.

---

## 3. Packaging for local testing

Before publishing to the Marketplace, **always** build a `.vsix` and install it locally to smoke-test:

```bash
cd packages/vscode
npm run package
# → produces sanix-<version>.vsix (e.g. sanix-1.0.0.vsix)
```

The `package` script runs `npm run build` first (esbuild bundles `src/extension.ts` → `dist/extension.js` and copies the webview assets into `dist/webview/`), then invokes `vsce package --no-yarn --no-dependencies`. The `--no-dependencies` flag is required in this monorepo because the workspace `packages/providers` tree contains a broken dependency path that breaks `npm ls` — disabling dependency detection doesn't affect the runtime extension (which bundles its own code via esbuild and only depends on the `vscode` API).

Install the `.vsix` into your local VS Code:

```bash
code --install-extension sanix-1.0.0.vsix
```

Verify:

```bash
code --list-extensions | grep sanix
# → istiak-ahamed.sanix@1.0.0
```

Open the SANIX activity-bar icon, type a message, run a slash command — make sure nothing crashes. To uninstall:

```bash
code --uninstall-extension istiak-ahamed.sanix
```

---

## 4. Publishing to the Marketplace

Once local testing passes:

1. Verify `packages/vscode/package.json` has all required fields populated (`publisher`, `version`, `repository`, `license`, `categories`, `keywords`, `icon`, `displayName`, `description`, `bugs`, `homepage`). vsce will refuse to package if any are missing.
2. Bump the `version` field (see §5 below).
3. Update `CHANGELOG.md` with the new version's entry.
4. Run:

```bash
cd packages/vscode
npm run publish
```

`vsce publish` will:
1. Run `npm run build` (via the script we set up).
2. Package the extension into a temporary `.vsix`.
3. Validate the manifest against the Marketplace's schema (publisher id, version uniqueness against already-published versions, icon dimensions, README presence, etc.).
4. Upload the `.vsix` to the Marketplace.
5. Return a URL like `https://marketplace.visualstudio.com/items?itemName=istiak-ahamed.sanix` where you can view the live extension page.

The extension is typically searchable + installable from within VS Code within 5–10 minutes. The Marketplace web page is updated almost immediately.

---

## 5. Versioning

Use [Semantic Versioning](https://semver.org/): `MAJOR.MINOR.PATCH`.

- **Patch** (`1.0.0 → 1.0.1`): bug fixes only — no new features, no breaking changes.
- **Minor** (`1.0.0 → 1.1.0`): new features, fully backward compatible.
- **Major** (`1.0.0 → 2.0.0`): breaking changes (renamed commands, removed settings, changed API surface).

Bump before each publish. The convenience commands bump + publish in one step:

```bash
vsce publish patch    # 1.0.0 → 1.0.1
vsce publish minor    # 1.0.0 → 1.1.0
vsce publish major    # 1.0.0 → 2.0.0
```

Each invocation also creates a git tag (`v1.0.1`) by default — pass `--no-git-tag-version` to skip that. Update `CHANGELOG.md` *before* running the publish, so the Marketplace's "Changes" tab picks up the new entry from the published `.vsix`.

---

## 6. Pre-release versions

For beta-testing new features with early adopters:

```bash
npm run publish:pre
```

This passes `--pre-release` to `vsce publish`. Users opt in via the **Install Pre-Release** dropdown on the extension's Marketplace page or in VS Code's Extensions view. Pre-release versions live alongside stable ones under the same extension id; users can switch between them at will. Use pre-releases for:

- Risky refactors of the chat webview.
- New dependencies (e.g. introducing a new `@sanix/*` import) that haven't been battle-tested.
- Experimental commands gated behind a `sanix.enableExperimental` flag.

---

## 7. Updating an existing extension

To push a new version of an already-published extension:

1. Make your code changes.
2. Bump `version` in `package.json` (or use `vsce publish patch/minor/major`).
3. Update `CHANGELOG.md`.
4. Run `npm run publish` again.

vsce overwrites the old version on the Marketplace. **Never** change the `name` or `publisher` fields — they are the marketplace identity. Renaming requires unpublishing the old one and publishing a fresh one (which loses your install count, ratings, and reviews).

---

## 8. Unpublishing

```bash
vsce unpublish istiak-ahamed.sanix
```

This removes the extension from the Marketplace's search results and "Install" buttons. The Marketplace keeps the listing URL alive for 30 days so existing installs keep working (otherwise users would see "Extension not found" errors). After 30 days the listing is gone for good. **Unpublishing is irreversible** — there's no undo. If you want to keep the id but stop new installs, prefer unpublishing over deleting the underlying publisher account.

---

## 9. CI/CD with GitHub Actions

The extension now lives inside the CLI monorepo at `packages/vscode/`. The CI/CD workflow at `.github/workflows/publish-vscode-extension.yml` handles everything:

- **On push to `main`** that touches `packages/vscode/**` or `packages/cli/**`:
  1. Builds all CLI packages via turbo
  2. Bundles the CLI runtime into the extension via `scripts/build-cli.js`
  3. Builds the extension (esbuild) & packages the VSIX
  4. Uploads the `.vsix` as a workflow artifact (90-day retention)

- **On tag push matching `vscode-v*`**: everything above, plus:
  1. Publishes the `.vsix` to the VS Code Marketplace
  2. Creates a GitHub Release with the `.vsix` attached
  3. Writes a summary with the Marketplace URL

### 9.1 One-time setup

1. **Add `VSCE_TOKEN` secret**: In your repo settings → **Secrets and variables → Actions**, add a secret named `VSCE_TOKEN` whose value is the Azure DevOps PAT from §1 above.
2. **Update CHANGELOG.md** before tagging — the Marketplace pulls release notes from the published `.vsix`'s bundled `CHANGELOG.md`.

### 9.2 Triggering a release

```bash
# Bump version in packages/vscode/package.json first
# Update packages/vscode/CHANGELOG.md
git add packages/vscode/
git commit -m "bump vscode extension to 1.0.1"
git tag vscode-v1.0.1
git push origin main --tags
```

The workflow will:
1. Build all CLI packages (turbo)
2. Bundle the CLI runtime into the extension
3. Build & package the `.vsix`
4. **Verify the tag version matches** `packages/vscode/package.json` version (fails fast on mismatch)
5. Publish to Marketplace via `vsce publish`
6. Create a GitHub Release with the `.vsix` attached

### 9.3 Workflow file

The actual workflow is at `.github/workflows/publish-vscode-extension.yml` — the same file handles both CI (push to main) and CD (tag push). The tag-only publish gate means accidental pushes to `main` never publish — only deliberate tag pushes do.

### 9.4 Publishing from `main` without a tag

Use `workflow_dispatch`:
1. Go to **Actions → Publish VSCode Extension → Run workflow**
2. Enter the version number (must match `packages/vscode/package.json`)
3. The workflow builds + publishes + creates a release

---

## 10. Verifying the published extension

After publishing, visit the live Marketplace page:

<https://marketplace.visualstudio.com/items?itemName=istiak-ahamed.sanix>

There you can see:
- **Install count** (rolling 30-day + all-time).
- **Download count** (direct `.vsix` downloads).
- **Average rating** + individual reviews — respond to user feedback in the **Reviews** tab; the publisher account is the reply author.
- **Version history** — every published version is listed with its release notes (pulled from `CHANGELOG.md`).

Use the **Marketplace Publisher Dashboard** at <https://marketplace.visualstudio.com/manage/publishers/istiak-ahamed> to see aggregate stats, manage publisher metadata (display name, logo, support email), and unpublish old versions.

---

## 11. Troubleshooting publish failures

| Error message | Cause | Fix |
| --- | --- | --- |
| `Personal Access Token verification failed` | PAT expired or wrong scope | Re-create PAT with **Marketplace > Manage** scope under "All accessible accounts" |
| `Extension with id 'istiak-ahamed.sanix' already exists` | A different publisher owns that id | Pick a different `name` or `publisher`. The Marketplace doesn't arbitrate id conflicts. |
| `README.md not found` | vsce requires a README at the package root | Ensure `packages/vscode/README.md` exists. Pass `--readme-path` to override. |
| `Icon not found: media/icon.png` | The `icon` field points to a missing file | Verify the file exists and is a PNG ≥128×128 (square). Ideal size ≤4 KB. |
| `The published extension is not valid: ...` | Various manifest issues | Run `vsce package --no-yarn --no-dependencies` locally first — vsce's local validator catches 90% of issues before upload. |
| `ERROR  currentLevel is undefined for home in <path>` | (Monorepo-specific) vsce's dependency walker hit a broken `packages/providers/providers` symlink | Use `--no-dependencies` (already baked into our `package`/`publish` scripts) |
| `Git working tree dirty` | vsce refuses to publish with uncommitted changes by default | Commit your changes, or pass `--skip-login` (not recommended) |

---

## 12. Rollback

The Marketplace does **not** support version rollback. However, you can effectively roll back by re-publishing an older version number — e.g. if `1.0.1` is buggy, publish `1.0.0` again with a fresh `vsce publish 1.0.0` (yes, the Marketplace allows re-publishing an older version). Users who had auto-update on will be downgraded; users with auto-update off won't be affected.

For critical bugs, the right move is almost always: bump + publish a fixed version (`1.0.2`) immediately. Don't wait for the next regular release cycle — the Marketplace's CDN propagates a new version to all users within an hour of publish.

---

## Appendix A: One-page cheat sheet

```bash
# Local .vsix build
cd packages/vscode && npm run package

# Install locally
code --install-extension sanix-1.0.0.vsix

# Publish stable
vsce login istiak-ahamed    # one-time
npm run publish              # builds + packages + uploads

# Publish pre-release
npm run publish:pre

# Bump + publish in one step
vsce publish patch           # 1.0.0 → 1.0.1
vsce publish minor           # 1.0.0 → 1.1.0
vsce publish major           # 1.0.0 → 2.0.0

# Unpublish
vsce unpublish istiak-ahamed.sanix
```

## Appendix B: Required `package.json` fields checklist

Before every publish, confirm:

- [ ] `name` — lowercase, no spaces, hyphen-separated
- [ ] `publisher` — your Marketplace publisher id
- [ ] `version` — semver, bumped since the last publish
- [ ] `engines.vscode` — minimum supported VS Code version
- [ ] `main` — path to the bundled entry point (typically `./dist/extension.js`)
- [ ] `repository` — `{type, url, directory}` object
- [ ] `license` — `"MIT"` (or your license's SPDX id)
- [ ] `categories` — array of Marketplace categories (max 3)
- [ ] `keywords` — array of search keywords
- [ ] `icon` — relative path to a square PNG ≥128×128
- [ ] `displayName` — human-friendly name (shown in the Extensions view)
- [ ] `description` — one-sentence summary (shown in search results)
- [ ] `bugs.url` — issue tracker URL
- [ ] `homepage` — extension landing page URL
- [ ] `activationEvents` — list of activation triggers
- [ ] `contributes` — commands, configuration, views, menus, keybindings, colors

Run `vsce package --no-yarn --no-dependencies` locally — if it succeeds without warnings, the publish will too.
