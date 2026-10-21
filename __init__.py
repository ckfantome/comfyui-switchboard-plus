"""Switchboard+ - advanced group/node controllers + boolean utilities for ComfyUI.

Fork of https://github.com/Oratorian/comfyui-switchboard (GPL-3.0); see
README.md#attribution for what this fork changes.

Two kinds of nodes ship here:

- **Group Controller / Node Controller / Tag Controller / Wired Controller /
  Set / Get** - client-side ("virtual") LiteGraph nodes in
  ``js/switchboard.js``. They never execute on the server. The four
  Controllers toggle node modes (active/bypass/mute); Tag Controller targets
  any set of nodes sharing a ``properties.switchboardTags`` label, not just
  one group or node id. Set/Get instead tunnel any-type *data* by name (no
  wire), resolving to the real upstream link at queue time.
- **Value on Boolean / Boolean Switch / Execution Gate** - real backend nodes
  in ``nodes.py`` that move data (or block it) at runtime, so users get
  boolean->value, conditional routing, and runtime-computed gating without
  needing a separate custom-node pack.

The backend nodes use the V3 schema, so ComfyUI loads them through
``comfy_entrypoint`` rather than ``NODE_CLASS_MAPPINGS``. Don't re-export the
old mappings alongside it: ComfyUI checks for them first and would then ignore
the V3 entrypoint entirely.
"""

from .nodes import comfy_entrypoint

# Tell ComfyUI where to find the front-end extension(s). Read for V1 and V3
# alike, so the Controllers keep loading.
WEB_DIRECTORY = "./js"

__all__ = ["comfy_entrypoint", "WEB_DIRECTORY"]
