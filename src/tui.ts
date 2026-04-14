import type { TuiPlugin } from "@opencode-ai/plugin/tui"
import { id } from "./plugin-id.js"

export const OmniOpencodeTuiPlugin: TuiPlugin = async () => {
  // The package needs a TUI entry so OpenCode can surface it in the External plugin manager.
}

export default {
  id,
  tui: OmniOpencodeTuiPlugin,
}

export const tui = OmniOpencodeTuiPlugin
