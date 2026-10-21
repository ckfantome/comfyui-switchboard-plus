# Security Policy

Switchboard+ is a small ComfyUI custom node pack: three front-end (virtual)
LiteGraph nodes and three backend Python nodes, none of which touch the
filesystem, the network, or shell/subprocess execution, and none of which
`eval`/`exec` graph data. The main trust boundary is a ComfyUI **workflow
file** - treat workflow JSON from an untrusted source the same way you'd treat
any other untrusted input to a plugin that parses it.

## Reporting a vulnerability

Please open a [GitHub issue](https://github.com/ckfantome/comfyui-switchboard-plus/issues)
or, for anything you'd rather not post publicly first, use GitHub's
[private vulnerability reporting](https://github.com/ckfantome/comfyui-switchboard-plus/security/advisories/new)
on this repository. Include the affected version (`pyproject.toml` ->
`[project].version`) and, if possible, a minimal workflow or diff that
reproduces the issue.

This fork carries changes on top of
[Oratorian/comfyui-switchboard](https://github.com/Oratorian/comfyui-switchboard);
if an issue is clearly present upstream too, please also report it there.

## Scope notes for reviewers

- CI (`.github/workflows/release.yml`) only runs on `workflow_dispatch` and
  pushed `v*` tags - both require write access to this repository - and uses
  per-job least-privilege `permissions:` rather than a blanket grant. There is
  no `pull_request`/`pull_request_target` trigger and no job that runs
  external contributor code with secrets.
- Third-party GitHub Actions used in CI should be pinned to a full commit SHA,
  not a branch or tag, before any job that holds a secret or `write`
  permission is allowed to depend on them.
