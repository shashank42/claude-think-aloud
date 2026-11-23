/** think-aloud's state contract: what its hooks keep in $.state. */

/** What is being said now, "Name: words" ('' when quiet): the amber band above the prompt. */
export type Saying = string
/** The start of the reply text being spoken now, '' for none: the transcript block holding it is lit. */
export type Lit = string

declare module 'claude-code' {
  interface PluginState {
    'think-aloud': { saying: Saying; lit: Lit }
  }
}
