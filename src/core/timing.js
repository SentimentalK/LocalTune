/** Let the browser paint and handle input between batches of promise work. */
export function yieldToMain() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
