/** Let the browser paint and handle input between batches of promise work. */
export function yieldToMain(ms = 0) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
