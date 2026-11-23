/** think-aloud's state contract: what its hooks keep in $.state. */

/** A line is playing: the ⏭ row above the prompt shows. */
export type Speaking = boolean
/** What is lit while spoken: a reply block by the start of its text, a thought's tool rows by its step ('' for none). */
export type Lit = { probe: string; step: string }

declare module 'claude-code' {
  interface PluginState {
    'think-aloud': { speaking: Speaking; lit: Lit }
  }
}
