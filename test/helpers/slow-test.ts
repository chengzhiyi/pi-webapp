/** Long soak and timeout tests run in `npm test` and CI; `npm run test:quick` skips them. */
export const slowTest = { skip: process.env.PI_WEB_TEST_QUICK === "1" ? "slow; run npm test for full coverage" : false } as const;
