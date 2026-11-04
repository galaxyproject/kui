/// <reference types="astro/client" />

declare module '*.yml?raw' {
  const contents: string;
  export default contents;
}
