/**
 * The stylesheet is a build input, not a module with a value. Vite emits it as
 * one same-origin file, which is what `style-src 'self'` requires.
 */
declare module "*.css";
