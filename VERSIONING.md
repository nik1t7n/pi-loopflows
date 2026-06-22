# Versioning

`pi-loopflows` uses semantic versioning: `MAJOR.MINOR.PATCH`.

## PATCH: `0.1.x`

Use a patch release for safe, backward-compatible changes:

- README, docs, examples, wording, metadata;
- bug fixes that do not change workflow file shape;
- bundled loopflow prompt improvements that keep the same behavior contract;
- validation/typecheck/test improvements;
- internal refactors with no user-facing API changes.

Example: `0.1.2 -> 0.1.3`.

## MINOR: `0.x.0`

Use a minor release for new backward-compatible capability:

- new bundled loopflows;
- new loopflow fields that old files do not need;
- new commands/tools/options;
- new adapter backend support;
- expanded artifact output that does not break existing consumers;
- new gate/status helpers that existing loopflows can ignore.

Example: `0.1.3 -> 0.2.0`.

## MAJOR: `x.0.0`

Use a major release for breaking changes:

- changing or removing existing loopflow JSON fields;
- changing template variable semantics;
- changing gate status behavior in a way existing loopflows may interpret differently;
- removing commands, tools, bundled loopflows, or adapter behavior;
- changing artifact paths or output shape in a way scripts may depend on.

Example: `1.4.2 -> 2.0.0`.

## Release checklist

1. Update `package.json` with `npm version <patch|minor|major> --no-git-tag-version`.
2. Update `CHANGELOG.md` under the new version.
3. Run:

   ```bash
   npm run validate
   npm run typecheck
   npm run pack:check
   ```

4. Commit with a clear release-prep message.
5. Tag the version: `git tag vX.Y.Z`.
6. Push `main` and the tag.
7. Publish to npm:

   ```bash
   npm publish --access public
   ```

8. Create a GitHub release for the tag.
9. Install the published package and validate it:

   ```bash
   pi remove npm:pi-loopflows || true
   pi install npm:pi-loopflows@X.Y.Z
   node ~/.pi/agent/npm/node_modules/pi-loopflows/scripts/validate.mjs
   ```
