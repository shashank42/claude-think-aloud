/** think-aloud's state contract: what its hooks keep in $.state. */

/** A line is playing: the ⏭ row above the prompt shows. */
export type Speaking = boolean

declare module 'claude-code' {
  interface PluginState {
    'think-aloud': { speaking: Speaking }
  }
}
