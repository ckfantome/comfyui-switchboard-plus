# 🎛️ Switchboard+ - v1.2.0

First release of this fork ([Attribution](README.md#attribution)). Based on
upstream v1.1.7.

## ✨ New: Execution Gate backend node
Blocks every node downstream (e.g. Save Image) when a boolean **computed at
runtime** by another node is False - the one case the Group/Node Controllers
can't handle, since their mode toggle happens before the prompt runs and can
only read a constant. Uses ComfyUI's `ExecutionBlocker`. See the README's
[Execution Gate](README.md#execution-gate) section.

## 🔒 Hardened release workflow
`.github/workflows/release.yml`:
- Removed the Comfy-Registry `publish-node` job. It published under the
  upstream author's `PublisherId` ("oratorian") using
  `Comfy-Org/publish-node-action@main` - a mutable ref, not pinned to a commit
  - combined with a `secrets.REGISTRY_ACCESS_TOKEN` and a blanket
  `contents: write` permission inherited from the top level. This fork has no
  claim to that registry namespace and no token for it, and the pattern itself
  is a supply-chain risk worth avoiding: a third-party action pinned to `@main`
  runs whatever is on that branch *at execution time*, with full access to
  whatever permissions and secrets the job holds.
- Replaced the top-level `permissions: contents: write` with `permissions: {}`
  at the workflow level and an explicit `contents: write` only on the job that
  actually creates the GitHub release.

## 📦 Renamed package
`comfyui-switchboard` -> `comfyui-switchboard-plus`, so this fork's folder name
and Comfy Registry listing (if ever published) don't collide with upstream's.

-# Install fresh via `git clone` into `custom_nodes/comfyui-switchboard-plus`,
-# or `git pull` there to update. No new dependencies.

# 🎛️ Switchboard - v1.1.7

## 🐛 Fix: Group Controller in a subgraph you haven't opened
The Group Controller found its target group **empty** whenever the graph it lives in was not the one on screen, so a Controller inside a subgraph silently changed nothing unless you had entered that subgraph; queue time included. litegraph works group membership out from render-time bounding rects, which read as all-zero for nodes that were never drawn. Membership is now derived from each node's position and size, which are always valid, using the same centre-inside-group rule.

## 🔧 Backend nodes ported to the V3 node schema
**Value on Boolean** and **Boolean Switch** now use `comfy_api.latest` (`io.Schema` / `ComfyExtension`) instead of the legacy `NODE_CLASS_MAPPINGS` shape. Node ids, socket names and socket types are unchanged, so existing workflows load exactly as before. The hand-rolled `*` wildcard type is replaced by the sanctioned `io.AnyType`.

> Needs a ComfyUI recent enough to ship the V3 node API (`comfy_api.latest`). The Controllers are unaffected either way.

-# Update via ComfyUI Manager, or `git pull` in `custom_nodes/comfyui-switchboard` and restart. No new dependencies.

# 🎛️ Switchboard - v1.1.6

## 🐛 Fix: Promoted subgraph booleans control targets again
A recent ComfyUI change stopped **promoted widgets** from writing their value back down into the node they were promoted from. A Controller wired to, say, a `PrimitiveBoolean` inside a subgraph therefore kept reading that node's now-permanently-stale local value, and the toggle on the subgraph node did nothing.

Boolean resolution now follows the wire instead of trusting a stale value:

- A widget whose slot has an **incoming link** is skipped; the link is followed to whatever actually drives it.
- When the matching input on the subgraph node carries **no link**, the **promoted widget** on that node is read directly.
- A **subgraph instance** is descended into *before* reading a widget off it, so an unrelated promoted boolean can no longer be picked up for the output that was actually tapped.

Applies to the **Group Controller**, the **Node Controller** and the **Wired Controller** alike; they all share one resolver.

-# Update via ComfyUI Manager, or `git pull` in `custom_nodes/comfyui-switchboard` and restart. No new dependencies.
