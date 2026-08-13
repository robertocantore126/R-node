/// <reference types="vite/client" />

/** `?raw` imports: the HTML export inlines the prebuilt viewer bundle as text. */
declare module "*?raw" {
  const content: string;
  export default content;
}
