/** think-aloud's state contract: what its hooks keep in $.state. */

/** Whether a line plays (the ⏮ ⏭ row shows), and the thought being spoken, "Name: words" (the amber band; '' else). */
export type Saying = { playing: boolean; thought: string }
/** The start of the reply text being spoken now, '' for none: the transcript block holding it is lit. */
export type Lit = string

declare module 'claude-code' {
  interface PluginState {
    'think-aloud': { saying: Saying; lit: Lit; step: Lit }
  }
}
