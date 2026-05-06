/**
 * Vite's `?raw` query string makes any asset import resolve to its raw
 * text contents at build time. We use it to inline Game Icons SVGs so
 * they can be dynamically tinted (see `icons.ts`).
 */
declare module '*.svg?raw' {
  const content: string;
  export default content;
}
