/** think-aloud's state contract: what its hooks keep in $.state. */

/** A line is playing: the ⏭ row above the prompt shows. */
export type Speaking = boolean
/** The start of the reply text being spoken now, '' for none: the transcript block holding it is lit. */
export type Lit = string

declare module 'claude-code' {
  interface PluginState {
    'think-aloud': { speaking: Speaking; lit: Lit }
  }
}
