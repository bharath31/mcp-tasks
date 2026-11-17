/** Test-only stub — Browser Run is never invoked when harness injects fake agent ports. */
export default {
  async launch(): Promise<never> {
    throw new Error("browser_run_unavailable_in_tests");
  },
};
